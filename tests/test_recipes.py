"""Synthetic integration tests for recipes linked to immutable ingredient sources."""

import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from nutrition.ingredients import IngredientStore
from nutrition.recipes import RecipeStore


class RecipeStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "synthetic.sqlite"
        self.ingredients = IngredientStore(self.database)
        self.recipes = RecipeStore(self.database)
        self.version_ids = []
        for name, version, values, reviewed, basis in (
            ("Synthetic bean", "1", {"protein_g": Decimal("5"), "sodium_mg": Decimal("0")}, True, "100"),
            ("Synthetic sauce", "1", {"sodium_mg": Decimal("10")}, False, "50"),
        ):
            ingredient_id = self.ingredients.create_ingredient(name)
            self.version_ids.append(self.ingredients.add_version(
                ingredient_id, version=version, provider="Synthetic provider", source_version="test-v1",
                retrieved_on="2026-11-01", source_reference=f"synthetic://{name}",
                provenance="synthetic test input", basis_quantity=Decimal(basis), basis_unit="g",
                food_state="raw", reviewed=reviewed, nutrients=values,
            ))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_calculates_portion_preserving_unknown_zero_and_review_assertion(self):
        recipe_id = self.recipes.create_recipe("Synthetic meal", [
            (self.version_ids[0], Decimal("200"), "g", "raw"),
            (self.version_ids[1], Decimal("25"), "g", "raw"),
        ])
        result = self.recipes.calculate_recipe(recipe_id, Decimal("0.25"))
        self.assertEqual(result["portion"], Decimal("0.25"))
        self.assertEqual(result["totals"]["protein_g"], (Decimal("2.5"), False))
        self.assertEqual(result["totals"]["sodium_mg"], (Decimal("1.25"), True))
        self.assertEqual(result["totals"]["potassium_mg"], (None, False))
        self.assertEqual(len(result["unreviewed_sources"]), 1)

        recipe = self.recipes.get_recipe(recipe_id)
        self.assertEqual(recipe["ingredients"][0]["protein_g"], Decimal("5"))
        self.assertEqual(recipe["ingredients"][0]["sodium_mg"], Decimal("0"))
        self.assertTrue(recipe["ingredients"][0]["reviewed"])
        self.assertFalse(recipe["ingredients"][1]["reviewed"])

    def test_recipe_requires_matching_unit_and_food_state(self):
        for unit, state in (("ml", "raw"), ("g", "cooked"), ("cup", "raw")):
            with self.subTest(unit=unit, state=state), self.assertRaises(ValueError):
                self.recipes.create_recipe("Invalid synthetic meal", [
                    (self.version_ids[0], Decimal("10"), unit, state),
                ])
        with self.assertRaises(ValueError):
            self.recipes.create_recipe("Unknown version", [(99999, Decimal("10"), "g", "raw")])
        with self.assertRaises(ValueError):
            self.recipes.create_recipe("Invalid amount", [(self.version_ids[0], Decimal("0"), "g", "raw")])

    def test_edit_favorite_and_source_version_are_persisted(self):
        recipe_id = self.recipes.create_recipe(
            "Before edit", [(self.version_ids[0], Decimal("10"), "g", "raw")]
        )
        self.recipes.rename_recipe(recipe_id, "After edit")
        self.recipes.set_favorite(recipe_id, True)
        self.recipes.replace_ingredients(recipe_id, [
            (self.version_ids[1], Decimal("15"), "g", "raw"),
        ])
        stored = RecipeStore(self.database).get_recipe(recipe_id)
        self.assertEqual(stored["name"], "After edit")
        self.assertTrue(stored["favorite"])
        self.assertEqual(stored["ingredients"][0]["ingredient_version_id"], self.version_ids[1])
        self.assertEqual(len(self.ingredients.get_ingredient(1)["versions"]), 1)

    def test_replacement_validation_failure_leaves_existing_recipe_unchanged(self):
        recipe_id = self.recipes.create_recipe(
            "Stable recipe", [(self.version_ids[0], Decimal("10"), "g", "raw")]
        )
        with self.assertRaises(ValueError):
            self.recipes.replace_ingredients(recipe_id, [
                (self.version_ids[1], Decimal("20"), "ml", "raw"),
            ])
        self.assertEqual(
            self.recipes.get_recipe(recipe_id)["ingredients"][0]["ingredient_version_id"],
            self.version_ids[0],
        )

    def test_public_recipe_methods_reject_boolean_ids(self):
        recipe_id = self.recipes.create_recipe(
            "Synthetic recipe", [(self.version_ids[0], Decimal("10"), "g", "raw")]
        )
        self.assertEqual(recipe_id, 1)
        operations = (
            lambda: self.recipes.rename_recipe(True, "Changed"),
            lambda: self.recipes.set_favorite(True, True),
            lambda: self.recipes.replace_ingredients(True, [
                (self.version_ids[0], Decimal("10"), "g", "raw"),
            ]),
            lambda: self.recipes.get_recipe(True),
            lambda: self.recipes.calculate_recipe(True, Decimal("1")),
        )
        for operation in operations:
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                operation()

    def test_recent_opens_are_atomic_current_and_bounded(self):
        recipe_ids = [self.recipes.create_recipe(
            f"Synthetic meal {index}", [(self.version_ids[0], Decimal("10"), "g", "raw")]
        ) for index in range(12)]
        for recipe_id in recipe_ids:
            self.recipes.record_recipe_open(recipe_id)
        self.recipes.record_recipe_open(recipe_ids[0])
        self.assertEqual([item["recipe_id"] for item in self.recipes.list_recent_recipes()],
                         [recipe_ids[0], *reversed(recipe_ids[-9:])])
        with self.assertRaises(LookupError):
            self.recipes.record_recipe_open(99999)
        self.assertEqual(self.recipes.list_recent_recipes()[0]["recipe_id"], recipe_ids[0])
        with self.assertRaises(ValueError):
            self.recipes.list_recent_recipes(True)
        self.recipes.update_recipe(recipe_ids[0], name="Current name", favorite=True)
        self.assertEqual(self.recipes.list_recent_recipes()[0]["name"], "Current name")
        self.assertTrue(self.recipes.list_recent_recipes()[0]["favorite"])
        self.recipes.delete_recipe(recipe_ids[0])
        self.assertNotIn(recipe_ids[0], [item["recipe_id"] for item in self.recipes.list_recent_recipes()])


if __name__ == "__main__":
    unittest.main()
