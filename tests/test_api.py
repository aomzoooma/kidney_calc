"""HTTP integration tests for the development-only application foundation."""

import unittest

from fastapi.testclient import TestClient

from api.main import app


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


if __name__ == '__main__':
    unittest.main()
