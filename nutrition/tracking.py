"""Immutable meal-consumption snapshots and local-day nutrient totals."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from nutrition.calculator import NUTRIENTS, Measure, NutrientSource, calculate


try:
    BANGKOK = ZoneInfo("Asia/Bangkok")
except ZoneInfoNotFoundError as exc:
    raise RuntimeError("IANA timezone data is required; install the tzdata package") from exc


def _positive_id(value, field):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= 2**63 - 1:
        raise ValueError(f"{field} must be a positive SQLite integer")
    return value


def _portion(value):
    if not isinstance(value, Decimal) or not value.is_finite() or not 0 < value <= 1:
        raise ValueError("portion must be a finite Decimal in (0, 1]")
    return str(value)


def _consumed_at(value):
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("consumed_at must be a timezone-aware datetime")
    try:
        local_date = value.astimezone(BANGKOK).date().isoformat()
        utc_timestamp = value.astimezone(timezone.utc).isoformat(timespec="microseconds")
    except OverflowError as exc:
        raise ValueError("consumed_at is outside the supported date range") from exc
    return utc_timestamp, local_date


def _day(value):
    if isinstance(value, datetime) or not isinstance(value, date):
        raise ValueError("day must be a date")
    return value.isoformat()


class MealTrackingStore:
    """Store actual consumption with immutable recipe, source, nutrient, and goal snapshots."""

    def __init__(self, database: str | Path):
        self.database = str(database)
        if self.database == ":memory:" or self.database.startswith("file::memory:") or "mode=memory" in self.database:
            raise ValueError("MealTrackingStore requires a persistent SQLite database path")
        with self._connect() as db:
            required = {
                "patient_profiles", "clinician_goals", "recipes", "recipe_ingredients",
                "ingredients", "ingredient_versions",
            }
            present = {
                row[0] for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            missing = required - present
            if missing:
                raise ValueError(f"Initialize profile, ingredient, and recipe stores first: {sorted(missing)}")
            db.executescript(f"""
                CREATE TABLE IF NOT EXISTS meal_entries (
                    id INTEGER PRIMARY KEY,
                    profile_id INTEGER NOT NULL REFERENCES patient_profiles(id) ON DELETE RESTRICT,
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
                    recipe_name TEXT NOT NULL,
                    consumed_at_utc TEXT NOT NULL,
                    local_date TEXT NOT NULL,
                    portion TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS meal_entry_ingredients (
                    meal_entry_id INTEGER NOT NULL REFERENCES meal_entries(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL CHECK(position >= 0),
                    ingredient_version_id INTEGER NOT NULL REFERENCES ingredient_versions(id) ON DELETE RESTRICT,
                    ingredient_name TEXT NOT NULL,
                    amount TEXT NOT NULL,
                    unit TEXT NOT NULL,
                    food_state TEXT NOT NULL,
                    version TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    source_version TEXT NOT NULL,
                    source_date TEXT,
                    retrieved_on TEXT NOT NULL,
                    source_reference TEXT NOT NULL,
                    provenance TEXT NOT NULL,
                    basis_quantity TEXT NOT NULL,
                    basis_unit TEXT NOT NULL,
                    source_food_state TEXT NOT NULL,
                    reviewed INTEGER NOT NULL CHECK(reviewed IN (0, 1)),
                    {', '.join(f'"{key}" TEXT' for key in NUTRIENTS)},
                    PRIMARY KEY(meal_entry_id, position)
                );
                CREATE TABLE IF NOT EXISTS meal_entry_goals (
                    meal_entry_id INTEGER NOT NULL REFERENCES meal_entries(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL CHECK(position >= 0),
                    goal_id INTEGER NOT NULL,
                    nutrient TEXT NOT NULL,
                    amount TEXT NOT NULL,
                    unit TEXT NOT NULL,
                    effective_on TEXT NOT NULL,
                    confirmed_by TEXT NOT NULL,
                    PRIMARY KEY(meal_entry_id, position)
                );
                CREATE TABLE IF NOT EXISTS meal_entry_totals (
                    meal_entry_id INTEGER NOT NULL REFERENCES meal_entries(id) ON DELETE CASCADE,
                    nutrient TEXT NOT NULL,
                    subtotal TEXT,
                    complete INTEGER NOT NULL CHECK(complete IN (0, 1)),
                    PRIMARY KEY(meal_entry_id, nutrient)
                );
                CREATE TABLE IF NOT EXISTS meal_entry_seals (
                    meal_entry_id INTEGER PRIMARY KEY REFERENCES meal_entries(id) ON DELETE RESTRICT,
                    sealed_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS meal_entry_adjustments (
                    meal_entry_id INTEGER PRIMARY KEY REFERENCES meal_entries(id) ON DELETE RESTRICT,
                    action TEXT NOT NULL CHECK(action IN ('void', 'correct')),
                    replacement_entry_id INTEGER REFERENCES meal_entries(id) ON DELETE RESTRICT,
                    reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
                    recorded_at TEXT NOT NULL,
                    CHECK((action = 'void' AND replacement_entry_id IS NULL) OR
                          (action = 'correct' AND replacement_entry_id IS NOT NULL AND replacement_entry_id != meal_entry_id))
                );
                CREATE TRIGGER IF NOT EXISTS meal_entries_no_replace
                    BEFORE INSERT ON meal_entries
                    WHEN EXISTS (SELECT 1 FROM meal_entries WHERE id = NEW.id) BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entries_no_update
                    BEFORE UPDATE ON meal_entries BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entries_no_delete
                    BEFORE DELETE ON meal_entries BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_seal_validate
                    BEFORE INSERT ON meal_entry_seals
                    WHEN (SELECT COUNT(*) FROM meal_entry_ingredients WHERE meal_entry_id = NEW.meal_entry_id) = 0
                      OR (SELECT COUNT(*) FROM meal_entry_totals WHERE meal_entry_id = NEW.meal_entry_id) != {len(NUTRIENTS)}
                    BEGIN SELECT RAISE(ABORT, 'incomplete meal snapshot'); END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_seals_no_replace
                    BEFORE INSERT ON meal_entry_seals
                    WHEN EXISTS(SELECT 1 FROM meal_entry_seals WHERE meal_entry_id = NEW.meal_entry_id)
                    BEGIN SELECT RAISE(ABORT, 'meal history is immutable'); END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_seals_no_update
                    BEFORE UPDATE ON meal_entry_seals BEGIN SELECT RAISE(ABORT, 'meal history is immutable'); END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_seals_no_delete
                    BEFORE DELETE ON meal_entry_seals BEGIN SELECT RAISE(ABORT, 'meal history is immutable'); END;
                CREATE TRIGGER IF NOT EXISTS meal_adjustments_no_update
                    BEFORE UPDATE ON meal_entry_adjustments BEGIN SELECT RAISE(ABORT, 'meal adjustments are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS meal_adjustments_no_delete
                    BEFORE DELETE ON meal_entry_adjustments BEGIN SELECT RAISE(ABORT, 'meal adjustments are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS meal_adjustments_no_replace
                    BEFORE INSERT ON meal_entry_adjustments
                    WHEN EXISTS(SELECT 1 FROM meal_entry_adjustments WHERE meal_entry_id = NEW.meal_entry_id)
                    BEGIN SELECT RAISE(ABORT, 'meal adjustments are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_ingredients_no_update
                    BEFORE UPDATE ON meal_entry_ingredients BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_ingredients_after_seal
                    BEFORE INSERT ON meal_entry_ingredients
                    WHEN EXISTS(SELECT 1 FROM meal_entry_seals WHERE meal_entry_id = NEW.meal_entry_id)
                    BEGIN SELECT RAISE(ABORT, 'meal history is sealed'); END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_ingredients_no_replace
                    BEFORE INSERT ON meal_entry_ingredients
                    WHEN EXISTS (SELECT 1 FROM meal_entry_ingredients
                                 WHERE meal_entry_id = NEW.meal_entry_id AND position = NEW.position) BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_ingredients_no_delete
                    BEFORE DELETE ON meal_entry_ingredients BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_goals_no_update
                    BEFORE UPDATE ON meal_entry_goals BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_goals_after_seal
                    BEFORE INSERT ON meal_entry_goals
                    WHEN EXISTS(SELECT 1 FROM meal_entry_seals WHERE meal_entry_id = NEW.meal_entry_id)
                    BEGIN SELECT RAISE(ABORT, 'meal history is sealed'); END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_goals_no_replace
                    BEFORE INSERT ON meal_entry_goals
                    WHEN EXISTS (SELECT 1 FROM meal_entry_goals
                                 WHERE meal_entry_id = NEW.meal_entry_id AND position = NEW.position) BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_goals_no_delete
                    BEFORE DELETE ON meal_entry_goals BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_totals_no_update
                    BEFORE UPDATE ON meal_entry_totals BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_totals_after_seal
                    BEFORE INSERT ON meal_entry_totals
                    WHEN EXISTS(SELECT 1 FROM meal_entry_seals WHERE meal_entry_id = NEW.meal_entry_id)
                    BEGIN SELECT RAISE(ABORT, 'meal history is sealed'); END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_totals_no_replace
                    BEFORE INSERT ON meal_entry_totals
                    WHEN EXISTS (SELECT 1 FROM meal_entry_totals
                                 WHERE meal_entry_id = NEW.meal_entry_id AND nutrient = NEW.nutrient) BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS meal_entry_totals_no_delete
                    BEFORE DELETE ON meal_entry_totals BEGIN
                    SELECT RAISE(ABORT, 'meal history is immutable');
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

    def _insert_snapshot(self, db, profile_id, recipe_id, recipe_name, consumed_at_utc,
                         local_date, portion_text, rows, goals):
        inputs = []
        for row in rows:
            reference = Measure(Decimal(row["basis_quantity"]), row["basis_unit"], row["source_food_state"])
            amount = Measure(Decimal(row["amount"]), row["unit"], row["food_state"])
            values = {key: Decimal(row[key]) if row[key] is not None else None for key in NUTRIENTS}
            citation = f"{row['provider']} ({row['source_version']}): {row['source_reference']}"
            inputs.append((amount, NutrientSource(reference, values, citation, bool(row["reviewed"]))))
        totals, _ = calculate(inputs, Decimal(portion_text))
        cursor = db.execute(
            """INSERT INTO meal_entries
               (profile_id, recipe_id, recipe_name, consumed_at_utc, local_date, portion)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (profile_id, recipe_id, recipe_name, consumed_at_utc, local_date, portion_text),
        )
        entry_id = cursor.lastrowid
        nutrient_columns = ", ".join(f'"{key}"' for key in NUTRIENTS)
        ingredient_placeholders = ", ".join("?" for _ in range(18 + len(NUTRIENTS)))
        db.executemany(
            f"""INSERT INTO meal_entry_ingredients
                (meal_entry_id, position, ingredient_version_id, ingredient_name, amount, unit,
                 food_state, version, provider, source_version, source_date, retrieved_on,
                 source_reference, provenance, basis_quantity, basis_unit, source_food_state, reviewed,
                 {nutrient_columns})
                VALUES ({ingredient_placeholders})""",
            [(
                entry_id, row["position"], row["ingredient_version_id"], row["ingredient_name"],
                row["amount"], row["unit"], row["food_state"], row["version"], row["provider"],
                row["source_version"], row["source_date"], row["retrieved_on"], row["source_reference"],
                row["provenance"], row["basis_quantity"], row["basis_unit"], row["source_food_state"],
                row["reviewed"], *(row[key] for key in NUTRIENTS),
            ) for row in rows],
        )
        db.executemany(
            """INSERT INTO meal_entry_goals
               (meal_entry_id, position, goal_id, nutrient, amount, unit, effective_on, confirmed_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [(entry_id, position, row["goal_id"] if "goal_id" in row.keys() else row["id"], row["nutrient"],
              str(row["amount"]), row["unit"], row["effective_on"], row["confirmed_by"])
             for position, row in enumerate(goals)],
        )
        db.executemany(
            "INSERT INTO meal_entry_totals(meal_entry_id, nutrient, subtotal, complete) VALUES (?, ?, ?, ?)",
            [(entry_id, nutrient, str(value) if value is not None else None, int(complete))
             for nutrient, (value, complete) in totals.items()],
        )
        db.execute(
            "INSERT INTO meal_entry_seals(meal_entry_id, sealed_at) VALUES (?, ?)",
            (entry_id, datetime.now(timezone.utc).isoformat(timespec="microseconds")),
        )
        return entry_id

    def record_consumption(self, profile_id: int, recipe_id: int,
                           consumed_at: datetime, portion: Decimal) -> int:
        """Record an actual consumed fraction and freeze the source and goal inputs used."""
        profile_id = _positive_id(profile_id, "profile_id")
        recipe_id = _positive_id(recipe_id, "recipe_id")
        portion_text = _portion(portion)
        consumed_at_utc, local_date = _consumed_at(consumed_at)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM patient_profiles WHERE id = ?", (profile_id,)).fetchone() is None:
                raise LookupError("profile not found")
            recipe = db.execute("SELECT id, name FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
            if recipe is None:
                raise LookupError("recipe not found")
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
            if not rows:
                raise ValueError("recipe requires at least one ingredient")
            goals = db.execute(
                """SELECT id, nutrient, amount, unit, effective_on, confirmed_by
                   FROM (
                       SELECT id, nutrient, amount, unit, effective_on, confirmed_by,
                              ROW_NUMBER() OVER (
                                  PARTITION BY nutrient ORDER BY effective_on DESC, id DESC
                              ) AS rank
                       FROM clinician_goals WHERE profile_id = ? AND effective_on <= ?
                   ) WHERE rank = 1 ORDER BY nutrient""",
                (profile_id, local_date),
            ).fetchall()
            return self._insert_snapshot(db, profile_id, recipe_id, recipe["name"], consumed_at_utc,
                                         local_date, portion_text, rows, goals)

    def void_consumption(self, entry_id: int, reason: str) -> None:
        """Append a user-asserted void; original snapshot remains available for audit."""
        entry_id = _positive_id(entry_id, "entry_id")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("reason must be non-empty text")
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM meal_entry_seals WHERE meal_entry_id = ?", (entry_id,)).fetchone() is None:
                raise LookupError("meal entry not found")
            db.execute(
                "INSERT INTO meal_entry_adjustments VALUES (?, 'void', NULL, ?, ?)",
                (entry_id, reason.strip(), datetime.now(timezone.utc).isoformat(timespec="microseconds")),
            )

    def correct_consumption(self, entry_id: int, consumed_at: datetime, portion: Decimal,
                            reason: str) -> int:
        """Record a replacement snapshot and append a correction link to the original."""
        entry_id = _positive_id(entry_id, "entry_id")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("reason must be non-empty text")
        consumed_at_utc, local_date = _consumed_at(consumed_at)
        portion_text = _portion(portion)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            original = db.execute(
                """SELECT e.profile_id, e.recipe_id, e.recipe_name
                   FROM meal_entries e JOIN meal_entry_seals s ON s.meal_entry_id = e.id
                   WHERE e.id = ?""", (entry_id,)
            ).fetchone()
            if original is None:
                raise LookupError("meal entry not found")
            if db.execute("SELECT 1 FROM meal_entry_adjustments WHERE meal_entry_id = ?", (entry_id,)).fetchone():
                raise ValueError("meal entry already adjusted")
            rows = db.execute(
                "SELECT * FROM meal_entry_ingredients WHERE meal_entry_id = ? ORDER BY position", (entry_id,)
            ).fetchall()
            goals = db.execute(
                "SELECT * FROM meal_entry_goals WHERE meal_entry_id = ? ORDER BY position", (entry_id,)
            ).fetchall()
            replacement_id = self._insert_snapshot(
                db, original["profile_id"], original["recipe_id"], original["recipe_name"],
                consumed_at_utc, local_date, portion_text, rows, goals,
            )
            db.execute(
                "INSERT INTO meal_entry_adjustments VALUES (?, 'correct', ?, ?, ?)",
                (entry_id, replacement_id, reason.strip(), datetime.now(timezone.utc).isoformat(timespec="microseconds")),
            )
        return replacement_id

    def get_entry(self, entry_id: int) -> dict | None:
        entry_id = _positive_id(entry_id, "entry_id")
        with self._connect() as db:
            entry = db.execute("SELECT * FROM meal_entries WHERE id = ?", (entry_id,)).fetchone()
            if entry is None:
                return None
            ingredients = db.execute(
                "SELECT * FROM meal_entry_ingredients WHERE meal_entry_id = ? ORDER BY position",
                (entry_id,),
            ).fetchall()
            goals = db.execute(
                "SELECT * FROM meal_entry_goals WHERE meal_entry_id = ? ORDER BY position",
                (entry_id,),
            ).fetchall()
            totals = db.execute(
                "SELECT nutrient, subtotal, complete FROM meal_entry_totals WHERE meal_entry_id = ?",
                (entry_id,),
            ).fetchall()
            adjustment = db.execute(
                "SELECT action, replacement_entry_id, reason, recorded_at FROM meal_entry_adjustments WHERE meal_entry_id = ?",
                (entry_id,),
            ).fetchone()
            snapshot_ingredients = []
            for row in ingredients:
                item = dict(row)
                item["amount"] = Decimal(item["amount"])
                item["basis_quantity"] = Decimal(item["basis_quantity"])
                item["reviewed"] = bool(item["reviewed"])
                for nutrient in NUTRIENTS:
                    item[nutrient] = Decimal(item[nutrient]) if item[nutrient] is not None else None
                snapshot_ingredients.append(item)
            return {
                **dict(entry),
                "portion": Decimal(entry["portion"]),
                "ingredients": snapshot_ingredients,
                "goals": [dict(row) for row in goals],
                "adjustment": dict(adjustment) if adjustment else None,
                "totals": {
                    row["nutrient"]: (
                        Decimal(row["subtotal"]) if row["subtotal"] is not None else None,
                        bool(row["complete"]),
                    ) for row in totals
                },
            }

    def list_entries(self, profile_id: int, day: date, limit: int = 50) -> list[dict]:
        """Return a bounded, newest-first page of sealed entries for one Bangkok civil day."""
        profile_id = _positive_id(profile_id, "profile_id")
        day_text = _day(day)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("limit must be an integer between 1 and 100")
        with self._connect() as db:
            if db.execute("SELECT 1 FROM patient_profiles WHERE id = ?", (profile_id,)).fetchone() is None:
                raise LookupError("profile not found")
            rows = db.execute(
                """SELECT e.id FROM meal_entries e
                   JOIN meal_entry_seals s ON s.meal_entry_id = e.id
                   WHERE e.profile_id = ? AND e.local_date = ?
                   ORDER BY e.consumed_at_utc DESC, e.id DESC LIMIT ?""",
                (profile_id, day_text, limit),
            ).fetchall()
        return [self.get_entry(row["id"]) for row in rows]

    def _period_totals(self, profile_id: int, start: date, end: date) -> dict:
        profile_id = _positive_id(profile_id, "profile_id")
        start_text, end_text = _day(start), _day(end)
        if start_text > end_text:
            raise ValueError("period start must not be after end")
        with self._connect() as db:
            db.execute("BEGIN")
            if db.execute("SELECT 1 FROM patient_profiles WHERE id = ?", (profile_id,)).fetchone() is None:
                raise LookupError("profile not found")
            count = db.execute(
                """SELECT COUNT(*) FROM meal_entries e
                   JOIN meal_entry_seals s ON s.meal_entry_id = e.id
                   WHERE e.profile_id = ? AND e.local_date BETWEEN ? AND ?
                     AND NOT EXISTS (SELECT 1 FROM meal_entry_adjustments a WHERE a.meal_entry_id = e.id)""",
                (profile_id, start_text, end_text),
            ).fetchone()[0]
            rows = db.execute(
                """SELECT t.nutrient, t.subtotal, t.complete FROM meal_entry_totals t
                   JOIN meal_entries e ON e.id = t.meal_entry_id
                   JOIN meal_entry_seals s ON s.meal_entry_id = e.id
                   WHERE e.profile_id = ? AND e.local_date BETWEEN ? AND ?
                     AND NOT EXISTS (SELECT 1 FROM meal_entry_adjustments a WHERE a.meal_entry_id = e.id)""",
                (profile_id, start_text, end_text),
            ).fetchall()
            grouped = {nutrient: [] for nutrient in NUTRIENTS}
            for row in rows:
                grouped[row["nutrient"]].append(row)
            totals = {}
            for nutrient, nutrient_rows in grouped.items():
                known = [Decimal(row["subtotal"]) for row in nutrient_rows if row["subtotal"] is not None]
                subtotal = sum(known, Decimal(0)) if known else None
                complete = bool(nutrient_rows) and all(bool(row["complete"]) for row in nutrient_rows)
                totals[nutrient] = (subtotal, complete)
            return {
                "profile_id": profile_id,
                "start_date": start_text,
                "end_date": end_text,
                "entry_count": count,
                "totals": totals,
            }

    def get_daily_totals(self, profile_id: int, day: date) -> dict:
        _day(day)
        return self._period_totals(profile_id, day, day)

    def get_weekly_totals(self, profile_id: int, day_in_week: date) -> dict:
        """Sum the ISO week containing the Bangkok civil date; weeks run Monday through Sunday."""
        _day(day_in_week)
        monday = day_in_week - timedelta(days=day_in_week.weekday())
        if monday > date.max - timedelta(days=6):
            raise ValueError("week exceeds supported date range")
        return self._period_totals(profile_id, monday, monday + timedelta(days=6))
