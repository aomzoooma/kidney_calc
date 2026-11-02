"""Synthetic-data persistence and validation tests."""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from nutrition.profiles import ProfileStore


class ProfileStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = ProfileStore(Path(self.temp_dir.name) / "synthetic.sqlite")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_persists_dated_weights_and_manual_goals(self):
        profile_id = self.store.create_profile("Synthetic profile")
        self.store.add_dry_weight(profile_id, "2026-10-01", 62.5)
        self.store.add_dry_weight(profile_id, "2026-11-01", 61.8)
        self.store.add_goal(profile_id, "protein", 45, "g/day", "2026-10-15", "Synthetic clinician")
        self.store.add_goal(profile_id, "sodium", 0, "mg/day", "2026-10-15", "Synthetic clinician")

        reopened = ProfileStore(self.store.database).get_profile(profile_id)
        self.assertEqual([w["measured_on"] for w in reopened["dry_weights"]], ["2026-10-01", "2026-11-01"])
        self.assertEqual(reopened["dry_weights"][1]["kilograms"], 61.8)
        self.assertEqual(reopened["goals"][1]["amount"], 0)
        self.assertEqual(reopened["goals"][0]["confirmed_by"], "Synthetic clinician")
        self.assertIsNone(self.store.get_profile(98765))

    def test_rejects_ephemeral_in_memory_database(self):
        for database in (":memory:", "file::memory:?cache=shared", "file:profile?mode=memory&cache=shared"):
            with self.subTest(database=database), self.assertRaises(ValueError):
                ProfileStore(database)

    def test_rejects_invalid_dates_values_and_empty_fields(self):
        profile_id = self.store.create_profile("Synthetic")
        for args in [(profile_id, "not-a-date", 60), (profile_id, "2026-02-30", 60),
                     (profile_id, "2026-01-01", 0), (profile_id, "2026-01-01", float("inf"))]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.store.add_dry_weight(*args)
        for amount in [-1, float("nan"), float("inf"), True]:
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                self.store.add_goal(profile_id, "sodium", amount, "mg/day", "2026-01-01", "Clinician")
        with self.assertRaises(ValueError):
            self.store.create_profile("  ")

    def test_parameterized_values_and_foreign_key(self):
        hostile_name = "x'); DROP TABLE patient_profiles; --"
        profile_id = self.store.create_profile(hostile_name)
        self.assertEqual(self.store.get_profile(profile_id)["name"], hostile_name)
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.add_dry_weight(98765, "2026-01-01", 60)
        self.assertIsNotNone(self.store.get_profile(profile_id))


if __name__ == "__main__":
    unittest.main()
