"""Optional localhost-only translation of a single food name at a time."""

from __future__ import annotations

import asyncio
import json
import os
import re

import httpx


OLLAMA_CHAT_URL = "http://127.0.0.1:11434/api/generate"
OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"
DEFAULT_TRANSLATION_MODEL = "scb10x/typhoon-translate-4b"
SUPPORTED_LOCAL_TRANSLATION_MODELS = {
    DEFAULT_TRANSLATION_MODEL,
    f"{DEFAULT_TRANSLATION_MODEL}:latest",
}
MAX_TRANSLATION_TEXT = 300
MAX_RESPONSE_BYTES = 16 * 1024
MAX_MODEL_LIST_BYTES = 1024 * 1024
REQUEST_DEADLINE_SECONDS = 30
_MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$")
_translation_lock = asyncio.Lock()


class LocalTranslationError(Exception):
    """A safe, user-facing local translation failure."""


def _translation_model() -> str:
    model = os.environ.get("OLLAMA_TRANSLATION_MODEL", DEFAULT_TRANSLATION_MODEL).strip()
    if not _MODEL_NAME.fullmatch(model) or model not in SUPPORTED_LOCAL_TRANSLATION_MODELS:
        raise LocalTranslationError("Local translator configuration is invalid")
    return model


async def _read_json_response(response: httpx.Response, max_bytes: int) -> dict:
    if response.status_code != 200:
        raise LocalTranslationError("Local translator is unavailable; check Ollama and the selected model")
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > max_bytes:
            raise LocalTranslationError("Local translator response was too large")
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise LocalTranslationError("Local translator returned an invalid response") from None
    if not isinstance(payload, dict):
        raise LocalTranslationError("Local translator returned an invalid response")
    return payload


async def _ensure_model_is_installed(client: httpx.AsyncClient, model: str) -> None:
    async with client.stream("GET", OLLAMA_TAGS_URL) as response:
        payload = await _read_json_response(response, MAX_MODEL_LIST_BYTES)
    models = payload.get("models")
    if not isinstance(models, list):
        raise LocalTranslationError("Ollama did not report its installed models")
    requested = model.lower()
    aliases = {requested}
    if ":" not in requested:
        aliases.add(f"{requested}:latest")
    for entry in models:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name") or entry.get("model")
        size = entry.get("size")
        details = entry.get("details")
        if (isinstance(name, str) and name.lower() in aliases and isinstance(size, int)
                and size > 0 and isinstance(details, dict)
                and details.get("family") == "gemma3"):
            return
    raise LocalTranslationError("Ollama did not report the approved translator as installed and compatible")


async def _translate_with_local_model(
    model: str,
    prompt: str,
    *,
    transport: httpx.AsyncBaseTransport | None,
) -> str:
    async with httpx.AsyncClient(
        trust_env=False,
        follow_redirects=False,
        timeout=httpx.Timeout(30.0, connect=2.0),
        transport=transport,
    ) as client:
        await _ensure_model_is_installed(client, model)
        async with client.stream(
            "POST",
            OLLAMA_CHAT_URL,
            json={"model": model, "prompt": prompt, "stream": False,
                  "options": {"temperature": 0, "num_predict": 128}},
            headers={"content-type": "application/json"},
        ) as response:
            payload = await _read_json_response(response, MAX_RESPONSE_BYTES)
    result = payload.get("response")
    if not isinstance(result, str):
        raise LocalTranslationError("Local translator returned no translation")
    result = result.strip()
    if not result or len(result) > MAX_TRANSLATION_TEXT:
        raise LocalTranslationError("Local translator returned an unusable translation")
    return result


async def translate_food_text(
    text: str,
    target_language: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[str, str]:
    """Translate only the submitted text through Ollama bound to loopback."""
    source_text = text.strip()
    if not source_text or len(source_text) > MAX_TRANSLATION_TEXT:
        raise LocalTranslationError("Food text is empty or too long")
    if target_language not in ("en", "th"):
        raise LocalTranslationError("Translation language is unsupported")

    prompt_language = "English" if target_language == "en" else "Thai"
    prompt = f"Translate the following text into {prompt_language}.\n\n{source_text}"
    model = _translation_model()

    try:
        await asyncio.wait_for(_translation_lock.acquire(), timeout=0.05)
    except asyncio.TimeoutError:
        raise LocalTranslationError("Local translator is busy; try again shortly") from None
    try:
        result = await asyncio.wait_for(
            _translate_with_local_model(model, prompt, transport=transport),
            timeout=REQUEST_DEADLINE_SECONDS,
        )
    except asyncio.TimeoutError:
        raise LocalTranslationError("Local translation timed out; try again") from None
    except LocalTranslationError:
        raise
    except (httpx.HTTPError, TypeError, ValueError):
        raise LocalTranslationError("Local translator did not respond; check Ollama and try again") from None
    finally:
        _translation_lock.release()
    return result, model
