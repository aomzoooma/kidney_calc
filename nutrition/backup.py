"""Encrypted logical export for marked synthetic-only SQLite databases.

Restore is intentionally unavailable until private staging and Windows ACL
behavior can be validated.
"""

from __future__ import annotations

import os
import secrets
import sqlite3
import tempfile
import time
from contextlib import closing
from io import BytesIO
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt


_MAGIC = b"KCBK\x01"
_SALT_SIZE = 16
_NONCE_SIZE = 12
_KEY_SIZE = 32
_MAX_DB_BYTES = 16 * 1024 * 1024
_MAX_DUMP_BYTES = 64 * 1024 * 1024
_SQLITE_BUSY = 5
_SQLITE_LOCKED = 6
_REQUIRED_COLUMNS = {
    "experimental_demo_marker": {"marker"},
    "ingredients": {"id", "name"},
    "ingredient_versions": {
        "id", "ingredient_id", "version", "provider", "source_version",
        "source_date", "retrieved_on", "source_reference", "provenance",
        "basis_quantity", "basis_unit", "food_state", "reviewed",
        "energy_kcal", "protein_g", "sodium_mg", "potassium_mg", "phosphorus_mg",
    },
    "seasoning_brands": {"ingredient_id", "brand"},
}
_OPTIONAL_COLUMNS = {
    "patient_profiles": {"id", "name"},
    "dry_weights": {"id", "profile_id", "measured_on", "kilograms"},
    "clinician_goals": {"id", "profile_id", "nutrient", "amount", "unit", "effective_on", "confirmed_by"},
    "recipes": {"id", "name", "favorite"},
    "recipe_ingredients": {"recipe_id", "position", "ingredient_version_id", "amount", "unit", "food_state"},
    "recent_recipe_opens": {"open_order", "recipe_id", "opened_at"},
    "meal_entries": {"id", "profile_id", "recipe_id", "recipe_name", "consumed_at_utc", "local_date", "portion"},
    "meal_entry_ingredients": {"meal_entry_id", "position", "ingredient_version_id", "ingredient_name", "amount", "unit", "food_state", "version", "provider", "source_version", "source_date", "retrieved_on", "source_reference", "provenance", "basis_quantity", "basis_unit", "source_food_state", "reviewed", "energy_kcal", "protein_g", "sodium_mg", "potassium_mg", "phosphorus_mg"},
    "meal_entry_goals": {"meal_entry_id", "position", "goal_id", "nutrient", "amount", "unit", "effective_on", "confirmed_by"},
    "meal_entry_totals": {"meal_entry_id", "nutrient", "subtotal", "complete"},
    "meal_entry_seals": {"meal_entry_id", "sealed_at"},
    "meal_entry_adjustments": {"meal_entry_id", "action", "replacement_entry_id", "reason", "recorded_at"},
}


def _passphrase_bytes(passphrase: str) -> bytes:
    if not isinstance(passphrase, str) or not passphrase:
        raise ValueError("passphrase must be non-empty text")
    encoded = passphrase.encode("utf-8")
    if len(encoded) > 1024:
        raise ValueError("passphrase is too long")
    return encoded


def _key(passphrase: bytes, salt: bytes) -> bytes:
    return Scrypt(salt=salt, length=_KEY_SIZE, n=2**15, r=8, p=1).derive(passphrase)


def _validate_snapshot(db: sqlite3.Connection) -> None:
    if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise ValueError("database failed integrity check")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("database has invalid foreign keys")
    tables = {
        row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    }
    known = set(_REQUIRED_COLUMNS) | set(_OPTIONAL_COLUMNS)
    if not set(_REQUIRED_COLUMNS).issubset(tables) or tables - known:
        raise ValueError("database schema is unsupported")
    for table in tables:
        expected = _REQUIRED_COLUMNS.get(table, _OPTIONAL_COLUMNS.get(table))
        escaped = table.replace('"', '""')
        columns = db.execute(f'PRAGMA table_xinfo("{escaped}")').fetchall()
        actual = {row[1] for row in columns}
        if (expected is None or expected != actual
                or any(row[6] != 0 for row in columns)):
            raise ValueError("database schema is unsupported")
        for column in expected:
            escaped_column = column.replace('"', '""')
            has_nul_text = db.execute(
                f'''SELECT 1 FROM "{escaped}" WHERE typeof("{escaped_column}") = 'text'
                    AND instr("{escaped_column}", char(0)) > 0 LIMIT 1'''
            ).fetchone()
            if has_nul_text:
                raise ValueError("database contains text that SQLite logical export cannot preserve")
    marker = db.execute("SELECT marker FROM experimental_demo_marker").fetchall()
    if marker != [("synthetic-only-v1",)]:
        raise ValueError("database is not marked synthetic-only")


def create_backup(database: str | Path, backup: str | Path, passphrase: str) -> None:
    """Create encrypted logical export; marker is an assertion, not proof of synthetic data."""
    passphrase_bytes = _passphrase_bytes(passphrase)
    source, target = Path(database), Path(backup)
    if source.resolve() == target.resolve():
        raise ValueError("backup path must differ from database path")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary_name = None
    try:
        with closing(sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True)) as src:
            page_size = src.execute("PRAGMA page_size").fetchone()[0]
            page_count = src.execute("PRAGMA page_count").fetchone()[0]
            if page_size * page_count > _MAX_DB_BYTES:
                raise ValueError("database exceeds backup size limit")
            with closing(sqlite3.connect(":memory:")) as snapshot:
                snapshot.execute("PRAGMA temp_store=MEMORY")
                if snapshot.execute("PRAGMA temp_store").fetchone() != (2,):
                    raise RuntimeError("SQLite cannot keep temporary backup data in memory")
                deadline = time.monotonic() + 5

                def check_backup_status(status, _remaining, total):
                    if time.monotonic() > deadline or status in (_SQLITE_BUSY, _SQLITE_LOCKED):
                        raise TimeoutError("database is busy; retry backup")
                    if total * page_size > _MAX_DB_BYTES:
                        raise ValueError("database exceeds backup size limit")

                src.execute("PRAGMA busy_timeout=5000")
                src.backup(snapshot, pages=64, progress=check_backup_status, sleep=0.05)
                snapshot_size = snapshot.execute("PRAGMA page_size").fetchone()[0] * snapshot.execute(
                    "PRAGMA page_count"
                ).fetchone()[0]
                if snapshot_size > _MAX_DB_BYTES:
                    raise ValueError("database exceeds backup size limit")
                _validate_snapshot(snapshot)
                dump = BytesIO()
                for statement in snapshot.iterdump():
                    encoded = (statement + "\n").encode("utf-8")
                    if dump.tell() + len(encoded) > _MAX_DUMP_BYTES:
                        raise ValueError("database export exceeds size limit")
                    dump.write(encoded)
                plaintext = dump.getvalue()

        salt, nonce = secrets.token_bytes(_SALT_SIZE), secrets.token_bytes(_NONCE_SIZE)
        header = _MAGIC + salt + nonce
        encrypted = AESGCM(_key(passphrase_bytes, salt)).encrypt(nonce, plaintext, header)
        with tempfile.NamedTemporaryFile(prefix=".kidney-backup-", dir=target.parent, delete=False) as tmp:
            temporary_name = tmp.name
            if os.name != "nt":
                os.chmod(temporary_name, 0o600)
            tmp.write(header + encrypted)
            tmp.flush()
            os.fsync(tmp.fileno())
        try:
            os.link(temporary_name, target)
        except FileExistsError as exc:
            raise ValueError("backup destination already exists; existing file preserved") from exc
        os.unlink(temporary_name)
        temporary_name = None
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
