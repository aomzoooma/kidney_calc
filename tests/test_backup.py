import sqlite3
import tempfile
import unittest
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from nutrition.backup import _MAGIC, _NONCE_SIZE, _SALT_SIZE, _key, create_backup
from nutrition.ingredients import IngredientStore
from nutrition.recipes import RecipeStore
from nutrition.seasonings import SeasoningStore


def _synthetic_database(path):
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE experimental_demo_marker (marker TEXT NOT NULL)")
        db.execute("INSERT INTO experimental_demo_marker VALUES ('synthetic-only-v1')")
    IngredientStore(path)
    SeasoningStore(path)
    RecipeStore(path)


def _decrypt_for_test(path, passphrase):
    blob = path.read_bytes()
    header_size = len(_MAGIC) + _SALT_SIZE + _NONCE_SIZE
    header = blob[:header_size]
    salt = header[len(_MAGIC):len(_MAGIC) + _SALT_SIZE]
    nonce = header[-_NONCE_SIZE:]
    return AESGCM(_key(passphrase.encode(), salt)).decrypt(nonce, blob[header_size:], header)


class EncryptedExportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / "synthetic.sqlite"
        _synthetic_database(self.database)
        self.backup = self.root / "backup.kcb"

    def tearDown(self):
        self.temp.cleanup()

    def test_export_is_authenticated_encrypted_and_logical_dump_round_trips(self):
        with sqlite3.connect(self.database) as db:
            ingredient_id = db.execute(
                "INSERT INTO ingredients(name) VALUES (?)", ("synthetic ชา",)
            ).lastrowid
            db.execute(
                """INSERT INTO ingredient_versions
                   (ingredient_id, version, provider, source_version, retrieved_on, source_reference,
                    provenance, basis_quantity, basis_unit, food_state, reviewed, energy_kcal)
                   VALUES (?, '1', 'synthetic', 'test', '2026-11-03', 'synthetic://food',
                           'test', '100', 'g', 'raw', 1, ?)""",
                (ingredient_id, sqlite3.Binary(b"\x00\xff")),
            )
            db.execute("CREATE INDEX synthetic_name_idx ON ingredients(name)")
            db.execute("CREATE VIEW synthetic_names AS SELECT name FROM ingredients")
            db.execute("CREATE TRIGGER synthetic_insert AFTER INSERT ON ingredients BEGIN SELECT 1; END")
            recipe_id = db.execute("INSERT INTO recipes(name) VALUES ('synthetic recipe')").lastrowid
            db.execute(
                "INSERT INTO recent_recipe_opens(recipe_id, opened_at) VALUES (?, '2026-11-03T00:00:00Z')",
                (recipe_id,),
            )

        create_backup(self.database, self.backup, "synthetic test passphrase")
        encrypted = self.backup.read_bytes()
        self.assertTrue(encrypted.startswith(_MAGIC))
        self.assertNotIn(b"synthetic-only-v1", encrypted)
        self.assertNotIn("synthetic ชา".encode(), encrypted)
        self.assertEqual({path.name for path in self.root.iterdir()}, {"synthetic.sqlite", "backup.kcb"})

        dump = _decrypt_for_test(self.backup, "synthetic test passphrase")
        restored = sqlite3.connect(":memory:")
        try:
            restored.executescript(dump.decode("utf-8"))
            self.assertEqual(
                restored.execute("SELECT name FROM ingredients WHERE name LIKE 'synthetic %'").fetchone(),
                ("synthetic ชา",),
            )
            self.assertEqual(
                restored.execute("SELECT energy_kcal FROM ingredient_versions WHERE id=1").fetchone(),
                (b"\x00\xff",),
            )
            self.assertEqual(
                restored.execute("SELECT source_date FROM ingredient_versions WHERE id=1").fetchone(),
                (None,),
            )
            self.assertEqual(
                restored.execute("SELECT name FROM synthetic_names WHERE name = 'synthetic ชา'").fetchone(),
                ("synthetic ชา",),
            )
            self.assertEqual(
                restored.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='synthetic_name_idx'").fetchone(),
                ("synthetic_name_idx",),
            )
            self.assertEqual(
                restored.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name='synthetic_insert'").fetchone(),
                ("synthetic_insert",),
            )
            self.assertEqual(
                restored.execute("SELECT seq FROM sqlite_sequence WHERE name='recent_recipe_opens'").fetchone(),
                (1,),
            )
        finally:
            restored.close()

    def test_wal_committed_rows_are_in_consistent_snapshot(self):
        db = sqlite3.connect(self.database)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("INSERT INTO ingredients(name) VALUES ('synthetic WAL row')")
            db.commit()
            wal = Path(f"{self.database}-wal")
            self.assertGreater(wal.stat().st_size, 0)
            create_backup(self.database, self.backup, "passphrase")
            dump = _decrypt_for_test(self.backup, "passphrase").decode("utf-8")
            self.assertIn("synthetic WAL row", dump)
        finally:
            db.close()

    def test_wrong_password_and_tampering_fail_authentication(self):
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO ingredients(name) VALUES ('synthetic only')")
        create_backup(self.database, self.backup, "correct horse")
        with self.assertRaises(InvalidTag):
            _decrypt_for_test(self.backup, "wrong password")
        damaged = bytearray(self.backup.read_bytes())
        damaged[-1] ^= 1
        self.backup.write_bytes(damaged)
        with self.assertRaises(InvalidTag):
            _decrypt_for_test(self.backup, "correct horse")

    def test_refuses_existing_destination_without_changing_it(self):
        self.backup.write_bytes(b"preserve")
        with self.assertRaisesRegex(ValueError, "destination already exists"):
            create_backup(self.database, self.backup, "passphrase")
        self.assertEqual(self.backup.read_bytes(), b"preserve")

    def test_rejects_unmarked_and_unknown_schema_databases(self):
        unrelated = self.root / "unrelated.sqlite"
        with sqlite3.connect(unrelated) as db:
            db.execute("CREATE TABLE records (value TEXT)")
        with self.assertRaisesRegex(ValueError, "schema is unsupported"):
            create_backup(unrelated, self.backup, "passphrase")

        invalid = self.root / "invalid.sqlite"
        with sqlite3.connect(invalid) as db:
            db.execute("CREATE TABLE experimental_demo_marker (marker TEXT NOT NULL)")
            db.execute("INSERT INTO experimental_demo_marker VALUES ('not synthetic-only-v1')")
        IngredientStore(invalid)
        SeasoningStore(invalid)
        with self.assertRaisesRegex(ValueError, "not marked synthetic-only"):
            create_backup(invalid, self.backup, "passphrase")

    def test_rejects_changed_current_schema(self):
        with sqlite3.connect(self.database) as db:
            db.execute("ALTER TABLE ingredients ADD COLUMN unexpected TEXT")
        with self.assertRaisesRegex(ValueError, "schema is unsupported"):
            create_backup(self.database, self.backup, "passphrase")

    def test_rejects_text_with_embedded_nul_instead_of_truncating_it(self):
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO ingredients(name) VALUES (?)", ("before\0after",))
        with self.assertRaisesRegex(ValueError, "logical export cannot preserve"):
            create_backup(self.database, self.backup, "passphrase")
        self.assertFalse(self.backup.exists())

    def test_rejects_text_with_embedded_nul_in_numeric_affinity_column(self):
        from nutrition.profiles import ProfileStore

        profile_id = ProfileStore(self.database).create_profile("synthetic profile")
        with sqlite3.connect(self.database) as db:
            db.execute(
                """INSERT INTO clinician_goals
                   (profile_id, nutrient, amount, unit, effective_on, confirmed_by)
                   VALUES (?, 'protein', ?, 'g/day', '2026-11-03', 'synthetic')""",
                (profile_id, "before\0after"),
            )
        with self.assertRaisesRegex(ValueError, "logical export cannot preserve"):
            create_backup(self.database, self.backup, "passphrase")
        self.assertFalse(self.backup.exists())

    def test_rejects_generated_columns(self):
        with sqlite3.connect(self.database) as db:
            db.execute(
                "ALTER TABLE ingredients ADD COLUMN generated_name TEXT GENERATED ALWAYS AS (name) VIRTUAL"
            )
        with self.assertRaisesRegex(ValueError, "schema is unsupported"):
            create_backup(self.database, self.backup, "passphrase")


if __name__ == "__main__":
    unittest.main()
