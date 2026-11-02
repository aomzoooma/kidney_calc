"""Local SQLite persistence for patient profiles and manually entered clinical records."""

from __future__ import annotations

import math
import sqlite3
from contextlib import contextmanager
from datetime import date
from pathlib import Path


def _text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be non-empty text")
    return value.strip()


def _day(value, field):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO date")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO date") from exc


def _number(value, field, *, allow_zero):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a number")
    value = float(value)
    if not math.isfinite(value) or value < 0 or (value == 0 and not allow_zero):
        raise ValueError(f"{field} must be {'non-negative' if allow_zero else 'positive'} and finite")
    return value


def _profile_id(value):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("profile_id must be a positive integer")
    return value


class ProfileStore:
    """Small local store. Caller must keep the database private and out of source control."""

    def __init__(self, database: str | Path):
        self.database = str(database)
        if self.database == ":memory:" or self.database.startswith("file::memory:") or "mode=memory" in self.database:
            raise ValueError("ProfileStore requires a persistent SQLite database path")
        with self._connect() as db:
            db.executescript("""
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS patient_profiles (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL CHECK(length(trim(name)) > 0)
                );
                CREATE TABLE IF NOT EXISTS dry_weights (
                    id INTEGER PRIMARY KEY,
                    profile_id INTEGER NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
                    measured_on TEXT NOT NULL,
                    kilograms REAL NOT NULL CHECK(kilograms > 0)
                );
                CREATE TABLE IF NOT EXISTS clinician_goals (
                    id INTEGER PRIMARY KEY,
                    profile_id INTEGER NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
                    nutrient TEXT NOT NULL CHECK(length(trim(nutrient)) > 0),
                    amount REAL NOT NULL CHECK(amount >= 0),
                    unit TEXT NOT NULL CHECK(length(trim(unit)) > 0),
                    effective_on TEXT NOT NULL,
                    confirmed_by TEXT NOT NULL CHECK(length(trim(confirmed_by)) > 0)
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

    def create_profile(self, name: str) -> int:
        name = _text(name, "name")
        with self._connect() as db:
            cursor = db.execute("INSERT INTO patient_profiles(name) VALUES (?)", (name,))
            return cursor.lastrowid

    def add_dry_weight(self, profile_id: int, measured_on: str, kilograms: float) -> int:
        profile_id = _profile_id(profile_id)
        measured_on = _day(measured_on, "measured_on")
        kilograms = _number(kilograms, "kilograms", allow_zero=False)
        with self._connect() as db:
            cursor = db.execute(
                "INSERT INTO dry_weights(profile_id, measured_on, kilograms) VALUES (?, ?, ?)",
                (profile_id, measured_on, kilograms),
            )
            return cursor.lastrowid

    def add_goal(self, profile_id: int, nutrient: str, amount: float, unit: str,
                 effective_on: str, confirmed_by: str) -> int:
        """Store user-entered goal details; confirmation is an assertion, and units need downstream validation."""
        profile_id = _profile_id(profile_id)
        nutrient = _text(nutrient, "nutrient")
        amount = _number(amount, "amount", allow_zero=True)
        unit = _text(unit, "unit")
        effective_on = _day(effective_on, "effective_on")
        confirmed_by = _text(confirmed_by, "confirmed_by")
        with self._connect() as db:
            cursor = db.execute(
                """INSERT INTO clinician_goals
                   (profile_id, nutrient, amount, unit, effective_on, confirmed_by)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (profile_id, nutrient, amount, unit, effective_on, confirmed_by),
            )
            return cursor.lastrowid

    def get_profile(self, profile_id: int) -> dict | None:
        """Return stored records; goal values and units are not clinically or computationally validated."""
        profile_id = _profile_id(profile_id)
        with self._connect() as db:
            profile = db.execute(
                "SELECT id, name FROM patient_profiles WHERE id = ?", (profile_id,)
            ).fetchone()
            if profile is None:
                return None
            weights = db.execute(
                "SELECT measured_on, kilograms FROM dry_weights WHERE profile_id = ? ORDER BY measured_on, id",
                (profile_id,),
            ).fetchall()
            goals = db.execute(
                """SELECT nutrient, amount, unit, effective_on, confirmed_by
                   FROM clinician_goals WHERE profile_id = ? ORDER BY effective_on, id""",
                (profile_id,),
            ).fetchall()
            return {
                "id": profile["id"], "name": profile["name"],
                "dry_weights": [dict(row) for row in weights],
                "goals": [dict(row) for row in goals],
            }
