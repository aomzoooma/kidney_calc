"""HTTP integration tests for the development-only application foundation."""

import unittest

from fastapi.testclient import TestClient

from api.main import app


class HealthTest(unittest.TestCase):
    def test_health_and_unavailable_patient_route(self):
        with TestClient(app) as client:
            response = client.get('/health')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {'status': 'ok'})
            self.assertEqual(client.get('/patients').status_code, 404)


if __name__ == '__main__':
    unittest.main()
