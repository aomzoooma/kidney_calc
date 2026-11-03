"""Tests for optional single-string, localhost-only food translation."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from auth_test_config import AuthTestClient
from api.main import app
from nutrition.local_translation import (
    DEFAULT_TRANSLATION_MODEL,
    LocalTranslationError,
    translate_food_text,
)


class LocalTranslationServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_sends_only_food_text_to_fixed_loopback_model_with_translation_prompt(self):
        captured = {"requests": []}

        def respond(request):
            captured["requests"].append(request)
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{
                    "name": f"{DEFAULT_TRANSLATION_MODEL}:latest", "size": 2_500_000_000,
                    "details": {"family": "gemma3", "quantization_level": "Q8_0"},
                }]})
            captured["url"] = str(request.url)
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"response": "chicken breast"})

        translation, model = await translate_food_text(
            "อกไก่", "en", transport=httpx.MockTransport(respond)
        )

        self.assertEqual(translation, "chicken breast")
        self.assertEqual(model, DEFAULT_TRANSLATION_MODEL)
        self.assertEqual(captured["url"], "http://127.0.0.1:11434/api/generate")
        self.assertEqual(captured["body"]["model"], DEFAULT_TRANSLATION_MODEL)
        self.assertEqual(captured["body"]["prompt"], "Translate the following text into English.\n\nอกไก่")
        self.assertFalse(captured["body"]["stream"])
        self.assertEqual(captured["body"]["options"], {"temperature": 0, "num_predict": 128})

    async def test_accepts_only_verified_model_alias_from_configuration(self):
        def respond(request):
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{
                    "name": f"{DEFAULT_TRANSLATION_MODEL}:latest", "size": 2_500_000_000,
                    "details": {"family": "gemma3", "quantization_level": "Q4_K_M"},
                }]})
            return httpx.Response(200, json={"response": "ไก่"})

        with patch.dict("os.environ", {"OLLAMA_TRANSLATION_MODEL": f"{DEFAULT_TRANSLATION_MODEL}:latest"}):
            translation, model = await translate_food_text(
                "chicken", "th", transport=httpx.MockTransport(respond)
            )
        self.assertEqual(translation, "ไก่")
        self.assertEqual(model, f"{DEFAULT_TRANSLATION_MODEL}:latest")

    async def test_rejects_bad_input_and_sanitizes_ollama_failure(self):
        with self.assertRaises(LocalTranslationError):
            await translate_food_text("   ", "en", transport=httpx.MockTransport(lambda _: None))
        with self.assertRaises(LocalTranslationError):
            await translate_food_text("x" * 301, "en", transport=httpx.MockTransport(lambda _: None))
        with self.assertRaises(LocalTranslationError):
            await translate_food_text("food", "xx", transport=httpx.MockTransport(lambda _: None))

        def fail(request):
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{
                    "name": DEFAULT_TRANSLATION_MODEL, "size": 2_500_000_000,
                    "details": {"family": "gemma3", "quantization_level": "Q4_K_M"},
                }]})
            raise httpx.ConnectError("sensitive request body must not leak", request=request)

        with self.assertRaisesRegex(LocalTranslationError, "did not respond") as caught:
            await translate_food_text("test food", "en", transport=httpx.MockTransport(fail))
        self.assertNotIn("sensitive", str(caught.exception))

    async def test_rejects_oversized_model_response(self):
        def respond(request):
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{
                    "name": DEFAULT_TRANSLATION_MODEL, "size": 2_500_000_000,
                    "details": {"family": "gemma3", "quantization_level": "Q4_K_M"},
                }]})
            return httpx.Response(200, json={"response": "x" * 16_500})

        with self.assertRaisesRegex(LocalTranslationError, "too large"):
            await translate_food_text("food", "en", transport=httpx.MockTransport(respond))

    async def test_rejects_cloud_alias_and_incompatible_model_metadata(self):
        called = False

        def respond(request):
            nonlocal called
            called = True
            return httpx.Response(200, json={"models": [{
                "name": "scb10x/typhoon-translate-4b:latest", "size": 2_500_000_000,
                "details": {"family": "gemma3", "quantization_level": "Q4_K_M"},
            }]})

        with patch.dict("os.environ", {"OLLAMA_TRANSLATION_MODEL": "scb10x/typhoon-translate-4b:cloud"}):
            with self.assertRaisesRegex(LocalTranslationError, "configuration"):
                await translate_food_text("food", "en", transport=httpx.MockTransport(respond))
        self.assertFalse(called)

        def wrong_signature(request):
            return httpx.Response(200, json={"models": [{
                "name": DEFAULT_TRANSLATION_MODEL, "size": 2_500_000_000,
                "details": {"family": "other", "quantization_level": "Q4_K_M"},
            }]})

        with self.assertRaisesRegex(LocalTranslationError, "not report the approved translator"):
            await translate_food_text("food", "en", transport=httpx.MockTransport(wrong_signature))

    async def test_overall_timeout_releases_single_translation_lock(self):
        class SlowStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                await asyncio.sleep(0.1)
                yield b'{"models": []}'

        with patch("nutrition.local_translation.REQUEST_DEADLINE_SECONDS", 0.01):
            with self.assertRaisesRegex(LocalTranslationError, "timed out"):
                await translate_food_text("food", "en", transport=httpx.MockTransport(
                    lambda request: httpx.Response(200, stream=SlowStream())
                ))

        def valid(request):
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{
                    "name": DEFAULT_TRANSLATION_MODEL, "size": 2_500_000_000,
                    "details": {"family": "gemma3", "quantization_level": "Q4_K_M"},
                }]})
            return httpx.Response(200, json={"response": "food"})

        translation, _ = await translate_food_text("food", "en", transport=httpx.MockTransport(valid))
        self.assertEqual(translation, "food")


class LocalTranslationApiTest(unittest.TestCase):
    def setUp(self):
        self.client = AuthTestClient(app)

    def test_accepts_only_text_and_direction_and_reports_loopback_transport(self):
        with patch("api.main.translate_food_text", new_callable=AsyncMock,
                   return_value=("chicken breast", DEFAULT_TRANSLATION_MODEL)) as translator:
            response = self.client.post("/experimental/local-food-translation", json={
                "text": "อกไก่", "target_language": "en",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "translation": "chicken breast", "target_language": "en",
            "model": DEFAULT_TRANSLATION_MODEL, "transport": "loopback",
        })
        translator.assert_awaited_once_with("อกไก่", "en")

    def test_rejects_patient_fields_invalid_direction_and_oversized_input(self):
        self.assertEqual(self.client.post("/experimental/local-food-translation", json={
            "text": "chicken", "target_language": "th", "patient_name": "synthetic",
        }).status_code, 422)
        self.assertEqual(self.client.post("/experimental/local-food-translation", json={
            "text": "food", "target_language": "fr",
        }).status_code, 422)
        self.assertEqual(self.client.post("/experimental/local-food-translation", json={
            "text": "x" * 301, "target_language": "th",
        }).status_code, 422)

    def test_local_model_failure_has_safe_error_response(self):
        with patch("api.main.translate_food_text", new_callable=AsyncMock,
                   side_effect=LocalTranslationError("Local translator did not respond; check Ollama and try again")):
            response = self.client.post("/experimental/local-food-translation", json={
                "text": "อกไก่", "target_language": "en",
            })
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("อกไก่", response.text)
