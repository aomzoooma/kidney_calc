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
                CREATE TRIGGER IF NOT EXISTS ingredient_versions_no_update
                    BEFORE UPDATE ON ingredient_versions BEGIN
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
