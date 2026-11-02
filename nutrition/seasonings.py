"""Reviewed, versioned seasoning records; no HTTP access or clinical validation."""

from decimal import Decimal

from nutrition.calculator import NUTRIENTS
from nutrition.ingredients import IngredientStore, _day, _decimal, _text


class SeasoningStore:
    def __init__(self, database):
        self.ingredients = IngredientStore(database)
        with self.ingredients._connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS seasoning_brands (
                ingredient_id INTEGER PRIMARY KEY REFERENCES ingredients(id),
                brand TEXT NOT NULL
            )""")
            db.execute("""CREATE TRIGGER IF NOT EXISTS seasoning_brands_no_update
                BEFORE UPDATE ON seasoning_brands BEGIN SELECT RAISE(ABORT, 'immutable'); END""")
            db.execute("""CREATE TRIGGER IF NOT EXISTS seasoning_brands_no_delete
                BEFORE DELETE ON seasoning_brands BEGIN SELECT RAISE(ABORT, 'immutable'); END""")
            db.execute("""CREATE TRIGGER IF NOT EXISTS seasoning_brands_no_replace
                BEFORE INSERT ON seasoning_brands WHEN EXISTS
                (SELECT 1 FROM seasoning_brands WHERE ingredient_id = NEW.ingredient_id)
                BEGIN SELECT RAISE(ABORT, 'immutable'); END""")

    def create_reviewed(self, *, name, brand, basis_quantity, basis_unit, nutrients,
                        reviewed, retrieved_on, source_reference):
        if reviewed is not True:
            raise ValueError('User review is required')
        name = _text(name, 'name')
        if brand is not None and not isinstance(brand, str):
            raise ValueError('brand must be text or None')
        brand = brand.strip() if brand else ''
        retrieved_on = _day(retrieved_on, 'retrieved_on')
        source_reference = _text(source_reference, 'source_reference')
        basis = _decimal(basis_quantity, 'basis_quantity', positive=True)
        if basis_unit not in ('g', 'ml'):
            raise ValueError('basis_unit must be g or ml')
        if not isinstance(nutrients, dict) or set(nutrients) - set(NUTRIENTS):
            raise ValueError('Unsupported nutrients')
        values = [_decimal(nutrients.get(key), key) for key in NUTRIENTS]
        columns = ', '.join(f'"{key}"' for key in NUTRIENTS)
        placeholders = ', '.join('?' for _ in NUTRIENTS)
        with self.ingredients._connect() as db:
            ingredient_id = db.execute('INSERT INTO ingredients(name) VALUES (?)', (name,)).lastrowid
            db.execute('INSERT INTO seasoning_brands(ingredient_id, brand) VALUES (?, ?)', (ingredient_id, brand))
            version_id = db.execute(f'''INSERT INTO ingredient_versions
                (ingredient_id, version, provider, source_version, retrieved_on, source_reference,
                 provenance, basis_quantity, basis_unit, food_state, reviewed, {columns})
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, {placeholders})''',
                (ingredient_id, '1', brand or 'user-entered', 'user-reviewed label', retrieved_on, source_reference,
                 'user-entered label', basis, basis_unit, 'as_sold', 1, *values)).lastrowid
        return {'ingredient_id': ingredient_id, 'version_id': version_id}

    def list(self):
        with self.ingredients._connect() as db:
            rows = db.execute('''SELECT i.id AS ingredient_id, v.id AS version_id, i.name, b.brand,
                v.basis_quantity, v.basis_unit, v.reviewed, v.provenance, v.source_reference,
                v.retrieved_on, v.energy_kcal, v.protein_g, v.sodium_mg,
                v.potassium_mg, v.phosphorus_mg FROM ingredients i
                JOIN seasoning_brands b ON b.ingredient_id = i.id
                JOIN ingredient_versions v ON v.ingredient_id = i.id ORDER BY i.name, v.id''').fetchall()
        return [{**{key: row[key] for key in ('ingredient_id', 'version_id', 'name', 'basis_quantity', 'basis_unit', 'provenance', 'source_reference', 'retrieved_on')},
                 'brand': row['brand'] or None,
                 'reviewed': bool(row['reviewed']),
                 'nutrients': {key: row[key] for key in NUTRIENTS}} for row in rows]
