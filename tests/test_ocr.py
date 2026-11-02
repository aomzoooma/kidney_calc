"""Synthetic-only tests for the local OCR client; no model or image files used."""

import json
import struct
import unittest
import zlib
from io import BytesIO
from unittest.mock import patch

import httpx
from PIL import Image

import api.ocr as ocr
from api.ocr import (
    MAX_IMAGE_BYTES,
    MODEL,
    OCR_PROMPT,
    OLLAMA_URL,
    OCRServiceError,
    ocr_image,
)


def png_bytes(size=(1, 1)):
    image = Image.new("RGB", size, color=(1, 2, 3))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def synthetic_png(width, height):
    """Valid grayscale PNG, including compressed pixel data, generated in memory."""
    rows = (b"\0" + b"\0" * width) * height
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header)
            + png_chunk(b"IDAT", zlib.compress(rows)) + png_chunk(b"IEND", b""))


def client_for(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)


class OCRClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_sends_fixed_model_official_prompt_and_image_to_loopback(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["payload"] = json.loads(request.content)
            return httpx.Response(200, json={"choices": [{"message": {"content": "untrusted OCR"}}]})

        async with client_for(handler) as client:
            result = await ocr_image(png_bytes(), "image/png", client=client)

        payload = seen["payload"]
        self.assertEqual(seen["url"], OLLAMA_URL)
        self.assertEqual(payload["model"], MODEL)
        self.assertEqual(payload["messages"][0]["content"][0]["text"], OCR_PROMPT)
        self.assertTrue(payload["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(result.text, "untrusted OCR")
        self.assertTrue(result.requires_human_review)
        self.assertFalse(result.clinical_evidence)

    async def test_rejects_unsupported_mismatched_empty_and_oversize_images(self):
        too_wide = synthetic_png(10001, 1)
        over_pixel_limit = synthetic_png(5000, 4001)
        with Image.open(BytesIO(too_wide)) as valid_large_dimension_image:
            valid_large_dimension_image.load()
        with Image.open(BytesIO(over_pixel_limit)) as valid_decompression_bomb_image:
            valid_decompression_bomb_image.load()
        async with client_for(lambda request: self.fail("invalid input reached transport")) as client:
            for image, mime in ((png_bytes(), "image/webp"), (png_bytes(), "image/jpeg"), (b"", "image/png"),
                                (b"\x89PNG\r\n\x1a\n" + b"x" * MAX_IMAGE_BYTES, "image/png"),
                                (b"\x89PNG\r\n\x1a\nbroken", "image/png"),
                                (too_wide, "image/png"),
                                (over_pixel_limit, "image/png")):
                with self.subTest(mime=mime, length=len(image)), self.assertRaises(OCRServiceError):
                    await ocr_image(image, mime, client=client)

    async def test_rejects_redirects_and_oversize_responses(self):
        async with client_for(lambda request: httpx.Response(307, headers={"location": "http://example.com"})) as client:
            with self.assertRaisesRegex(OCRServiceError, "redirects"):
                await ocr_image(png_bytes(), "image/png", client=client)

        def large_response(request):
            return httpx.Response(200, content=b" " * (1024 * 1024 + 1))

        async with client_for(large_response) as client:
            with self.assertRaisesRegex(OCRServiceError, "response exceeds"):
                await ocr_image(png_bytes(), "image/png", client=client)

    async def test_sanitizes_transport_and_malformed_response_errors(self):
        async with client_for(lambda request: httpx.Response(500, text="private diagnostic")) as client:
            with self.assertRaisesRegex(OCRServiceError, "request failed") as raised:
                await ocr_image(png_bytes(), "image/png", client=client)
        self.assertNotIn("private diagnostic", str(raised.exception))

        async with client_for(lambda request: httpx.Response(200, json={"choices": []})) as client:
            with self.assertRaises(OCRServiceError):
                await ocr_image(png_bytes(), "image/png", client=client)

    async def test_enforces_total_request_deadline(self):
        async def slow_handler(request):
            import asyncio
            await asyncio.sleep(0.05)
            return httpx.Response(200, json={"choices": [{"message": {"content": "late"}}]})

        with patch.object(ocr, "REQUEST_DEADLINE_SECONDS", 0.001):
            async with client_for(slow_handler) as client:
                with self.assertRaisesRegex(OCRServiceError, "150-second deadline"):
                    await ocr_image(png_bytes(), "image/png", client=client)


if __name__ == "__main__":
    unittest.main()
