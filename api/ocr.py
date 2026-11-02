"""Local-only experimental OCR client. Results are untrusted and never saved here."""

from __future__ import annotations

import asyncio
import base64
import json
import warnings
from dataclasses import dataclass
from io import BytesIO

import httpx
from PIL import Image, UnidentifiedImageError


OLLAMA_URL = "http://127.0.0.1:11434/v1/chat/completions"
MODEL = "scb10x/typhoon-ocr1.5-3b"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_IMAGE_DIMENSION = 10_000
MAX_RESPONSE_BYTES = 1024 * 1024
REQUEST_DEADLINE_SECONDS = 150
OCR_PROMPT = """Extract all text from the image.

Instructions:
- Only return the clean Markdown.
- Do not include any explanation or extra text.
- You must include all information on the page.

Formatting Rules:
- Tables: Render tables using <table>...</table> in clean HTML format.
- Equations: Render equations using LaTeX syntax with inline ($...$) and block ($$...$$).
- Images/Charts/Diagrams: Wrap any clearly defined visual areas (e.g. charts, diagrams, pictures) in:

<figure>
Describe the image's main elements (people, objects, text), note any contextual clues (place, event, culture), mention visible text and its meaning, provide deeper analysis when relevant (especially for financial charts, graphs, or documents), comment on style or architecture if relevant, then give a concise overall summary. Describe in Thai.
</figure>
- Page Numbers: Wrap page numbers in <page_number>...</page_number> (e.g., <page_number>14</page_number>).
- Checkboxes: Use ☐ for unchecked and ☑ for checked boxes."""


@dataclass(frozen=True)
class OCRResult:
    """Raw untrusted model text; caller must display for human review before parsing."""

    text: str
    requires_human_review: bool = True
    clinical_evidence: bool = False


class OCRServiceError(ValueError):
    """Safe-to-display OCR input or local-service error; contains no payload data."""


def _validate_image(image: bytes, content_type: str) -> None:
    signatures = {
        "image/png": b"\x89PNG\r\n\x1a\n",
        "image/jpeg": b"\xff\xd8\xff",
    }
    if content_type not in signatures:
        raise OCRServiceError("Only PNG and JPEG images are supported")
    if not isinstance(image, bytes) or not image or len(image) > MAX_IMAGE_BYTES:
        raise OCRServiceError("Image is empty or exceeds the 8 MiB limit")
    if not image.startswith(signatures[content_type]):
        raise OCRServiceError("Image content does not match its declared type")
    expected_format = {"image/png": "PNG", "image/jpeg": "JPEG"}[content_type]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(image)) as decoded:
                if decoded.format != expected_format:
                    raise OCRServiceError("Image content does not match its declared type")
                _validate_dimensions(decoded.size)
                if getattr(decoded, "n_frames", 1) != 1:
                    raise OCRServiceError("Animated images are not supported")
                decoded.verify()
            with Image.open(BytesIO(image)) as decoded:
                _validate_dimensions(decoded.size)
                decoded.load()
    except OCRServiceError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning,
            OSError, ValueError, SyntaxError) as exc:
        raise OCRServiceError("Image is invalid, truncated, or unsafe to decode") from exc


def _validate_dimensions(size: tuple[int, int]) -> None:
    width, height = size
    if (width < 1 or height < 1 or width > MAX_IMAGE_DIMENSION
            or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS):
        raise OCRServiceError("Image dimensions exceed supported limits")


async def ocr_image(image: bytes, content_type: str, *, client: httpx.AsyncClient | None = None) -> OCRResult:
    """Call fixed loopback Ollama; output may infer content and needs human review."""
    # Official prompt asks for contextual figure descriptions; OCR text is not ground truth.
    # This HTTP deadline does not cover bounded synchronous image decode or base64 encoding.
    _validate_image(image, content_type)
    data_url = f"data:{content_type};base64,{base64.b64encode(image).decode('ascii')}"
    payload = {
        "model": MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": OCR_PROMPT},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }],
        "stream": False,
    }

    async def request(transport: httpx.AsyncClient) -> OCRResult:
        async def send() -> OCRResult:
            async with transport.stream(
                "POST", OLLAMA_URL, json=payload,
                follow_redirects=False,
                timeout=httpx.Timeout(connect=5, read=120, write=15, pool=5),
            ) as response:
                if response.is_redirect:
                    raise OCRServiceError("Local OCR service redirects are not allowed")
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise OCRServiceError("Local OCR response exceeds size limit")
            decoded = json.loads(body)
            text = decoded["choices"][0]["message"]["content"]
            if not isinstance(text, str) or not text.strip():
                raise OCRServiceError("Local OCR returned no text")
            return OCRResult(text=text)

        try:
            return await asyncio.wait_for(send(), timeout=REQUEST_DEADLINE_SECONDS)
        except OCRServiceError:
            raise
        except asyncio.TimeoutError as exc:
            raise OCRServiceError("Local OCR request exceeded its 150-second deadline") from exc
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
            raise OCRServiceError("Local OCR request failed or returned an invalid response") from exc

    if client is not None:
        return await request(client)
    async with httpx.AsyncClient(follow_redirects=False, trust_env=False) as local_client:
        return await request(local_client)
