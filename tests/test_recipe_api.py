"""Synthetic-only recipe persistence API integration tests."""

import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.main import app, _demo_store
from nutrition.profiles import ProfileStore
from nutrition.recipes import RecipeStore
from nutrition.tracking import MealTrackingStore


class RecipeApiTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict('os.environ', {'KIDNEY_EXPERIMENTAL_DB': str(Path(self.temp.name) / 'synthetic.db')})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(app, client=('127.0.0.1', 1234), base_url='http://127.0.0.1')
        self.rice = self.save_ingredient('Rice', '100', {'protein_g': '4', 'sodium_mg': '0'})
        self.sauce = self.save_ingredient('Sauce', '10', {'protein_g': None, 'sodium_mg': '20'})

    def save_ingredient(self, name, basis, nutrients):
        response = self.client.post('/experimental/ingredients', json={
            'synthetic_only': True, 'reviewed': True, 'name': name,
            'provider': 'Synthetic provider', 'source_version': 'fixture-v1',
            'source_reference': 'synthetic fixture', 'provenance': 'synthetic test input',
            'basis_quantity': basis, 'basis_unit': 'g', 'food_state': 'cooked',
            'nutrients': nutrients,
        })
        self.assertEqual(response.status_code, 200)
        return response.json()

    def recipe_payload(self):
        return {
            'synthetic_only': True, 'name': 'Synthetic rice meal', 'ingredients': [
                {'ingredient_version_id': self.rice['version_id'], 'amount': '50', 'unit': 'g', 'food_state': 'cooked'},
                {'ingredient_version_id': self.sauce['version_id'], 'amount': '5', 'unit': 'g', 'food_state': 'cooked'},
            ],
        }

    def test_recipe_create_reload_update_calculate_and_delete(self):
        created = self.client.post('/experimental/recipes', json=self.recipe_payload())
        self.assertEqual(created.status_code, 200)
        recipe_id = created.json()['id']
        self.assertEqual(created.json()['name'], 'Synthetic rice meal')
        self.assertTrue(created.json()['saved'])
        self.assertEqual(self.client.get('/experimental/recipes').json()['items'], [
            {'id': recipe_id, 'name': 'Synthetic rice meal', 'favorite': False},
        ])

        loaded = self.client.get(f'/experimental/recipes/{recipe_id}')
        self.assertEqual(loaded.status_code, 200)
        self.assertEqual(loaded.json()['ingredients'][0]['protein_g'], '4')
        self.assertIsNone(loaded.json()['ingredients'][1]['protein_g'])
        self.assertEqual(loaded.json()['ingredients'][1]['sodium_mg'], '20')

        updated = self.client.patch(f'/experimental/recipes/{recipe_id}', json={
            'synthetic_only': True, 'name': 'Renamed meal', 'favorite': True,
        })
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()['updated_fields'], {'name': 'Renamed meal', 'favorite': True})
        reloaded = self.client.get(f'/experimental/recipes/{recipe_id}').json()
        self.assertEqual((reloaded['name'], reloaded['favorite']), ('Renamed meal', True))

        calculated = self.client.post(f'/experimental/recipes/{recipe_id}/calculate', json={
            'synthetic_only': True, 'portion': '0.5',
        })
        self.assertEqual(calculated.status_code, 200)
        self.assertEqual(calculated.json()['totals']['sodium_mg'], {'value': '5.0', 'complete': True})
        self.assertEqual(calculated.json()['totals']['protein_g'], {'value': '1.0', 'complete': False})

        deleted = self.client.delete(f'/experimental/recipes/{recipe_id}', params={'synthetic_only': 'true'})
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.client.get(f'/experimental/recipes/{recipe_id}').status_code, 404)

    def test_recent_recipes_tracks_only_explicit_opens_and_points_to_current_recipe(self):
        first = self.client.post('/experimental/recipes', json=self.recipe_payload()).json()['id']
        second = self.client.post('/experimental/recipes', json={
            **self.recipe_payload(), 'name': 'Second synthetic meal',
        }).json()['id']
        self.assertEqual(self.client.get('/experimental/recipes/recent').json()['items'], [])

        self.assertEqual(self.client.post(f'/experimental/recipes/{first}/calculate', json={
            'synthetic_only': True, 'portion': '0.5',
        }).status_code, 200)
        self.assertEqual(self.client.get('/experimental/recipes/recent').json()['items'], [])

        opened = self.client.post(f'/experimental/recipes/{first}/open', json={'synthetic_only': True})
        self.assertEqual(opened.status_code, 200)
        self.assertEqual(opened.json()['recipe_id'], first)
        self.assertEqual(opened.json()['history_type'], 'explicit_open')
        self.assertTrue(opened.json()['recorded'])
        self.client.patch(f'/experimental/recipes/{first}', json={
            'synthetic_only': True, 'name': 'Current renamed meal', 'favorite': True,
        })
        self.client.post(f'/experimental/recipes/{second}/open', json={'synthetic_only': True})
        self.client.post(f'/experimental/recipes/{first}/open', json={'synthetic_only': True})

        recent = self.client.get('/experimental/recipes/recent').json()
        self.assertEqual(recent['history_type'], 'explicit_open')
        self.assertEqual([item['recipe_id'] for item in recent['items']], [first, second])
        self.assertEqual(recent['items'][0]['name'], 'Current renamed meal')
        self.assertTrue(recent['items'][0]['favorite'])
        self.assertIn('opened_at', recent['items'][0])
        self.assertTrue(recent['experimental'])
        # New store instance reads same persistent DB; no browser/session identity is stored.
        self.assertEqual(RecipeStore(Path(os.environ['KIDNEY_EXPERIMENTAL_DB']))
                         .list_recent_recipes()[0]['recipe_id'], first)

    def test_recent_recipes_missing_and_deleted_ids_are_safe(self):
        recipe_id = self.client.post('/experimental/recipes', json=self.recipe_payload()).json()['id']
        open_url = f'/experimental/recipes/{recipe_id}/open'
        self.assertEqual(self.client.post(open_url).status_code, 422)
        self.assertEqual(self.client.post(open_url, json={'synthetic_only': False}).status_code, 422)
        self.assertEqual(self.client.post(open_url, json={
            'synthetic_only': True, 'patient_id': 12,
        }).status_code, 422)
        self.assertEqual(self.client.get('/experimental/recipes/recent').json()['items'], [])
        self.assertEqual(self.client.post('/experimental/recipes/999999/open',
                                          json={'synthetic_only': True}).status_code, 404)
        self.assertEqual(self.client.post('/experimental/recipes/0/open',
                                          json={'synthetic_only': True}).status_code, 422)
        self.assertEqual(self.client.post(open_url, json={'synthetic_only': True}).status_code, 200)
        self.assertEqual(self.client.delete(f'/experimental/recipes/{recipe_id}',
                                             params={'synthetic_only': 'true'}).status_code, 204)
        self.assertEqual(self.client.get('/experimental/recipes/recent').json()['items'], [])

    def test_recipe_replacement_is_atomic_and_exact_versions_are_retained(self):
        recipe_id = self.client.post('/experimental/recipes', json=self.recipe_payload()).json()['id']
        replacement = {'synthetic_only': True, 'ingredients': [
            {'ingredient_version_id': self.sauce['version_id'], 'amount': '3', 'unit': 'g', 'food_state': 'cooked'},
        ]}
        changed = self.client.put(f'/experimental/recipes/{recipe_id}/ingredients', json=replacement)
        self.assertEqual(changed.status_code, 200)
        self.assertTrue(changed.json()['ingredients_updated'])
        self.assertEqual([item['ingredient_version_id'] for item in
                          self.client.get(f'/experimental/recipes/{recipe_id}').json()['ingredients']],
                         [self.sauce['version_id']])
        replacement['ingredients'][0]['ingredient_version_id'] = 999999
        self.assertEqual(self.client.put(f'/experimental/recipes/{recipe_id}/ingredients', json=replacement).status_code, 422)
        reloaded = self.client.get(f'/experimental/recipes/{recipe_id}').json()
        self.assertEqual([item['ingredient_version_id'] for item in reloaded['ingredients']], [self.sauce['version_id']])

    def test_write_ack_survives_post_commit_read_failure(self):
        with patch.object(RecipeStore, 'get_recipe', side_effect=sqlite3.OperationalError('read must not happen')):
            response = self.client.post('/experimental/recipes', json=self.recipe_payload())
            self.assertEqual(response.status_code, 200)
            recipe_id = response.json()['id']
            updated = self.client.patch(f'/experimental/recipes/{recipe_id}', json={
                'synthetic_only': True, 'name': 'Read failure safe',
            })
            self.assertEqual(updated.status_code, 200)
            replaced = self.client.put(f'/experimental/recipes/{recipe_id}/ingredients', json={
                'synthetic_only': True, 'ingredients': self.recipe_payload()['ingredients'],
            })
            self.assertEqual(replaced.status_code, 200)
        self.assertTrue(self.client.get(f'/experimental/recipes/{recipe_id}').json()['ingredients'])

    def test_update_ack_survives_concurrent_delete_after_commit(self):
        recipe_id = self.client.post('/experimental/recipes', json=self.recipe_payload()).json()['id']
        original = RecipeStore.update_recipe

        def update_then_delete(store, target_id, **changes):
            original(store, target_id, **changes)
            store.delete_recipe(target_id)

        with patch.object(RecipeStore, 'update_recipe', update_then_delete):
            response = self.client.patch(f'/experimental/recipes/{recipe_id}', json={
                'synthetic_only': True, 'name': 'Updated before concurrent delete',
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['id'], recipe_id)

    def test_recipe_requests_reject_non_synthetic_and_untrusted_source_fields(self):
        payload = self.recipe_payload()
        self.assertEqual(self.client.post('/experimental/recipes', json={**payload, 'synthetic_only': False}).status_code, 422)
        self.assertEqual(self.client.post('/experimental/recipes', json={
            **payload, 'ingredients': [{**payload['ingredients'][0], 'sodium_mg': '999'}],
        }).status_code, 422)
        self.assertEqual(self.client.post('/experimental/recipes', json={
            **payload, 'ingredients': [{**payload['ingredients'][0], 'ingredient_version_id': 999999}],
        }).status_code, 422)
        ingredients = _demo_store().ingredients
        ingredient_id = ingredients.create_ingredient('Unreviewed synthetic source')
        version_id = ingredients.add_version(
            ingredient_id, version='1', provider='Synthetic provider', source_version='fixture-v1',
            retrieved_on='2026-11-03', source_reference='synthetic fixture',
            provenance='synthetic test input', basis_quantity=Decimal('100'), basis_unit='g',
            food_state='cooked', reviewed=False, nutrients={'sodium_mg': Decimal('2')},
        )
        unreviewed = {**payload, 'ingredients': [{
            'ingredient_version_id': version_id, 'amount': '10', 'unit': 'g', 'food_state': 'cooked',
        }]}
        self.assertEqual(self.client.post('/experimental/recipes', json=unreviewed).status_code, 422)

    def test_delete_requires_experimental_flag_and_preserves_tracked_history(self):
        recipe_id = self.client.post('/experimental/recipes', json=self.recipe_payload()).json()['id']
        self.assertEqual(self.client.delete(f'/experimental/recipes/{recipe_id}').status_code, 422)
        self.assertEqual(self.client.delete(f'/experimental/recipes/{recipe_id}',
                                            params={'synthetic_only': 'false'}).status_code, 422)

        database = Path(os.environ['KIDNEY_EXPERIMENTAL_DB'])
        profile_id = ProfileStore(database).create_profile('Synthetic profile')
        MealTrackingStore(database).record_consumption(
            profile_id, recipe_id, datetime.now(timezone.utc), Decimal('0.5'),
        )
        response = self.client.delete(f'/experimental/recipes/{recipe_id}',
                                      params={'synthetic_only': 'true'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.client.get(f'/experimental/recipes/{recipe_id}').status_code, 200)


if __name__ == '__main__':
    unittest.main()
