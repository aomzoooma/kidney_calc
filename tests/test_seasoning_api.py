import tempfile
import sqlite3
from concurrent.futures import ThreadPoolExecutor
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from api.main import app, _demo_store, _suggestions
from api.ocr import OCRResult


class SeasoningApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict('os.environ', {'KIDNEY_EXPERIMENTAL_DB': str(Path(self.tmp.name) / 'demo.db')})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(app, client=('127.0.0.1', 1234), base_url='http://127.0.0.1')
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
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda _: _demo_store().list(), range(8)))
        self.assertEqual(results, [[]] * 8)

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
