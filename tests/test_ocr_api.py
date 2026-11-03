import base64
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from auth_test_config import AuthTestClient
from api.main import app
from api.ocr import OCRResult, OCRServiceError


class OCRApiTest(unittest.TestCase):
    def setUp(self):
        self.client = AuthTestClient(app)
        self.payload = {'synthetic_only': True, 'content_type': 'image/png', 'image_base64': base64.b64encode(b'test').decode()}

    def test_result_is_untrusted_and_never_saved(self):
        with patch('api.main.ocr_image', new=AsyncMock(return_value=OCRResult('TEST ONLY'))) as mock:
            result = self.client.post('/experimental/ocr', json=self.payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['text'], 'TEST ONLY')
        self.assertTrue(result.json()['requires_human_review'])
        self.assertFalse(result.json()['clinical_use'])
        self.assertIsNone(result.json()['suggestions']['nutrients']['sodium_mg'])
        mock.assert_awaited_once_with(b'test', 'image/png')

    def test_ambiguous_html_header_row_produces_no_api_suggestion(self):
        ocr_text = """
<table>
<tr><td>Serving size 30 g</td></tr>
<tr><td>Sodium 10 mg</td><td>Nutrition per serving</td></tr>
<tr><td>Sodium</td><td>80 mg</td></tr>
</table>
"""
        with patch('api.main.ocr_image', new=AsyncMock(return_value=OCRResult(ocr_text))):
            result = self.client.post('/experimental/ocr', json=self.payload)
        self.assertEqual(result.status_code, 200)
        suggestions = result.json()['suggestions']
        self.assertTrue(all(value is None for value in suggestions['nutrients'].values()))
        self.assertIsNone(suggestions['basis_quantity'])
        self.assertIsNone(suggestions['basis_unit'])
        self.assertTrue(result.json()['suggestions']['requires_human_review'])

    def test_html_text_outside_cells_produces_no_api_suggestion(self):
        ocr_text = """
<table>
<tr><th>Nutrition per serving</th></tr>
<tr>Sodium 10 mg</tr>
<tr><td>Sodium</td><td>80 mg</td></tr>
</table>
"""
        with patch('api.main.ocr_image', new=AsyncMock(return_value=OCRResult(ocr_text))):
            result = self.client.post('/experimental/ocr', json=self.payload)
        self.assertEqual(result.status_code, 200)
        suggestions = result.json()['suggestions']
        self.assertTrue(all(value is None for value in suggestions['nutrients'].values()))
        self.assertIsNone(suggestions['basis_quantity'])
        self.assertIsNone(suggestions['basis_unit'])

    def test_rejects_bad_input_and_sanitizes_errors(self):
        for payload in ({**self.payload, 'synthetic_only': False}, {**self.payload, 'image_base64': '%%%'}):
            self.assertEqual(self.client.post('/experimental/ocr', json=payload).status_code, 422)
        with patch('api.main.ocr_image', new=AsyncMock(side_effect=OCRServiceError('private content'))):
            result = self.client.post('/experimental/ocr', json=self.payload)
        self.assertEqual(result.status_code, 422)
        self.assertNotIn('private content', result.text)

    def test_rejects_oversized_stream_and_remote_host(self):
        self.assertEqual(self.client.post('/experimental/ocr', content=b'x' * (12 * 1024 * 1024), headers={'content-type': 'application/json'}).status_code, 413)
        self.assertEqual(self.client.post('/experimental/ocr', content='{}', headers={'content-type': 'text/plain'}).status_code, 415)
        self.assertEqual(self.client.post('/experimental/ocr', json=self.payload, headers={'host': 'example.com'}).status_code, 403)
