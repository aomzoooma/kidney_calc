"""Local SQLite storage for manually entered, versioned ingredient source records."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from pathlib import Path

from nutrition.calculator import NUTRIENTS


def _text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be non-empty text")
    return value.strip()


def _day(value, field, *, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO date")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO date") from exc


def _decimal(value, field, *, positive=False):
    if value is None:
        if positive:
            raise ValueError(f"{field} must be positive")
        return None
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ValueError(f"{field} must be a finite Decimal")
    if value < 0 or (positive and value == 0):
        raise ValueError(f"{field} must be {'positive' if positive else 'non-negative'}")
    return str(value)


class IngredientStore:
    """SQLite repository; reviewed is a user assertion, not independent verification."""

    def __init__(self, database: str | Path):
        self.database = str(database)
        if self.database == ":memory:" or self.database.startswith("file::memory:") or "mode=memory" in self.database:
            raise ValueError("IngredientStore requires a persistent SQLite database path")
        nutrient_columns = ",\n".join(f'"{nutrient}" TEXT' for nutrient in NUTRIENTS)
        with self._connect() as db:
            db.executescript(f"""
                CREATE TABLE IF NOT EXISTS ingredients (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL CHECK(length(trim(name)) > 0)
                );
                CREATE TABLE IF NOT EXISTS ingredient_versions (
                    id INTEGER PRIMARY KEY,
                    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
                    version TEXT NOT NULL CHECK(length(trim(version)) > 0),
                    provider TEXT NOT NULL CHECK(length(trim(provider)) > 0),
                    source_version TEXT NOT NULL CHECK(length(trim(source_version)) > 0),
                    source_date TEXT,
                    retrieved_on TEXT NOT NULL,
                    source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) > 0),
                    provenance TEXT NOT NULL CHECK(length(trim(provenance)) > 0),
                    basis_quantity TEXT NOT NULL,
                    basis_unit TEXT NOT NULL CHECK(basis_unit IN ('g', 'ml')),
                    food_state TEXT NOT NULL CHECK(food_state IN ('raw', 'cooked', 'as_sold')),
                    reviewed INTEGER NOT NULL CHECK(reviewed IN (0, 1)),
                    {nutrient_columns},
                    UNIQUE(ingredient_id, version)
                );
                CREATE TRIGGER IF NOT EXISTS ingredients_no_replace
                    BEFORE INSERT ON ingredients
                    WHEN EXISTS (SELECT 1 FROM ingredients WHERE id = NEW.id) BEGIN
                    SELECT RAISE(ABORT, 'ingredient identities are immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS ingredients_no_update
                    BEFORE UPDATE ON ingredients BEGIN
                    SELECT RAISE(ABORT, 'ingredient identities are immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS ingredients_no_delete
                    BEFORE DELETE ON ingredients BEGIN
                    SELECT RAISE(ABORT, 'ingredient identities are immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS ingredient_versions_no_update
                    BEFORE UPDATE ON ingredient_versions BEGIN
                    SELECT RAISE(ABORT, 'ingredient versions are immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS ingredient_versions_no_replace
                    BEFORE INSERT ON ingredient_versions
                    WHEN EXISTS (
                        SELECT 1 FROM ingredient_versions
                        WHERE id = NEW.id OR (ingredient_id = NEW.ingredient_id AND version = NEW.version)
                    ) BEGIN
                    SELECT RAISE(ABORT, 'ingredient versions are immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS ingredient_versions_no_delete
                    BEFORE DELETE ON ingredient_versions BEGIN
                    SELECT RAISE(ABORT, 'ingredient versions are immutable');
                END;
            """)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.database)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def create_ingredient(self, name: str) -> int:
        name = _text(name, "name")
        with self._connect() as db:
            cursor = db.execute("INSERT INTO ingredients(name) VALUES (?)", (name,))
            return cursor.lastrowid

    def add_version(self, ingredient_id: int, *, version: str, provider: str,
                    source_version: str, retrieved_on: str, source_reference: str,
                    provenance: str, basis_quantity: Decimal, basis_unit: str,
                    food_state: str, reviewed: bool, source_date: str | None = None,
                    nutrients: dict | None = None) -> int:
        """Append a source snapshot; all nutrients omitted or set to None remain unknown."""
        if isinstance(ingredient_id, bool) or not isinstance(ingredient_id, int) or ingredient_id <= 0:
            raise ValueError("ingredient_id must be a positive integer")
        if type(reviewed) is not bool:
            raise ValueError("reviewed must be a boolean assertion")
        version = _text(version, "version")
        provider = _text(provider, "provider")
        source_version = _text(source_version, "source_version")
        source_date = _day(source_date, "source_date", optional=True)
        retrieved_on = _day(retrieved_on, "retrieved_on")
        source_reference = _text(source_reference, "source_reference")
        provenance = _text(provenance, "provenance")
        basis_quantity = _decimal(basis_quantity, "basis_quantity", positive=True)
        if basis_unit not in ("g", "ml"):
            raise ValueError("basis_unit must be g or ml")
        if food_state not in ("raw", "cooked", "as_sold"):
            raise ValueError("food_state must be raw, cooked, or as_sold")
        nutrients = {} if nutrients is None else nutrients
        if not isinstance(nutrients, dict) or set(nutrients) - set(NUTRIENTS):
            raise ValueError("nutrients must map supported nutrient names to Decimal or None")
        nutrient_values = [_decimal(nutrients.get(key), key) for key in NUTRIENTS]
        columns = ", ".join(f'"{key}"' for key in NUTRIENTS)
        placeholders = ", ".join("?" for _ in NUTRIENTS)
        with self._connect() as db:
            cursor = db.execute(
                f"""INSERT INTO ingredient_versions
                    (ingredient_id, version, provider, source_version, source_date, retrieved_on,
                     source_reference, provenance, basis_quantity, basis_unit, food_state, reviewed,
                     {columns})
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, {placeholders})""",
                (ingredient_id, version, provider, source_version, source_date, retrieved_on,
                 source_reference, provenance, basis_quantity, basis_unit, food_state, int(reviewed),
                 *nutrient_values),
            )
            return cursor.lastrowid

    def create_reviewed(self, *, name: str, provider: str, version: str,
                        source_version: str, retrieved_on: str, source_reference: str,
                        provenance: str, basis_quantity: Decimal, basis_unit: str,
                        food_state: str, reviewed: bool, source_date: str | None = None,
                        nutrients: dict | None = None,
                        idempotency_key: str | None = None) -> dict:
        """Create one reviewed ingredient and its first immutable source snapshot atomically."""
        if reviewed is not True:
            raise ValueError("User review is required")
        name = _text(name, "name")
        version = _text(version, "version")
        provider = _text(provider, "provider")
        source_version = _text(source_version, "source_version")
        source_date = _day(source_date, "source_date", optional=True)
        retrieved_on = _day(retrieved_on, "retrieved_on")
        source_reference = _text(source_reference, "source_reference")
        provenance = _text(provenance, "provenance")
        basis_quantity = _decimal(basis_quantity, "basis_quantity", positive=True)
        if basis_unit not in ("g", "ml"):
            raise ValueError("basis_unit must be g or ml")
        if food_state not in ("raw", "cooked", "as_sold"):
            raise ValueError("food_state must be raw, cooked, or as_sold")
        nutrients = {} if nutrients is None else nutrients
        if not isinstance(nutrients, dict) or set(nutrients) - set(NUTRIENTS):
            raise ValueError("nutrients must map supported nutrient names to Decimal or None")
        nutrient_values = [_decimal(nutrients.get(key), key) for key in NUTRIENTS]
        columns = ", ".join(f'"{key}"' for key in NUTRIENTS)
        placeholders = ", ".join("?" for _ in NUTRIENTS)
        with self._connect() as db:
            if idempotency_key is not None:
                idempotency_key = _text(idempotency_key, "idempotency_key")
                # Serialize lookup+insert so retried or concurrent POSTs cannot
                # create duplicate immutable snapshots.
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute(
                    """SELECT i.id AS ingredient_id, v.id AS version_id,
                              i.name, v.provider, v.version, v.source_version,
                              v.source_date, v.retrieved_on, v.source_reference,
                              v.provenance, v.basis_quantity, v.basis_unit,
                              v.food_state, v.reviewed,
                              """ + ", ".join(f'v."{key}"' for key in NUTRIENTS) +
                    """ FROM ingredients i JOIN ingredient_versions v ON v.ingredient_id = i.id
                        WHERE v.source_reference = ? AND v.version = ?""",
                    (idempotency_key, version),
                ).fetchone()
                if existing is not None:
                    expected = (name, provider, source_version, source_date,
                                idempotency_key, provenance, str(basis_quantity), basis_unit,
                                food_state, 1, *nutrient_values)
                    actual = (existing["name"], existing["provider"], existing["source_version"],
                              existing["source_date"],
                              existing["source_reference"], existing["provenance"],
                              existing["basis_quantity"], existing["basis_unit"],
                              existing["food_state"], existing["reviewed"],
                              *(existing[key] for key in NUTRIENTS))
                    if actual != expected:
                        raise ValueError("idempotency key conflicts with an existing snapshot")
                    return {"ingredient_id": existing["ingredient_id"],
                            "version_id": existing["version_id"],
                            "retrieved_on": existing["retrieved_on"]}
            ingredient_id = db.execute(
                "INSERT INTO ingredients(name) VALUES (?)", (name,)
            ).lastrowid
            version_id = db.execute(
                f"""INSERT INTO ingredient_versions
                    (ingredient_id, version, provider, source_version, source_date, retrieved_on,
                     source_reference, provenance, basis_quantity, basis_unit, food_state, reviewed,
                     {columns})
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, {placeholders})""",
                (ingredient_id, version, provider, source_version, source_date, retrieved_on,
                 source_reference, provenance, basis_quantity, basis_unit, food_state, 1,
                 *nutrient_values),
            ).lastrowid
        return {"ingredient_id": ingredient_id, "version_id": version_id,
                "retrieved_on": retrieved_on}

    def get_ingredient(self, ingredient_id: int) -> dict | None:
        """Return source snapshots in insertion order; callers must validate units before calculation."""
        if isinstance(ingredient_id, bool) or not isinstance(ingredient_id, int) or ingredient_id <= 0:
            raise ValueError("ingredient_id must be a positive integer")
        with self._connect() as db:
            ingredient = db.execute(
                "SELECT id, name FROM ingredients WHERE id = ?", (ingredient_id,)
            ).fetchone()
            if ingredient is None:
                return None
            rows = db.execute(
                "SELECT * FROM ingredient_versions WHERE ingredient_id = ? ORDER BY id",
                (ingredient_id,),
            ).fetchall()
            versions = []
            for row in rows:
                item = dict(row)
                item["reviewed"] = bool(item["reviewed"])
                item["basis_quantity"] = Decimal(item["basis_quantity"])
                for nutrient in NUTRIENTS:
                    item[nutrient] = Decimal(item[nutrient]) if item[nutrient] is not None else None
                versions.append(item)
            return {"id": ingredient["id"], "name": ingredient["name"], "versions": versions}

    def search_reviewed(self, query: str, *, limit: int = 50) -> list[dict]:
        """Search only locally saved, user-marked-reviewed source versions."""
        query = _text(query, "query")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        with self._connect() as db:
            rows = db.execute("""SELECT i.id AS ingredient_id, i.name, v.id AS version_id,
                v.version, v.provider, v.source_version, v.source_date, v.retrieved_on,
                v.source_reference, v.provenance, v.basis_quantity, v.basis_unit,
                v.food_state, v.reviewed, b.brand,
                v.energy_kcal, v.protein_g, v.sodium_mg, v.potassium_mg, v.phosphorus_mg
                FROM ingredients i JOIN ingredient_versions v ON v.ingredient_id = i.id
                LEFT JOIN seasoning_brands b ON b.ingredient_id = i.id
                WHERE v.reviewed = 1 AND (i.name LIKE ? ESCAPE '\\' COLLATE NOCASE
                    OR COALESCE(b.brand, '') LIKE ? ESCAPE '\\' COLLATE NOCASE)
                ORDER BY i.name COLLATE NOCASE, v.id DESC LIMIT ?""",
                (f"%{escaped}%", f"%{escaped}%", limit)).fetchall()
        return [{
            "ingredient_id": row["ingredient_id"], "version_id": row["version_id"],
            "name": row["name"], "brand": row["brand"] or None,
            "version": row["version"], "provider": row["provider"],
            "source_version": row["source_version"], "source_date": row["source_date"],
            "retrieved_on": row["retrieved_on"], "source_reference": row["source_reference"],
            "provenance": row["provenance"], "basis_quantity": row["basis_quantity"],
            "basis_unit": row["basis_unit"], "food_state": row["food_state"],
            "reviewed": bool(row["reviewed"]),
            "nutrients": {key: row[key] for key in NUTRIENTS},
        } for row in rows]

    def get_reviewed_version(self, version_id: int) -> dict | None:
        """Resolve one immutable, locally reviewed ingredient version by ID."""
        if isinstance(version_id, bool) or not isinstance(version_id, int) or version_id <= 0:
            raise ValueError("version_id must be a positive integer")
        with self._connect() as db:
            row = db.execute("""SELECT i.id AS ingredient_id, i.name, v.id AS version_id,
                v.version, v.provider, v.source_version, v.source_date, v.retrieved_on,
                v.source_reference, v.provenance, v.basis_quantity, v.basis_unit,
                v.food_state, v.reviewed, v.energy_kcal, v.protein_g, v.sodium_mg,
                v.potassium_mg, v.phosphorus_mg
                FROM ingredients i JOIN ingredient_versions v ON v.ingredient_id = i.id
                WHERE v.id = ? AND v.reviewed = 1""", (version_id,)).fetchone()
        if row is None:
            return None
        return {**dict(row), "reviewed": bool(row["reviewed"]),
                "basis_quantity": Decimal(row["basis_quantity"]),
                "nutrients": {key: Decimal(row[key]) if row[key] is not None else None
                              for key in NUTRIENTS}}
