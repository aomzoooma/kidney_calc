"""Local recipe storage and estimates using immutable ingredient source versions."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path

from nutrition.calculator import NUTRIENTS, Measure, NutrientSource, calculate


def _text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be non-empty text")
    return value.strip()


def _amount(value):
    if not isinstance(value, Decimal) or not value.is_finite() or value <= 0:
        raise ValueError("amount must be a positive finite Decimal")
    return str(value)


def _recipe_id(value):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("recipe_id must be a positive integer")
    return value


class RecipeStore:
    """Recipes reference ingredient source version IDs in the same SQLite database."""

    def __init__(self, database: str | Path):
        self.database = str(database)
        if self.database == ":memory:" or self.database.startswith("file::memory:") or "mode=memory" in self.database:
            raise ValueError("RecipeStore requires a persistent SQLite database path")
        with self._connect() as db:
            source_table = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ingredient_versions'"
            ).fetchone()
            if source_table is None:
                raise ValueError("Initialize IngredientStore in this database before RecipeStore")
            db.executescript(f"""
                CREATE TABLE IF NOT EXISTS recipes (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
                    favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1))
                );
                CREATE TABLE IF NOT EXISTS recipe_ingredients (
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL CHECK(position >= 0),
                    ingredient_version_id INTEGER NOT NULL REFERENCES ingredient_versions(id),
                    amount TEXT NOT NULL,
                    unit TEXT NOT NULL CHECK(unit IN ('g', 'ml')),
                    food_state TEXT NOT NULL CHECK(food_state IN ('raw', 'cooked', 'as_sold')),
                    PRIMARY KEY(recipe_id, position)
                );
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

    @staticmethod
    def _validated_ingredients(db, ingredients):
        if not isinstance(ingredients, (list, tuple)) or not ingredients:
            raise ValueError("a recipe requires at least one ingredient")
        entries = []
        for position, item in enumerate(ingredients):
            if not isinstance(item, (list, tuple)) or len(item) != 4:
                raise ValueError("ingredient entries are (source_version_id, amount, unit, food_state)")
            version_id, amount, unit, food_state = item
            if isinstance(version_id, bool) or not isinstance(version_id, int) or version_id <= 0:
                raise ValueError("source_version_id must be a positive integer")
            amount = _amount(amount)
            if unit not in ("g", "ml") or food_state not in ("raw", "cooked", "as_sold"):
                raise ValueError("unit and food_state must be explicit supported values")
            source = db.execute(
                "SELECT basis_unit, food_state FROM ingredient_versions WHERE id = ?", (version_id,)
            ).fetchone()
            if source is None:
                raise ValueError(f"unknown ingredient source version: {version_id}")
            if unit != source["basis_unit"] or food_state != source["food_state"]:
                raise ValueError("recipe amount unit and food state must match the source version")
            entries.append((position, version_id, amount, unit, food_state))
        return entries

    @staticmethod
    def _insert_ingredients(db, recipe_id, entries):
        db.executemany(
            """INSERT INTO recipe_ingredients
               (recipe_id, position, ingredient_version_id, amount, unit, food_state)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [(recipe_id, *entry) for entry in entries],
        )

    def create_recipe(self, name: str, ingredients: list[tuple], favorite: bool = False) -> int:
        name = _text(name, "name")
        if type(favorite) is not bool:
            raise ValueError("favorite must be a boolean")
        with self._connect() as db:
            entries = self._validated_ingredients(db, ingredients)
            cursor = db.execute(
                "INSERT INTO recipes(name, favorite) VALUES (?, ?)", (name, int(favorite))
            )
            recipe_id = cursor.lastrowid
            self._insert_ingredients(db, recipe_id, entries)
            return recipe_id

    def rename_recipe(self, recipe_id: int, name: str):
        recipe_id = _recipe_id(recipe_id)
        name = _text(name, "name")
        with self._connect() as db:
            cursor = db.execute("UPDATE recipes SET name = ? WHERE id = ?", (name, recipe_id))
            if cursor.rowcount == 0:
                raise LookupError("recipe not found")

    def set_favorite(self, recipe_id: int, favorite: bool):
        recipe_id = _recipe_id(recipe_id)
        if type(favorite) is not bool:
            raise ValueError("favorite must be a boolean")
        with self._connect() as db:
            cursor = db.execute(
                "UPDATE recipes SET favorite = ? WHERE id = ?", (int(favorite), recipe_id)
            )
            if cursor.rowcount == 0:
                raise LookupError("recipe not found")

    def replace_ingredients(self, recipe_id: int, ingredients: list[tuple]):
        recipe_id = _recipe_id(recipe_id)
        with self._connect() as db:
            if db.execute("SELECT 1 FROM recipes WHERE id = ?", (recipe_id,)).fetchone() is None:
                raise LookupError("recipe not found")
            entries = self._validated_ingredients(db, ingredients)
            db.execute("DELETE FROM recipe_ingredients WHERE recipe_id = ?", (recipe_id,))
            self._insert_ingredients(db, recipe_id, entries)

    def get_recipe(self, recipe_id: int) -> dict | None:
        recipe_id = _recipe_id(recipe_id)
        with self._connect() as db:
            recipe = db.execute(
                "SELECT id, name, favorite FROM recipes WHERE id = ?", (recipe_id,)
            ).fetchone()
            if recipe is None:
                return None
            rows = db.execute(
                """SELECT ri.position, ri.ingredient_version_id, ri.amount, ri.unit, ri.food_state,
                          i.name AS ingredient_name, v.version, v.provider, v.source_version,
                          v.source_date, v.retrieved_on, v.source_reference, v.provenance,
                          v.basis_quantity, v.basis_unit, v.food_state AS source_food_state,
                          v.reviewed, """ + ", ".join(f'v."{key}"' for key in NUTRIENTS) + """
                   FROM recipe_ingredients ri
                   JOIN ingredient_versions v ON v.id = ri.ingredient_version_id
                   JOIN ingredients i ON i.id = v.ingredient_id
                   WHERE ri.recipe_id = ? ORDER BY ri.position""",
                (recipe_id,),
            ).fetchall()
            ingredients = []
            for row in rows:
                item = dict(row)
                item["amount"] = Decimal(item["amount"])
                item["basis_quantity"] = Decimal(item["basis_quantity"])
                item["reviewed"] = bool(item["reviewed"])
                for key in NUTRIENTS:
                    item[key] = Decimal(item[key]) if item[key] is not None else None
                ingredients.append(item)
            return {
                "id": recipe["id"], "name": recipe["name"],
                "favorite": bool(recipe["favorite"]), "ingredients": ingredients,
            }

    def calculate_recipe(self, recipe_id: int, portion: Decimal) -> dict:
        recipe = self.get_recipe(recipe_id)
        if recipe is None:
            raise LookupError("recipe not found")
        inputs = []
        for item in recipe["ingredients"]:
            reference = Measure(item["basis_quantity"], item["basis_unit"], item["source_food_state"])
            amount = Measure(item["amount"], item["unit"], item["food_state"])
            values = {key: item[key] for key in NUTRIENTS}
            citation = f"{item['provider']} ({item['source_version']}): {item['source_reference']}"
            source = NutrientSource(reference, values, citation, item["reviewed"])
            inputs.append((amount, source))
        totals, unreviewed_sources = calculate(inputs, portion)
        return {"totals": totals, "unreviewed_sources": unreviewed_sources, "portion": portion}
