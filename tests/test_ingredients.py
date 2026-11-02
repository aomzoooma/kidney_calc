"""Synthetic-data tests for manual ingredient source snapshots."""

import sqlite3
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from nutrition.ingredients import IngredientStore


class IngredientStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "synthetic.sqlite"
        self.store = IngredientStore(self.database)

    def tearDown(self):
        self.temp_dir.cleanup()

    def add(self, ingredient_id, version, nutrients):
        return self.store.add_version(
            ingredient_id, version=version, provider="Synthetic source",
            source_version="edition-test", source_date="2026-10-01", retrieved_on="2026-11-01",
            source_reference="synthetic://record/1", provenance="manual synthetic entry",
            basis_quantity=Decimal("100"), basis_unit="g", food_state="raw", reviewed=True,
            nutrients=nutrients,
        )

    def test_preserves_unknown_zero_basis_and_version_history(self):
        ingredient_id = self.store.create_ingredient("Synthetic bean")
        self.add(ingredient_id, "1", {"sodium_mg": Decimal("0")})
        self.add(ingredient_id, "2", {"sodium_mg": Decimal("12.5")})

        record = IngredientStore(self.database).get_ingredient(ingredient_id)
        self.assertEqual(record["name"], "Synthetic bean")
        self.assertEqual(len(record["versions"]), 2)
        first, second = record["versions"]
        self.assertEqual(first["sodium_mg"], Decimal("0"))
        self.assertIsNone(first["potassium_mg"])
        self.assertEqual(first["basis_quantity"], Decimal("100"))
        self.assertEqual(second["sodium_mg"], Decimal("12.5"))
        self.assertEqual(first["provider"], "Synthetic source")
        self.assertEqual(first["retrieved_on"], "2026-11-01")
        self.assertTrue(first["reviewed"])

    def test_versions_are_append_only(self):
        ingredient_id = self.store.create_ingredient("Synthetic rice")
        version_id = self.add(ingredient_id, "1", {})
        with sqlite3.connect(self.database) as db:
            with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                db.execute("UPDATE ingredient_versions SET reviewed = 0 WHERE id = ?", (version_id,))
            with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                db.execute("DELETE FROM ingredient_versions WHERE id = ?", (version_id,))
            with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                db.execute(
                    "INSERT OR REPLACE INTO ingredient_versions "
                    "(id, ingredient_id, version, provider, source_version, retrieved_on, "
                    "source_reference, provenance, basis_quantity, basis_unit, food_state, reviewed) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (version_id, ingredient_id, "1", "P", "V", "2026-01-01", "ref", "manual", "100", "g", "raw", 0),
                )
            with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                db.execute(
                    "INSERT OR REPLACE INTO ingredient_versions "
                    "(id, ingredient_id, version, provider, source_version, retrieved_on, "
                    "source_reference, provenance, basis_quantity, basis_unit, food_state, reviewed) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (version_id + 99, ingredient_id, "1", "P", "V", "2026-01-01", "ref", "manual", "100", "g", "raw", 0),
                )
        with self.assertRaises(sqlite3.IntegrityError):
            self.add(ingredient_id, "1", {})
        self.add(ingredient_id, "2", {})
        self.assertEqual(len(self.store.get_ingredient(ingredient_id)["versions"]), 2)

    def test_ingredient_identity_cannot_change_after_source_is_recorded(self):
        ingredient_id = self.store.create_ingredient("Synthetic lentil")
        self.add(ingredient_id, "1", {})
        with sqlite3.connect(self.database) as db:
            with self.assertRaisesRegex(sqlite3.IntegrityError, "identities are immutable"):
                db.execute("UPDATE ingredients SET name = ? WHERE id = ?", ("Renamed item", ingredient_id))
            with self.assertRaisesRegex(sqlite3.IntegrityError, "identities are immutable"):
                db.execute("DELETE FROM ingredients WHERE id = ?", (ingredient_id,))
            with self.assertRaisesRegex(sqlite3.IntegrityError, "identities are immutable"):
                db.execute("INSERT OR REPLACE INTO ingredients(id, name) VALUES (?, ?)",
                           (ingredient_id, "Replaced item"))
        record = self.store.get_ingredient(ingredient_id)
        self.assertEqual(record["name"], "Synthetic lentil")
        self.assertEqual(record["versions"][0]["version"], "1")

    def test_validates_data_and_parameterizes_identity(self):
        name = "synthetic'); DROP TABLE ingredients; --"
        ingredient_id = self.store.create_ingredient(name)
        self.assertEqual(self.store.get_ingredient(ingredient_id)["name"], name)
        invalid = [
            {"retrieved_on": "not-a-date"},
            {"basis_quantity": None},
            {"basis_quantity": Decimal("0")},
            {"basis_quantity": Decimal("NaN")},
            {"basis_unit": "cup"},
            {"food_state": "boiled"},
            {"reviewed": "yes"},
            {"nutrients": {"sodium_mg": -1}},
            {"nutrients": {"unknown_nutrient": Decimal("1")}},
        ]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                kwargs = dict(version="bad", provider="P", source_version="V",
                              retrieved_on="2026-01-01", source_reference="ref", provenance="manual",
                              basis_quantity=Decimal("100"), basis_unit="g", food_state="raw",
                              reviewed=False, nutrients={})
                kwargs.update(changes)
                self.store.add_version(ingredient_id, **kwargs)
        self.assertIsNotNone(self.store.get_ingredient(ingredient_id))

    def test_rejects_ephemeral_database_and_missing_ingredient(self):
        with self.assertRaises(ValueError):
            IngredientStore(":memory:")
        self.assertIsNone(self.store.get_ingredient(98765))


if __name__ == "__main__":
    unittest.main()
