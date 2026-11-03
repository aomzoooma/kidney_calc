"""HTTP integration tests for the development-only application foundation."""

import unittest
import os
import json
import sqlite3
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import httpx

from fastapi.testclient import TestClient

from api.main import app, _demo_store
from nutrition.usda_fdc import USDAFDCError


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

    def test_usda_snapshot_is_server_resolved_reviewed_and_idempotent(self):
        food = {
            'fdc_id': 77, 'source_type': 'Foundation', 'source_version': '2026-01-01',
            'description': 'Rice, brown, cooked', 'food_state': 'cooked',
            'nutrients': {'energy_kcal': Decimal('111'), 'protein_g': Decimal('2.6'),
                          'sodium_mg': None, 'potassium_mg': None, 'phosphorus_mg': None},
        }
        preview_request = {'synthetic_only': True, 'fdc_id': 77}
        with patch('api.main.USDAFDCClient') as client:
            client.return_value.get_food.return_value = food
            preview = self.client.post('/experimental/ingredients/usda/preview', json=preview_request)
            self.assertEqual(preview.status_code, 200, preview.text)
            self.assertEqual(preview.json()['name'], food['description'])
            self.assertEqual(preview.json()['source_type'], 'Foundation')
            self.assertEqual(preview.json()['food_state'], 'cooked')
            request = {'synthetic_only': True, 'reviewed': True, 'fdc_id': 77,
                       'food_state': 'cooked', 'snapshot_digest': preview.json()['snapshot_digest']}
            first = self.client.post('/experimental/ingredients/usda', json=request)
            second = self.client.post('/experimental/ingredients/usda', json=request)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json()['version_id'], second.json()['version_id'])
        self.assertTrue(first.json()['reviewed'])
        self.assertEqual(first.json()['source_version'], '2026-01-01')
        self.assertEqual(first.json()['source_date'], '2026-01-01')
        self.assertEqual(first.json()['basis_quantity'], '100')
        self.assertEqual(first.json()['nutrients']['energy_kcal'], '111')
        self.assertIsNone(first.json()['nutrients']['sodium_mg'])
        saved = self.store.get_reviewed_version(first.json()['version_id'])
        self.assertEqual(saved['provider'], 'USDA FoodData Central')
        self.assertEqual(saved['food_state'], 'cooked')
        self.assertEqual(saved['nutrients']['protein_g'], Decimal('2.6'))
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM ingredient_versions WHERE provider = ?',
                                        ('USDA FoodData Central',)).fetchone()[0], 1)
        client.return_value.get_food.assert_called()
        client.return_value.get_food.assert_called_with(77)

    def test_usda_snapshot_rejects_unconfirmed_or_client_supplied_values(self):
        request = {'synthetic_only': True, 'reviewed': True, 'fdc_id': 77,
                   'food_state': 'cooked', 'snapshot_digest': '0' * 64}
        for mutation in (
            lambda body: body.update(synthetic_only=False),
            lambda body: body.update(reviewed=False),
            lambda body: body.update(protein_g='999'),
            lambda body: body.update(source_type='Branded'),
        ):
            body = dict(request)
            mutation(body)
            self.assertEqual(self.client.post('/experimental/ingredients/usda', json=body).status_code, 422)

        food = {'fdc_id': 77, 'source_type': 'Foundation', 'source_version': '2026-01-01',
                'description': 'Rice, brown, cooked', 'food_state': 'cooked', 'nutrients': {}}
        with patch('api.main.USDAFDCClient') as client:
            client.return_value.get_food.return_value = food
            body = {**request, 'food_state': 'raw'}
            response = self.client.post('/experimental/ingredients/usda', json=body)
        self.assertEqual(response.status_code, 409)
        self.assertIn('record changed', response.json()['detail'])

    def test_usda_snapshot_rejects_changed_detail_after_preview(self):
        preview_food = {'fdc_id': 77, 'source_type': 'Foundation', 'source_version': '2026-01-01',
                        'description': 'Rice, brown, cooked', 'food_state': 'cooked',
                        'nutrients': {'energy_kcal': Decimal('111')}}
        changed_food = {**preview_food, 'description': 'Rice, brown, boiled',
                        'nutrients': {'energy_kcal': Decimal('112')}}
        with patch('api.main.USDAFDCClient') as client:
            client.return_value.get_food.side_effect = [preview_food, changed_food]
            preview = self.client.post('/experimental/ingredients/usda/preview', json={
                'synthetic_only': True, 'fdc_id': 77,
            })
            response = self.client.post('/experimental/ingredients/usda', json={
                'synthetic_only': True, 'reviewed': True, 'fdc_id': 77,
                'food_state': 'cooked', 'snapshot_digest': preview.json()['snapshot_digest'],
            })
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.store.search_reviewed('Rice, brown'), [])

    def test_usda_snapshot_rejects_branded_records_and_returns_safe_upstream_errors(self):
        request = {'synthetic_only': True, 'reviewed': True, 'fdc_id': 77,
                   'food_state': 'cooked', 'snapshot_digest': '0' * 64}
        with patch('api.main.USDAFDCClient') as client:
            client.return_value.get_food.return_value = {
                'fdc_id': 77, 'source_type': 'Branded', 'description': 'Product',
                'food_state': 'as_sold', 'nutrients': {},
            }
            response = self.client.post('/experimental/ingredients/usda/preview', json={
                'synthetic_only': True, 'fdc_id': 77,
            })
        self.assertEqual(response.status_code, 422)

        with patch('api.main.USDAFDCClient') as client:
            client.return_value.get_food.side_effect = USDAFDCError('USDA request failed or timed out')
            response = self.client.post('/experimental/ingredients/usda', json=request)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('api_key', response.text)

    def test_usda_preview_requires_experimental_storage_before_network(self):
        with patch.dict(os.environ, {'KIDNEY_EXPERIMENTAL_DB': ''}), \
                patch('api.main.USDAFDCClient') as client:
            response = self.client.post('/experimental/ingredients/usda/preview', json={
                'synthetic_only': True, 'fdc_id': 77,
            })
        self.assertEqual(response.status_code, 503)
        client.assert_not_called()


class ExperimentalProfileApiTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / 'synthetic-profiles.sqlite'
        self.env = patch.dict(os.environ, {'KIDNEY_EXPERIMENTAL_DB': str(self.db_path)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(app, client=('127.0.0.1', 12345), base_url='http://127.0.0.1')

    def test_synthetic_profile_goals_and_weights_survive_reload_in_experimental_db(self):
        created = self.client.post('/experimental/profiles', json={
            'synthetic_only': True, 'name': 'ตัวอย่าง ก',
        })
        self.assertEqual(created.status_code, 200, created.text)
        profile_id = created.json()['id']
        empty = self.client.get(f'/experimental/profiles/{profile_id}').json()
        self.assertEqual(empty['goals'], [])
        self.assertEqual(empty['dry_weights'], [])
        self.assertFalse(empty['clinical_use'])

        goal = self.client.post(f'/experimental/profiles/{profile_id}/goals', json={
            'synthetic_only': True, 'clinician_set': True, 'nutrient': 'โซเดียม',
            'amount': '1800', 'unit': 'มก./วัน', 'effective_on': '2026-11-01',
        })
        self.assertEqual(goal.status_code, 200, goal.text)
        self.assertEqual(goal.json(), {
            'goal_id': 1, 'profile_id': profile_id, 'saved': True,
            'synthetic_only': True, 'clinical_use': False,
        })
        weight = self.client.post(f'/experimental/profiles/{profile_id}/dry-weights', json={
            'synthetic_only': True, 'measured_on': '2026-11-02', 'kilograms': '62.5',
        })
        self.assertEqual(weight.status_code, 200, weight.text)
        self.assertEqual(weight.json(), {
            'weight_id': 1, 'profile_id': profile_id, 'saved': True,
            'synthetic_only': True, 'clinical_use': False,
        })

        reloaded = self.client.get(f'/experimental/profiles/{profile_id}').json()
        self.assertEqual(reloaded['goals'][0]['amount'], 1800)
        self.assertEqual(reloaded['goals'][0]['confirmed_by'], 'Synthetic clinician-set goal')
        self.assertEqual(reloaded['dry_weights'][0], {'measured_on': '2026-11-02', 'kilograms': 62.5})
        self.assertEqual(self.client.get('/experimental/profiles').json()['items'], [
            {'id': profile_id, 'name': 'ตัวอย่าง ก'},
        ])

        with sqlite3.connect(self.db_path) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({'experimental_demo_marker', 'ingredients', 'patient_profiles', 'clinician_goals', 'dry_weights'} <= tables)

    def test_profile_endpoints_reject_missing_synthetic_confirmation_and_extra_identity_fields(self):
        for payload in (
            {'name': 'synthetic'},
            {'synthetic_only': True, 'name': 'synthetic', 'patient_identifier': '123'},
        ):
            self.assertEqual(self.client.post('/experimental/profiles', json=payload).status_code, 422)
        created = self.client.post('/experimental/profiles', json={'synthetic_only': True, 'name': 'synthetic'})
        profile_id = created.json()['id']
        goal = {'synthetic_only': True, 'nutrient': 'sodium', 'amount': '0', 'unit': 'mg/day',
                'effective_on': '2026-11-01'}
        self.assertEqual(self.client.post(f'/experimental/profiles/{profile_id}/goals', json=goal).status_code, 422)
        self.assertEqual(self.client.post('/experimental/profiles/0/goals', json={**goal, 'clinician_set': True}).status_code, 422)
        self.assertEqual(self.client.get('/experimental/profiles/98765').status_code, 404)

    def test_profile_routes_leave_unmarked_database_untouched(self):
        with sqlite3.connect(self.db_path) as db:
            db.execute('CREATE TABLE unrelated_records (value TEXT)')
            db.execute("INSERT INTO unrelated_records VALUES ('keep')")
        response = self.client.get('/experimental/profiles')
        self.assertEqual(response.status_code, 503)
        with sqlite3.connect(self.db_path) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(db.execute('SELECT value FROM unrelated_records').fetchone(), ('keep',))
        self.assertEqual(tables, {'unrelated_records'})


class ExperimentalMealApiTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / 'synthetic-meals.sqlite'
        self.env = patch.dict(os.environ, {'KIDNEY_EXPERIMENTAL_DB': str(self.db_path)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(app, client=('127.0.0.1', 12345), base_url='http://127.0.0.1')
        profile = self.client.post('/experimental/profiles', json={
            'synthetic_only': True, 'name': 'Synthetic meal profile',
        })
        self.profile_id = profile.json()['id']
        ingredient = self.client.post('/experimental/ingredients', json={
            'synthetic_only': True, 'reviewed': True, 'name': 'Synthetic rice',
            'provider': 'Synthetic fixture', 'source_version': 'fixture-v1',
            'source_reference': 'synthetic://rice', 'provenance': 'test only',
            'basis_quantity': '100', 'basis_unit': 'g', 'food_state': 'cooked',
            'nutrients': {'energy_kcal': '130', 'sodium_mg': '0'},
        })
        self.version_id = ingredient.json()['version_id']
        recipe = self.client.post('/experimental/recipes', json={
            'synthetic_only': True, 'name': 'Synthetic bowl', 'ingredients': [{
                'ingredient_version_id': self.version_id, 'amount': '100',
                'unit': 'g', 'food_state': 'cooked',
            }],
        })
        self.recipe_id = recipe.json()['id']

    def test_record_list_and_totals_use_bangkok_day_and_snapshot(self):
        body = {'synthetic_only': True, 'recipe_id': self.recipe_id,
                'consumed_at': '2026-01-03T17:30:00Z', 'portion': '0.5'}
        saved = self.client.post(f'/experimental/profiles/{self.profile_id}/meals', json=body)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json(), {'id': 1, 'profile_id': self.profile_id, 'recipe_id': self.recipe_id,
                                        'saved': True, 'synthetic_only': True, 'clinical_use': False})
        self.assertTrue(saved.json()['synthetic_only'])

        self.client.put(f'/experimental/recipes/{self.recipe_id}/ingredients', json={
            'synthetic_only': True, 'ingredients': [{
                'ingredient_version_id': self.version_id, 'amount': '200',
                'unit': 'g', 'food_state': 'cooked',
            }],
        })
        history = self.client.get(f'/experimental/profiles/{self.profile_id}/meals?day=2026-01-04&limit=10')
        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.json()['items'][0]['ingredients'][0]['amount'], '100')
        daily = self.client.get(f'/experimental/profiles/{self.profile_id}/meals/daily?day=2026-01-04')
        self.assertEqual(daily.json()['totals']['energy_kcal'], {'value': '65.0', 'complete': True})
        weekly = self.client.get(f'/experimental/profiles/{self.profile_id}/meals/weekly?day=2026-01-04')
        self.assertEqual((weekly.json()['start_date'], weekly.json()['end_date']), ('2025-12-29', '2026-01-04'))

    def test_record_requires_synthetic_attestation_timezone_and_fraction(self):
        path = f'/experimental/profiles/{self.profile_id}/meals'
        valid = {'synthetic_only': True, 'recipe_id': self.recipe_id,
                 'consumed_at': '2026-01-03T17:30:00Z', 'portion': '1'}
        for body in (
            {key: value for key, value in valid.items() if key != 'synthetic_only'},
            {**valid, 'synthetic_only': False},
            {**valid, 'patient_id': 'unexpected'},
            {**valid, 'consumed_at': '2026-01-03T17:30:00'},
            {**valid, 'consumed_at': 0},
            {**valid, 'consumed_at': '0'},
            {**valid, 'recipe_id': 9223372036854775808},
            {**valid, 'portion': '0'},
            {**valid, 'portion': '1.01'},
        ):
            self.assertEqual(self.client.post(path, json=body).status_code, 422)
        offset = self.client.post(path, json={**valid, 'consumed_at': '2026-01-04T00:30:00+09:00'})
        self.assertEqual(offset.status_code, 200, offset.text)
        self.assertTrue(offset.json()['saved'])
        self.assertEqual(offset.json()['id'], 1)

    def test_invalid_profile_or_day_rejected(self):
        path = '/experimental/profiles/98765/meals?day=2026-01-04'
        self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.client.get(
            f'/experimental/profiles/{self.profile_id}/meals?day=2026-02-30').status_code, 422)
        self.assertEqual(self.client.get(
            '/experimental/profiles/9223372036854775808/meals?day=2026-01-04').status_code, 422)
        self.assertEqual(self.client.get(
            f'/experimental/profiles/{self.profile_id}/meals/weekly?day=9999-12-31').status_code, 422)

    def test_fresh_profile_can_read_empty_history_and_totals(self):
        fresh_db = Path(self.temp.name) / 'fresh-synthetic.sqlite'
        with patch.dict(os.environ, {'KIDNEY_EXPERIMENTAL_DB': str(fresh_db)}):
            created = self.client.post('/experimental/profiles', json={
                'synthetic_only': True, 'name': 'Fresh synthetic profile',
            })
            profile_id = created.json()['id']
            history = self.client.get(f'/experimental/profiles/{profile_id}/meals?day=2026-01-04')
            totals = self.client.get(f'/experimental/profiles/{profile_id}/meals/daily?day=2026-01-04')
        self.assertEqual(history.status_code, 200, history.text)
        self.assertEqual(history.json()['items'], [])
        self.assertEqual(totals.status_code, 200, totals.text)
        self.assertEqual(totals.json()['entry_count'], 0)


if __name__ == '__main__':
    unittest.main()
