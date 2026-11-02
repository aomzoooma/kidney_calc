import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.main import app


class ManualIngredientApiTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        database = Path(self.temp.name) / 'synthetic-local.db'
        self.env = patch.dict(os.environ, {'KIDNEY_EXPERIMENTAL_DB': str(database)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(app, client=('127.0.0.1', 12345), base_url='http://127.0.0.1')
        self.payload = {
            'synthetic_only': True, 'reviewed': True, 'name': 'ข้าวทดสอบ',
            'provider': 'Synthetic publisher', 'source_version': 'fixture-v1',
            'source_date': '2026-01-02', 'source_reference': 'synthetic page 4',
            'provenance': 'synthetic manual transcription', 'basis_quantity': '100',
            'basis_unit': 'g', 'food_state': 'cooked',
            'nutrients': {'energy_kcal': None, 'protein_g': None, 'sodium_mg': '0',
                          'potassium_mg': None, 'phosphorus_mg': None},
        }

    def test_saved_reviewed_source_is_searchable_and_calculates_from_exact_version(self):
        saved = self.client.post('/experimental/ingredients', json=self.payload)
        self.assertEqual(saved.status_code, 200)
        item, = self.client.get('/experimental/ingredients/search', params={'q': 'ข้าวทดสอบ'}).json()['items']
        self.assertEqual(item['version_id'], saved.json()['version_id'])
        self.assertEqual(item['provider'], 'Synthetic publisher')
        self.assertEqual(item['source_version'], 'fixture-v1')
        self.assertEqual(item['source_date'], '2026-01-02')
        self.assertEqual(item['source_reference'], 'synthetic page 4')
        self.assertEqual(item['provenance'], 'synthetic manual transcription')
        self.assertEqual((item['basis_quantity'], item['basis_unit'], item['food_state']), ('100', 'g', 'cooked'))
        self.assertTrue(item['reviewed'])
        self.assertIsNone(item['nutrients']['energy_kcal'])
        self.assertEqual(item['nutrients']['sodium_mg'], '0')

        calculation = self.client.post('/experimental/recipes/calculate', json={
            'synthetic_only': True, 'portion': '1', 'ingredients': [{
                'amount': '50', 'unit': 'g', 'food_state': 'cooked',
                'reference_quantity': '100', 'reference_unit': 'g', 'reference_food_state': 'cooked',
                'source_type': 'saved', 'ingredient_version_id': saved.json()['version_id'],
            }],
        })
        self.assertEqual(calculation.status_code, 200)
        totals = calculation.json()['totals']
        self.assertEqual(totals['energy_kcal'], {'value': None, 'complete': False})
        self.assertEqual(totals['sodium_mg'], {'value': '0', 'complete': True})

    def test_rejects_unreviewed_or_non_synthetic_records_without_saving(self):
        for change in ({'reviewed': False}, {'synthetic_only': False},
                       {'provider': '   '}, {'source_reference': ''},
                       {'food_state': 'unknown'}, {'basis_quantity': '0'}):
            with self.subTest(change=change):
                response = self.client.post('/experimental/ingredients', json={**self.payload, **change})
                self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.get('/experimental/ingredients/search', params={'q': 'ข้าวทดสอบ'}).json()['items'], [])

    def test_rejects_wrong_content_type_and_oversized_request(self):
        self.assertEqual(self.client.post('/experimental/ingredients', content='{}',
                                          headers={'content-type': 'text/plain'}).status_code, 415)
        self.assertEqual(self.client.post('/experimental/ingredients', content=' ' * 32769,
                                          headers={'content-type': 'application/json'}).status_code, 413)


if __name__ == '__main__':
    unittest.main()
