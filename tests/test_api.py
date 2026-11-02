"""HTTP integration tests for the development-only application foundation."""

import unittest
import os
import json
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import httpx

from fastapi.testclient import TestClient

from api.main import app, _demo_store


class HealthTest(unittest.TestCase):
    def test_health_and_unavailable_patient_route(self):
        with TestClient(app, client=("127.0.0.1", 12345), base_url="http://127.0.0.1") as client:
            response = client.get('/health')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {'status': 'ok'})
            self.assertEqual(client.get('/patients').status_code, 404)


class ExperimentalRecipeApiTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, client=("127.0.0.1", 12345), base_url="http://127.0.0.1")
        self.payload = {
            "synthetic_only": True,
            "portion": "0.5",
            "ingredients": [{
                "amount": "200",
                "unit": "g",
                "food_state": "cooked",
                "reference_quantity": "100",
                "reference_unit": "g",
                "reference_food_state": "cooked",
                "energy_kcal": "120",
                "sodium_mg": "0",
            }],
        }

    def test_calculates_portion_preserving_zero_and_unknown(self):
        response = self.client.post("/experimental/recipes/calculate", json=self.payload)
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertTrue(result["experimental"])
        self.assertFalse(result["clinical_use"])
        self.assertEqual(result["totals"]["energy_kcal"], {"value": "120.0", "complete": True})
        self.assertEqual(result["totals"]["sodium_mg"], {"value": "0.0", "complete": True})
        self.assertEqual(result["totals"]["protein_g"], {"value": None, "complete": False})

    def test_rejects_malformed_values_and_incomplete_attestation(self):
        for mutate in (
            lambda body: body.update(portion=0),
            lambda body: body.update(portion=1.01),
            lambda body: body["ingredients"][0].update(amount=-1),
            lambda body: body.update(synthetic_only=False),
            lambda body: body["ingredients"][0].update(person_name="not allowed"),
        ):
            body = {**self.payload, "ingredients": [dict(self.payload["ingredients"][0])]}
            mutate(body)
            self.assertEqual(self.client.post("/experimental/recipes/calculate", json=body).status_code, 422)

    def test_rejects_unit_or_food_state_mismatch(self):
        body = {**self.payload, "ingredients": [dict(self.payload["ingredients"][0])]}
        body["ingredients"][0]["reference_unit"] = "ml"
        self.assertEqual(self.client.post("/experimental/recipes/calculate", json=body).status_code, 422)

        body["ingredients"][0]["reference_unit"] = "g"
        body["ingredients"][0]["reference_food_state"] = "raw"
        self.assertEqual(self.client.post("/experimental/recipes/calculate", json=body).status_code, 422)

    def test_rejects_empty_recipe(self):
        body = {**self.payload, "ingredients": []}
        self.assertEqual(self.client.post("/experimental/recipes/calculate", json=body).status_code, 422)

    def test_rejects_non_loopback_clients(self):
        with TestClient(app, client=("192.0.2.1", 12345), base_url="http://127.0.0.1") as remote:
            response = remote.post("/experimental/recipes/calculate", json=self.payload)
        self.assertEqual(response.status_code, 403)

    def test_rejects_rebinding_host_and_nonlocal_origin(self):
        self.assertEqual(self.client.post(
            "/experimental/recipes/calculate", json=self.payload,
            headers={"host": "attacker.example"},
        ).status_code, 403)
        self.assertEqual(self.client.post(
            "/experimental/recipes/calculate", json=self.payload,
            headers={"origin": "https://attacker.example"},
        ).status_code, 403)

    def test_decimal_strings_preserve_decimal_calculation_and_reject_json_float(self):
        body = {
            "synthetic_only": True,
            "portion": "1",
            "ingredients": [{
                "amount": "3", "unit": "g", "food_state": "raw",
                "reference_quantity": "1", "reference_unit": "g", "reference_food_state": "raw",
                "protein_g": "0.1",
            }],
        }
        response = self.client.post("/experimental/recipes/calculate", json=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["totals"]["protein_g"]["value"], "0.3")
        body["ingredients"][0]["protein_g"] = 0.1
        self.assertEqual(self.client.post("/experimental/recipes/calculate", json=body).status_code, 422)

    def test_rejects_extreme_decimal_exponents_without_server_error(self):
        body = {**self.payload, "ingredients": [dict(self.payload["ingredients"][0])]}
        body["ingredients"][0]["energy_kcal"] = "1e999999"
        response = self.client.post("/experimental/recipes/calculate", json=body)
        self.assertEqual(response.status_code, 422)

    def test_rejects_origin_port_mismatch_and_malformed_host_authority(self):
        for headers in (
            {"host": "127.0.0.1:8000", "origin": "http://127.0.0.1:8001"},
            {"host": "user@localhost"},
            {"host": "localhost:notaport"},
        ):
            response = self.client.post(
                "/experimental/recipes/calculate", json=self.payload, headers=headers
            )
            self.assertEqual(response.status_code, 403)

    def test_usda_search_uses_backend_key_and_returns_source_state(self):
        seen = {}

        def handle(request):
            seen['key'] = request.url.params.get('api_key')
            seen['body'] = request.read()
            return httpx.Response(200, json={'totalPages': 1, 'totalHits': 1, 'foods': [{
                'fdcId': 77, 'dataType': 'Foundation', 'publishedDate': '2026-01-01',
                'description': 'Rice, brown, cooked',
            }]})

        transport = httpx.Client(transport=httpx.MockTransport(handle))
        with patch.dict(os.environ, {'USDA_FDC_API_KEY': 'server-secret'}), \
                patch('nutrition.usda_fdc.httpx.Client', return_value=transport):
            response = self.client.get('/experimental/usda/search', params={'q': 'brown rice'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(seen['key'], 'server-secret')
        self.assertNotIn('server-secret', response.text)
        self.assertEqual(json.loads(seen['body'])['dataType'], ['Foundation', 'SR Legacy'])
        self.assertEqual(response.json()['items'][0]['food_state'], 'cooked')
        self.assertEqual(response.json()['items'][0]['source_id'], 'USDA-FDC:77')
        self.assertNotIn('api_key', str(seen['body']))
        transport.close()

    def test_usda_calculation_resolves_nutrients_on_server_and_ignores_client_state(self):
        def handle(request):
            return httpx.Response(200, json={
                'fdcId': 77, 'dataType': 'Foundation', 'description': 'Rice, brown, cooked',
                'foodNutrients': [
                    {'nutrient': {'id': 1008, 'unitName': 'kcal'}, 'amount': 111},
                    {'nutrient': {'id': 1003, 'unitName': 'g'}, 'amount': 2.6},
                ],
            })

        transport = httpx.Client(transport=httpx.MockTransport(handle))
        body = {'synthetic_only': True, 'portion': '1', 'ingredients': [{
            'amount': '100', 'unit': 'g', 'food_state': 'raw', 'reference_quantity': '100',
            'reference_unit': 'g', 'reference_food_state': 'raw', 'source_type': 'usda', 'fdc_id': 77,
            'energy_kcal': None, 'protein_g': None, 'sodium_mg': None,
            'potassium_mg': None, 'phosphorus_mg': None,
        }]}
        with patch.dict(os.environ, {'USDA_FDC_API_KEY': 'server-secret'}), \
                patch('nutrition.usda_fdc.httpx.Client', return_value=transport):
            response = self.client.post('/experimental/recipes/calculate', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        totals = response.json()['totals']
        self.assertEqual(totals['energy_kcal']['value'], '111')
        self.assertEqual(totals['protein_g']['value'], '2.6')
        self.assertFalse(totals['sodium_mg']['complete'])
        transport.close()

    def test_unknown_usda_preparation_blocks_calculation_and_client_nutrients_are_rejected(self):
        body = {'synthetic_only': True, 'portion': '1', 'ingredients': [{
            'amount': '100', 'unit': 'g', 'food_state': 'raw', 'reference_quantity': '100',
            'reference_unit': 'g', 'reference_food_state': 'raw', 'source_type': 'usda', 'fdc_id': 77,
        }]}
        transport = httpx.Client(transport=httpx.MockTransport(lambda _req: httpx.Response(200, json={
            'fdcId': 77, 'dataType': 'Foundation', 'description': 'Rice', 'foodNutrients': [],
        })))
        with patch.dict(os.environ, {'USDA_FDC_API_KEY': 'server-secret'}), \
                patch('nutrition.usda_fdc.httpx.Client', return_value=transport):
            response = self.client.post('/experimental/recipes/calculate', json=body)
        self.assertEqual(response.status_code, 422)
        body['ingredients'][0]['energy_kcal'] = '99'
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=body).status_code, 422)
        transport.close()

    def test_usda_source_requires_selected_id_and_forbids_client_values(self):
        ingredient = {
            'amount': '100', 'unit': 'g', 'food_state': 'raw', 'reference_quantity': '100',
            'reference_unit': 'g', 'reference_food_state': 'raw', 'source_type': 'usda',
        }
        body = {'synthetic_only': True, 'portion': '1', 'ingredients': [ingredient]}
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=body).status_code, 422)
        ingredient['fdc_id'] = 77
        ingredient['protein_g'] = '3'
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=body).status_code, 422)

    def test_server_rejects_branded_fdc_id_even_when_submitted_directly(self):
        transport = httpx.Client(transport=httpx.MockTransport(lambda _req: httpx.Response(200, json={
            'fdcId': 77, 'dataType': 'Branded', 'description': 'Rice, Product X', 'foodNutrients': [],
        })))
        body = {'synthetic_only': True, 'portion': '1', 'ingredients': [{
            'amount': '100', 'unit': 'g', 'food_state': 'as_sold', 'reference_quantity': '100',
            'reference_unit': 'g', 'reference_food_state': 'as_sold', 'source_type': 'usda', 'fdc_id': 77,
        }]}
        with patch.dict(os.environ, {'USDA_FDC_API_KEY': 'server-secret'}), \
                patch('nutrition.usda_fdc.httpx.Client', return_value=transport):
            response = self.client.post('/experimental/recipes/calculate', json=body)
        self.assertEqual(response.status_code, 422)
        self.assertIn('unbranded USDA', response.json()['detail'])
        transport.close()


class LocalThaiIngredientSearchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / 'synthetic-local.db'
        self.env = patch.dict(os.environ, {'KIDNEY_EXPERIMENTAL_DB': str(self.db_path)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(app, client=('127.0.0.1', 12345), base_url='http://127.0.0.1')
        self.store = _demo_store().ingredients
        self.reviewed_id = self.store.create_ingredient('ข้าวสมมติ')
        self.reviewed_version = self.store.add_version(
            self.reviewed_id, version='synthetic-v1', provider='user-entered',
            source_version='reviewed fixture', retrieved_on='2026-11-02',
            source_reference='synthetic test record', provenance='synthetic user-reviewed fixture',
            basis_quantity=Decimal('100'), basis_unit='g', food_state='cooked', reviewed=True,
            nutrients={'energy_kcal': Decimal('123'), 'sodium_mg': Decimal('0')})
        unreviewed_id = self.store.create_ingredient('ข้าวสมมติไม่ตรวจ')
        self.store.add_version(
            unreviewed_id, version='draft-v1', provider='user-entered', source_version='draft',
            retrieved_on='2026-11-02', source_reference='synthetic draft', provenance='synthetic draft',
            basis_quantity=Decimal('100'), basis_unit='g', food_state='cooked', reviewed=False,
            nutrients={'energy_kcal': Decimal('900')})

    def test_search_is_local_thai_and_only_returns_reviewed_versions(self):
        with patch('api.main.USDAFDCClient') as usda:
            response = self.client.get('/experimental/ingredients/search', params={'q': 'ข้าวสมมติ'})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['local_only'])
        items = response.json()['items']
        self.assertEqual([item['version_id'] for item in items], [self.reviewed_version])
        self.assertEqual(items[0]['food_state'], 'cooked')
        self.assertEqual(items[0]['nutrients']['energy_kcal'], '123')
        usda.assert_not_called()
        self.assertEqual(self.client.get('/experimental/ingredients/search', params={'q': '   '}).status_code, 422)

    def test_calculation_resolves_saved_version_server_side(self):
        body = {'synthetic_only': True, 'portion': '1', 'ingredients': [{
            'amount': '50', 'unit': 'g', 'food_state': 'cooked',
            'reference_quantity': '1', 'reference_unit': 'g', 'reference_food_state': 'raw',
            'source_type': 'saved', 'ingredient_version_id': self.reviewed_version,
        }]}
        response = self.client.post('/experimental/recipes/calculate', json=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['totals']['energy_kcal'], {'value': '61.5', 'complete': True})
        self.assertEqual(response.json()['totals']['sodium_mg'], {'value': '0', 'complete': True})
        self.assertEqual(response.json()['saved_sources'][0]['version_id'], self.reviewed_version)

        body['ingredients'][0]['energy_kcal'] = '999'
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=body).status_code, 422)
        body['ingredients'][0].pop('energy_kcal')
        body['ingredients'][0]['food_state'] = 'raw'
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=body).status_code, 422)
        body['ingredients'][0]['food_state'] = 'cooked'
        body['ingredients'][0]['ingredient_version_id'] = 99999
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=body).status_code, 422)
        body['ingredients'][0]['ingredient_version_id'] = self.reviewed_version
        body['ingredients'][0]['source_type'] = 'manual'
        self.assertEqual(self.client.post('/experimental/recipes/calculate', json=body).status_code, 422)


if __name__ == '__main__':
    unittest.main()
