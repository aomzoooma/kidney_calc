import tempfile
import sqlite3
import os
from concurrent.futures import ThreadPoolExecutor
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from auth_test_config import AuthTestClient
from api.main import app, _demo_store, _suggestions
from api.ocr import OCRResult
from nutrition.seasonings import SeasoningStore


class SeasoningApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict('os.environ', {'KIDNEY_EXPERIMENTAL_DB': str(Path(self.tmp.name) / 'demo.db')})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = AuthTestClient(app)
        self.payload = {'synthetic_only': True, 'reviewed': True, 'name': 'ตัวอย่าง', 'brand': None,
                        'basis_quantity': '15', 'basis_unit': 'ml',
                        'nutrients': {'sodium_mg': '0', 'protein_g': None}}

    def test_reviewed_seasoning_is_saved_and_unknown_remains_unknown(self):
        result = self.client.post('/experimental/seasonings', json=self.payload)
        self.assertEqual(result.status_code, 200)
        item, = self.client.get('/experimental/seasonings').json()['items']
        self.assertEqual(item['version_id'], result.json()['version_id'])
        self.assertEqual(item['nutrients']['sodium_mg'], '0')
        self.assertIsNone(item['nutrients']['protein_g'])
        self.assertTrue(item['reviewed'])

    def test_recipe_reuses_exact_saved_version_from_server(self):
        saved = self.client.post('/experimental/seasonings', json=self.payload).json()
        positive = self.client.post('/experimental/seasonings', json={
            **self.payload, 'name': 'อีกตัวอย่าง', 'nutrients': {'sodium_mg': '5', 'protein_g': None},
        }).json()
        ingredient = {
            'amount': '30', 'unit': 'ml', 'food_state': 'as_sold',
            'reference_quantity': '1', 'reference_unit': 'ml', 'reference_food_state': 'as_sold',
            'seasoning_version_id': saved['version_id'],
            'sodium_mg': '999999', 'protein_g': '999999',
        }
        result = self.client.post('/experimental/recipes/calculate', json={
            'synthetic_only': True, 'portion': '1', 'ingredients': [
                ingredient, {**ingredient, 'seasoning_version_id': positive['version_id']},
            ],
        })
        self.assertEqual(result.status_code, 200)
        totals = result.json()['totals']
        self.assertEqual(totals['sodium_mg'], {'value': '10', 'complete': True})
        self.assertEqual(totals['protein_g'], {'value': None, 'complete': False})

    def test_recipe_rejects_unknown_version_and_basis_mismatch(self):
        saved = self.client.post('/experimental/seasonings', json=self.payload).json()
        base = {
            'amount': '15', 'unit': 'ml', 'food_state': 'as_sold',
            'reference_quantity': '15', 'reference_unit': 'ml', 'reference_food_state': 'as_sold',
            'seasoning_version_id': saved['version_id'],
        }
        recipe = {'synthetic_only': True, 'portion': '1', 'ingredients': [base]}
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=recipe).status_code, 200)
        recipe['ingredients'] = [{**base, 'seasoning_version_id': 999999}]
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=recipe).status_code, 422)
        recipe['ingredients'] = [{**base, 'unit': 'g'}]
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=recipe).status_code, 422)

    def test_persisted_recipe_reuses_exact_reviewed_seasoning_with_metadata_and_unknowns(self):
        seasoning = self.client.post('/experimental/seasonings', json={
            **self.payload, 'name': 'Mom chili paste', 'brand': 'Mom brand',
            'nutrients': {'sodium_mg': '120', 'protein_g': None},
        }).json()
        recipe = self.client.post('/experimental/recipes', json={
            'synthetic_only': True, 'name': 'Synthetic meal', 'ingredients': [{
                'seasoning_version_id': seasoning['version_id'],
                'amount': '7.5', 'unit': 'ml', 'food_state': 'as_sold',
            }],
        })
        self.assertEqual(recipe.status_code, 200, recipe.text)
        recipe_id = recipe.json()['id']
        loaded = self.client.get(f'/experimental/recipes/{recipe_id}')
        self.assertEqual(loaded.status_code, 200)
        ingredient, = loaded.json()['ingredients']
        self.assertEqual(ingredient['ingredient_version_id'], seasoning['version_id'])
        self.assertEqual(ingredient['seasoning_version_id'], seasoning['version_id'])
        self.assertEqual(ingredient['ingredient_name'], 'Mom chili paste')
        self.assertEqual(ingredient['brand'], 'Mom brand')
        self.assertEqual((ingredient['basis_quantity'], ingredient['basis_unit']), ('15', 'ml'))
        self.assertEqual((ingredient['amount'], ingredient['unit'], ingredient['food_state']),
                         ('7.5', 'ml', 'as_sold'))
        self.assertTrue(ingredient['reviewed'])
        self.assertEqual(ingredient['provider'], 'Mom brand')
        self.assertEqual(ingredient['provenance'], 'user-entered label')
        self.assertEqual(ingredient['source_reference'], 'synthetic test label')
        self.assertEqual(ingredient['sodium_mg'], '120')
        self.assertIsNone(ingredient['protein_g'])

        calculated = self.client.post(f'/experimental/recipes/{recipe_id}/calculate', json={
            'synthetic_only': True, 'portion': '1',
        })
        self.assertEqual(calculated.status_code, 200)
        self.assertEqual(calculated.json()['totals']['sodium_mg'], {'value': '60.0', 'complete': True})
        self.assertEqual(calculated.json()['totals']['protein_g'], {'value': None, 'complete': False})

        with sqlite3.connect(Path(self.tmp.name) / 'demo.db') as db:
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM ingredient_versions WHERE id = ?',
                (seasoning['version_id'],),
            ).fetchone()[0], 1)

    def test_persisted_recipe_rejects_unreviewed_or_mismatched_seasoning_without_write(self):
        seasoning = self.client.post('/experimental/seasonings', json=self.payload).json()
        base = {'seasoning_version_id': seasoning['version_id'], 'amount': '7.5',
                'unit': 'ml', 'food_state': 'as_sold'}
        for ingredient in (
            {**base, 'unit': 'g'},
            {**base, 'food_state': 'cooked'},
            {**base, 'seasoning_version_id': 999999},
            {**base, 'patient_id': 'synthetic-only-not-accepted'},
            {**base, 'nutrients': {'sodium_mg': '999'}},
            {**base, 'ingredient_version_id': seasoning['version_id']},
        ):
            response = self.client.post('/experimental/recipes', json={
                'synthetic_only': True, 'name': 'Invalid meal', 'ingredients': [ingredient],
            })
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.get('/experimental/recipes').json()['items'], [])

    def test_recipe_output_for_existing_ingredient_has_no_seasoning_brand_or_alias(self):
        ingredient = self.client.post('/experimental/ingredients', json={
            'synthetic_only': True, 'reviewed': True, 'name': 'Synthetic rice',
            'provider': 'Synthetic source', 'source_version': 'fixture-v1',
            'source_reference': 'synthetic reference', 'provenance': 'synthetic fixture',
            'basis_quantity': '100', 'basis_unit': 'g', 'food_state': 'cooked',
            'nutrients': {'sodium_mg': None},
        }).json()
        recipe = self.client.post('/experimental/recipes', json={
            'synthetic_only': True, 'name': 'Rice', 'ingredients': [{
                'ingredient_version_id': ingredient['version_id'],
                'amount': '25', 'unit': 'g', 'food_state': 'cooked',
            }],
        })
        self.assertEqual(recipe.status_code, 200, recipe.text)
        row, = self.client.get(f"/experimental/recipes/{recipe.json()['id']}").json()['ingredients']
        self.assertIsNone(row['seasoning_version_id'])
        self.assertIsNone(row['brand'])
        self.assertEqual(row['provenance'], 'synthetic fixture')

    def test_rejects_unreviewed_real_or_invalid_data(self):
        for change in ({'reviewed': False}, {'synthetic_only': False}, {'basis_quantity': '0'}):
            self.assertEqual(self.client.post('/experimental/seasonings', json={**self.payload, **change}).status_code, 422)
        self.assertEqual(self.client.get('/experimental/seasonings').json()['items'], [])

    def test_suggestions_preserve_basis_and_ambiguity(self):
        result = _suggestions('Serving size 15 ml\nNutrition per serving\nSodium 120 mg\nProtein 0 g')
        self.assertEqual((result['basis_quantity'], result['basis_unit']), ('15', 'ml'))
        self.assertEqual(result['nutrients']['sodium_mg'], '120')
        self.assertIsNone(result['nutrients']['potassium_mg'])
        self.assertTrue(result['requires_human_review'])
        ambiguous = _suggestions('Nutrition per serving\nSodium 10 mg\nSodium 1,000 mg')
        self.assertIsNone(ambiguous['nutrients']['sodium_mg'])

    def test_mixed_bases_do_not_autofill(self):
        result = _suggestions('Energy 5 kcal per 100 g\nSodium 100 mg per serving')
        self.assertTrue(result['basis_conflict'])
        self.assertIsNone(result['basis_quantity'])
        self.assertTrue(all(value is None for value in result['nutrients'].values()))
        headers = _suggestions('Nutrition per 100 g\nEnergy 5 kcal\nNutrition per serving\nSodium 100 mg')
        self.assertTrue(headers['basis_conflict'])
        self.assertTrue(all(value is None for value in headers['nutrients'].values()))

    def test_large_or_wrong_content_type_rejected_before_parse(self):
        self.assertEqual(self.client.post('/experimental/seasonings', content=b'x' * 32769,
            headers={'content-type': 'application/json'}).status_code, 413)
        self.assertEqual(self.client.post('/experimental/seasonings', content='{}',
            headers={'content-type': 'text/plain'}).status_code, 415)

    def test_existing_unrelated_database_is_not_changed(self):
        path = Path(self.tmp.name) / 'real.db'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE private_record (value TEXT)')
            db.execute("INSERT INTO private_record VALUES ('kept')")
        with patch.dict('os.environ', {'KIDNEY_EXPERIMENTAL_DB': str(path)}):
            self.assertEqual(self.client.get('/experimental/seasonings').status_code, 503)
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('SELECT value FROM private_record').fetchone(), ('kept',))
            self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE name = 'seasoning_brands'").fetchone()[0], 0)

    def test_concurrent_initialization_uses_complete_marker(self):
        with patch('api.main.SeasoningStore', wraps=SeasoningStore) as store_factory:
            with ThreadPoolExecutor(max_workers=4) as executor:
                stores = list(executor.map(lambda _: _demo_store(), range(8)))
            self.assertEqual(store_factory.call_count, 1)
        self.assertTrue(all(store is stores[0] for store in stores))
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda store: store.list(), stores))
        self.assertEqual(results, [[]] * 8)

    def test_replaced_marker_database_reinitializes_cached_store(self):
        path = Path(self.tmp.name) / 'demo.db'
        original_store = _demo_store()
        replacement = Path(self.tmp.name) / 'replacement.db'
        with sqlite3.connect(replacement) as db:
            db.execute('CREATE TABLE experimental_demo_marker (marker TEXT NOT NULL)')
            db.execute("INSERT INTO experimental_demo_marker VALUES ('synthetic-only-v1')")
        os.replace(replacement, path)

        replacement_store = _demo_store()
        self.assertIsNot(replacement_store, original_store)
        self.assertEqual(replacement_store.list(), [])

    def test_ordinary_database_write_reuses_cached_store(self):
        store = _demo_store()
        response = self.client.post('/experimental/seasonings', json=self.payload)
        self.assertEqual(response.status_code, 200)
        self.assertIs(_demo_store(), store)

    def test_ocr_suggestions_require_review_before_persisting(self):
        raw = 'Serving size 15 ml\nNutrition per serving\nSodium 120 mg\nProtein 0 g'
        with patch('api.main.ocr_image', new=AsyncMock(return_value=OCRResult(raw))):
            response = self.client.post('/experimental/ocr', json={
                'synthetic_only': True, 'content_type': 'image/png', 'image_base64': 'dGVzdA=='})
        self.assertEqual(response.status_code, 200)
        suggestions = response.json()['suggestions']
        self.assertTrue(response.json()['requires_human_review'])
        self.assertEqual(self.client.get('/experimental/seasonings').json()['items'], [])
        reviewed = {**self.payload, 'basis_quantity': suggestions['basis_quantity'],
                    'basis_unit': suggestions['basis_unit'], 'nutrients': suggestions['nutrients']}
        self.assertEqual(self.client.post('/experimental/seasonings', json={**reviewed, 'reviewed': False}).status_code, 422)
        self.assertEqual(self.client.post('/experimental/seasonings', json=reviewed).status_code, 200)
        item, = self.client.get('/experimental/seasonings').json()['items']
        self.assertEqual(item['nutrients']['sodium_mg'], '120')
        self.assertEqual(item['nutrients']['protein_g'], '0')
        self.assertIsNone(item['nutrients']['potassium_mg'])
