"""Synthetic integration tests for immutable meal history and local-day totals."""

import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

from nutrition.ingredients import IngredientStore
from nutrition.profiles import ProfileStore
from nutrition.recipes import RecipeStore
from nutrition.tracking import MealTrackingStore


class MealTrackingStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "synthetic.sqlite"
        self.profiles = ProfileStore(self.database)
        self.ingredients = IngredientStore(self.database)
        self.recipes = RecipeStore(self.database)
        self.tracking = MealTrackingStore(self.database)
        self.profile_id = self.profiles.create_profile("Synthetic profile")
        self.version_ids = []
        for name, source_version, values, reviewed in (
            ("Synthetic bean", "source-a", {
                "energy_kcal": Decimal("100"), "protein_g": Decimal("10"), "sodium_mg": Decimal("0"),
            }, True),
            ("Synthetic sauce", "source-b", {
                "sodium_mg": Decimal("4"), "potassium_mg": Decimal("3"),
            }, False),
        ):
            ingredient_id = self.ingredients.create_ingredient(name)
            self.version_ids.append(self.ingredients.add_version(
                ingredient_id, version="1", provider="Synthetic provider", source_version=source_version,
                retrieved_on="2026-01-01", source_reference=f"synthetic://{source_version}",
                provenance="synthetic fixture", basis_quantity=Decimal("100"), basis_unit="g",
                food_state="raw", reviewed=reviewed, nutrients=values,
            ))
        self.recipe_ids = [
            self.recipes.create_recipe(name, [(version_id, Decimal("100"), "g", "raw")])
            for name, version_id in zip(("Synthetic meal A", "Synthetic meal B"), self.version_ids)
        ]

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_consumption_freezes_recipe_source_nutrients_and_effective_goals(self):
        original_goal = self.profiles.add_goal(
            self.profile_id, "sodium_mg", 1800, "mg/day", "2026-01-01", "Synthetic clinician"
        )
        self.profiles.add_goal(
            self.profile_id, "protein_g", 50, "g/day", "2026-01-06", "Synthetic clinician"
        )
        entry_id = self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0],
            datetime(2026, 1, 4, 17, 0, tzinfo=timezone.utc), Decimal("0.5"),
        )

        self.recipes.rename_recipe(self.recipe_ids[0], "Edited meal name")
        self.recipes.replace_ingredients(self.recipe_ids[0], [
            (self.version_ids[1], Decimal("50"), "g", "raw"),
        ])
        self.profiles.add_goal(
            self.profile_id, "sodium_mg", 1600, "mg/day", "2026-01-04", "Later synthetic entry"
        )

        entry = self.tracking.get_entry(entry_id)
        self.assertEqual(entry["recipe_name"], "Synthetic meal A")
        self.assertEqual(entry["local_date"], "2026-01-05")
        self.assertEqual(entry["portion"], Decimal("0.5"))
        self.assertEqual(entry["ingredients"][0]["ingredient_version_id"], self.version_ids[0])
        self.assertEqual(entry["ingredients"][0]["source_version"], "source-a")
        self.assertEqual(entry["ingredients"][0]["protein_g"], Decimal("10"))
        self.assertTrue(entry["ingredients"][0]["reviewed"])
        self.assertEqual(len(entry["goals"]), 1)
        self.assertEqual(entry["goals"][0]["goal_id"], original_goal)
        self.assertEqual(entry["goals"][0]["confirmed_by"], "Synthetic clinician")
        self.assertEqual(entry["totals"]["protein_g"], (Decimal("5.0"), True))
        self.assertEqual(entry["totals"]["sodium_mg"], (Decimal("0.0"), True))

    def test_daily_and_iso_week_totals_use_bangkok_day_and_propagate_unknown(self):
        # 16:59 UTC is 23:59 Sunday in Bangkok; 17:01 UTC is Monday 00:01.
        self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0], datetime(2026, 1, 4, 16, 59, tzinfo=timezone.utc), Decimal("0.5")
        )
        self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[1], datetime(2026, 1, 4, 10, 0, tzinfo=timezone.utc), Decimal("0.5")
        )
        self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0], datetime(2026, 1, 4, 17, 1, tzinfo=timezone.utc), Decimal("0.5")
        )

        sunday = self.tracking.get_daily_totals(self.profile_id, date(2026, 1, 4))
        monday = self.tracking.get_daily_totals(self.profile_id, date(2026, 1, 5))
        self.assertEqual(sunday["entry_count"], 2)
        self.assertEqual(sunday["totals"]["protein_g"], (Decimal("5.0"), False))
        self.assertEqual(sunday["totals"]["sodium_mg"], (Decimal("2.0"), True))
        self.assertEqual(sunday["totals"]["potassium_mg"], (Decimal("1.5"), False))
        self.assertEqual(monday["entry_count"], 1)
        self.assertEqual(monday["totals"]["protein_g"], (Decimal("5.0"), True))
        self.assertEqual(
            self.tracking.get_weekly_totals(self.profile_id, date(2026, 1, 4))["entry_count"], 2
        )
        self.assertEqual(
            self.tracking.get_weekly_totals(self.profile_id, date(2026, 1, 5))["entry_count"], 1
        )

    def test_rejects_naive_time_invalid_portions_and_invalid_ids(self):
        for consumed_at, portion in (
            (datetime(2026, 1, 1), Decimal("0.5")),
            (datetime(2026, 1, 1, tzinfo=timezone.utc), Decimal("0")),
            (datetime(2026, 1, 1, tzinfo=timezone.utc), Decimal("1.01")),
        ):
            with self.subTest(consumed_at=consumed_at, portion=portion), self.assertRaises(ValueError):
                self.tracking.record_consumption(self.profile_id, self.recipe_ids[0], consumed_at, portion)
        with self.assertRaises(ValueError):
            self.tracking.record_consumption(True, self.recipe_ids[0],
                                             datetime(2026, 1, 1, tzinfo=timezone.utc), Decimal("1"))
        self.assertIsNone(self.tracking.get_entry(99999))

    def test_history_snapshots_reject_replace(self):
        goal_id = self.profiles.add_goal(
            self.profile_id, "sodium_mg", 100, "mg/day", "2026-01-01", "Synthetic clinician"
        )
        entry_id = self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0],
            datetime(2026, 1, 2, tzinfo=timezone.utc), Decimal("1"),
        )
        with sqlite3.connect(self.database) as db:
            replacements = (
                ("INSERT OR REPLACE INTO meal_entry_seals(meal_entry_id, sealed_at) VALUES (?, ?)",
                 (entry_id, "2026-01-01T00:00:00+00:00")),
                ("INSERT OR REPLACE INTO meal_entries(id, profile_id, recipe_id, recipe_name, consumed_at_utc, local_date, portion) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 (entry_id, self.profile_id, self.recipe_ids[1], "Replaced", "2026-01-02T00:00:00+00:00", "2026-01-02", "1")),
                ("INSERT OR REPLACE INTO meal_entry_ingredients(meal_entry_id, position, ingredient_version_id, ingredient_name, amount, unit, food_state, version, provider, source_version, source_date, retrieved_on, source_reference, provenance, basis_quantity, basis_unit, source_food_state, reviewed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (entry_id, 0, self.version_ids[0], "Changed", "1", "g", "raw", "1", "P", "V", None, "2026-01-01", "ref", "synthetic", "100", "g", "raw", 0)),
                ("INSERT OR REPLACE INTO meal_entry_goals(meal_entry_id, position, goal_id, nutrient, amount, unit, effective_on, confirmed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                 (entry_id, 0, goal_id, "sodium_mg", "0", "mg/day", "2026-01-01", "Changed")),
                ("INSERT OR REPLACE INTO meal_entry_totals(meal_entry_id, nutrient, subtotal, complete) VALUES (?, ?, ?, ?)",
                 (entry_id, "protein_g", "999", 1)),
            )
            for statement, params in replacements:
                with self.subTest(statement=statement), self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                    db.execute(statement, params)

    def test_goals_snapshot_latest_per_nutrient_and_latest_same_day_correction(self):
        self.profiles.add_goal(self.profile_id, "sodium_mg", 1800, "mg/day", "2026-01-01", "asserted A")
        self.profiles.add_goal(self.profile_id, "sodium_mg", 1700, "custom", "2026-01-02", "asserted B")
        corrected = self.profiles.add_goal(
            self.profile_id, "sodium_mg", 1600, "unvalidated-unit", "2026-01-02", "asserted correction"
        )
        entry = self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0], datetime(2026, 1, 3, tzinfo=timezone.utc), Decimal("1")
        )
        goals = self.tracking.get_entry(entry)["goals"]
        self.assertEqual(len(goals), 1)
        self.assertEqual(goals[0]["goal_id"], corrected)
        self.assertEqual(goals[0]["unit"], "unvalidated-unit")

    def test_child_rows_cannot_be_added_after_snapshot_is_sealed(self):
        entry = self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0], datetime(2026, 1, 3, tzinfo=timezone.utc), Decimal("1")
        )
        with sqlite3.connect(self.database) as db, self.assertRaisesRegex(sqlite3.IntegrityError, "sealed"):
            db.execute(
                "INSERT INTO meal_entry_ingredients (meal_entry_id, position, ingredient_version_id, ingredient_name, amount, unit, food_state, version, provider, source_version, retrieved_on, source_reference, provenance, basis_quantity, basis_unit, source_food_state, reviewed) VALUES (?, 1, ?, 'Injected', '1', 'g', 'raw', '1', 'P', 'V', '2026-01-01', 'ref', 'synthetic', '100', 'g', 'raw', 0)",
                (entry, self.version_ids[0]),
            )

    def test_void_and_correction_are_audited_and_removed_from_totals(self):
        first = self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0], datetime(2026, 1, 3, tzinfo=timezone.utc), Decimal("1")
        )
        replacement = self.tracking.correct_consumption(
            first, datetime(2026, 1, 3, 12, tzinfo=timezone.utc), Decimal("0.5"), "synthetic correction"
        )
        result = self.tracking.get_daily_totals(self.profile_id, date(2026, 1, 3))
        self.assertEqual(result["entry_count"], 1)
        self.assertEqual(result["totals"]["protein_g"], (Decimal("5.0"), True))
        self.assertEqual(self.tracking.get_entry(first)["adjustment"]["replacement_entry_id"], replacement)
        with self.assertRaises(ValueError):
            self.tracking.correct_consumption(
                first, datetime(2026, 1, 3, tzinfo=timezone.utc), Decimal("1"), "second correction"
            )

        second = self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0], datetime(2026, 1, 3, 13, tzinfo=timezone.utc), Decimal("1")
        )
        self.tracking.void_consumption(second, "synthetic mistaken log")
        result = self.tracking.get_daily_totals(self.profile_id, date(2026, 1, 3))
        self.assertEqual(result["entry_count"], 1)
        self.assertEqual(self.tracking.get_entry(second)["adjustment"]["action"], "void")

    def test_correction_keeps_original_food_snapshot_after_recipe_edit(self):
        first = self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0], datetime(2026, 1, 3, tzinfo=timezone.utc), Decimal("1")
        )
        self.recipes.rename_recipe(self.recipe_ids[0], "Edited after log")
        self.recipes.replace_ingredients(self.recipe_ids[0], [
            (self.version_ids[1], Decimal("50"), "g", "raw"),
        ])
        replacement = self.tracking.correct_consumption(
            first, datetime(2026, 1, 3, 12, tzinfo=timezone.utc), Decimal("0.5"), "synthetic correction"
        )
        corrected = self.tracking.get_entry(replacement)
        self.assertEqual(corrected["recipe_name"], "Synthetic meal A")
        self.assertEqual(corrected["ingredients"][0]["ingredient_version_id"], self.version_ids[0])
        self.assertEqual(corrected["totals"]["protein_g"], (Decimal("5.0"), True))

    def test_correction_failure_rolls_back_replacement_and_adjustment(self):
        first = self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0], datetime(2026, 1, 3, tzinfo=timezone.utc), Decimal("1")
        )
        insert_snapshot = self.tracking._insert_snapshot

        def fail_after_replacement(*args, **kwargs):
            insert_snapshot(*args, **kwargs)
            raise RuntimeError("synthetic forced failure")

        self.tracking._insert_snapshot = fail_after_replacement
        with self.assertRaisesRegex(RuntimeError, "forced failure"):
            self.tracking.correct_consumption(
                first, datetime(2026, 1, 3, 12, tzinfo=timezone.utc), Decimal("0.5"), "synthetic correction"
            )
        self.tracking._insert_snapshot = insert_snapshot
        self.assertIsNone(self.tracking.get_entry(first)["adjustment"])
        self.assertEqual(self.tracking.get_daily_totals(self.profile_id, date(2026, 1, 3))["entry_count"], 1)

    def test_concurrent_corrections_allow_only_one_replacement(self):
        first = self.tracking.record_consumption(
            self.profile_id, self.recipe_ids[0], datetime(2026, 1, 3, tzinfo=timezone.utc), Decimal("1")
        )

        def correct():
            try:
                return self.tracking.correct_consumption(
                    first, datetime(2026, 1, 3, 12, tzinfo=timezone.utc), Decimal("0.5"), "synthetic correction"
                )
            except ValueError:
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            replacements = list(pool.map(lambda _: correct(), range(2)))
        self.assertEqual(sum(result is not None for result in replacements), 1)
        self.assertEqual(self.tracking.get_daily_totals(self.profile_id, date(2026, 1, 3))["entry_count"], 1)


if __name__ == "__main__":
    unittest.main()
