"""Local development API; calculation results are experimental, not clinical advice."""

from __future__ import annotations

import base64
import binascii
import json
import os
import sqlite3
import tempfile
import threading
from datetime import date, datetime
from decimal import Decimal, DecimalException, InvalidOperation
from pathlib import Path
from typing import Annotated, Literal, Optional
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictInt, ValidationError

from nutrition.calculator import NUTRIENTS, Measure, NutrientSource, calculate
from nutrition.label_parser import parse_nutrition_label
from nutrition.seasonings import SeasoningStore
from api.ocr import MAX_IMAGE_BYTES, OCRServiceError, ocr_image
from nutrition.local_translation import LocalTranslationError, translate_food_text
from nutrition.usda_fdc import USDAFDCClient, USDAFDCError


def _json_decimal(value):
    if not isinstance(value, str):
        raise ValueError("must be a decimal string")
    if len(value) > 64:
        raise ValueError("decimal string is too long")
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError("must be a finite decimal string") from exc
    if (not parsed.is_finite() or len(parsed.as_tuple().digits) > 32
            or not -100 <= parsed.adjusted() <= 100):
        raise ValueError("decimal exceeds supported precision or magnitude")
    return parsed


Number = Annotated[Decimal, BeforeValidator(_json_decimal)]
Positive = Annotated[Number, Field(gt=0)]
Portion = Annotated[Number, Field(gt=0, le=1)]


class IngredientInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount: Positive
    unit: Literal["g", "ml"]
    food_state: Literal["raw", "cooked", "as_sold"]
    reference_quantity: Positive
    reference_unit: Literal["g", "ml"]
    reference_food_state: Literal["raw", "cooked", "as_sold"]
    source_type: Optional[Literal["manual", "usda", "seasoning", "saved"]] = None
    seasoning_version_id: Optional[Annotated[StrictInt, Field(gt=0)]] = None
    ingredient_version_id: Optional[Annotated[StrictInt, Field(gt=0)]] = None
    fdc_id: Optional[Annotated[StrictInt, Field(gt=0)]] = None
    energy_kcal: Optional[Number] = None
    protein_g: Optional[Number] = None
    sodium_mg: Optional[Number] = None
    potassium_mg: Optional[Number] = None
    phosphorus_mg: Optional[Number] = None


class RecipeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    synthetic_only: Literal[True]
    portion: Portion
    ingredients: list[IngredientInput] = Field(min_length=1, max_length=100)


class OCRInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    synthetic_only: Literal[True]
    content_type: Literal["image/png", "image/jpeg"]
    image_base64: str = Field(min_length=1, max_length=4 * ((MAX_IMAGE_BYTES + 2) // 3))


class LocalFoodTranslationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=300)
    target_language: Literal["en", "th"]


class SeasoningNutrients(BaseModel):
    model_config = ConfigDict(extra="forbid")
    energy_kcal: Optional[Number] = None
    protein_g: Optional[Number] = None
    sodium_mg: Optional[Number] = None
    potassium_mg: Optional[Number] = None
    phosphorus_mg: Optional[Number] = None


class SeasoningInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    synthetic_only: Literal[True]
    reviewed: Literal[True]
    name: str = Field(min_length=1, max_length=150)
    brand: Optional[str] = Field(default=None, max_length=150)
    basis_quantity: Positive
    basis_unit: Literal['g', 'ml']
    nutrients: SeasoningNutrients


class ManualIngredientInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    synthetic_only: Literal[True]
    reviewed: Literal[True]
    name: str = Field(min_length=1, max_length=150)
    provider: str = Field(min_length=1, max_length=150)
    source_version: str = Field(min_length=1, max_length=200)
    source_date: Optional[date] = None
    source_reference: str = Field(min_length=1, max_length=500)
    provenance: str = Field(min_length=1, max_length=500)
    basis_quantity: Positive
    basis_unit: Literal['g', 'ml']
    food_state: Literal['raw', 'cooked', 'as_sold']
    nutrients: SeasoningNutrients = Field(default_factory=SeasoningNutrients)


def _demo_store():
    path = os.environ.get('KIDNEY_EXPERIMENTAL_DB')
    if not path:
        raise HTTPException(status_code=503, detail='Experimental storage is not configured')
    target = Path(path)
    with _demo_store_lock:
        if target.is_symlink():
            raise HTTPException(status_code=503, detail='Experimental storage is invalid')
        try:
            if not target.exists():
                descriptor, temporary = tempfile.mkstemp(prefix='.kidney-demo-', dir=str(target.parent))
                os.close(descriptor)
                try:
                    with sqlite3.connect(temporary) as db:
                        db.execute('CREATE TABLE experimental_demo_marker (marker TEXT NOT NULL)')
                        db.execute("INSERT INTO experimental_demo_marker VALUES ('synthetic-only-v1')")
                    try:
                        os.link(temporary, str(target))
                    except FileExistsError:
                        pass
                finally:
                    os.unlink(temporary)
            with sqlite3.connect(f'{target.resolve().as_uri()}?mode=ro', uri=True) as db:
                marker = db.execute('SELECT marker FROM experimental_demo_marker').fetchall()
            if marker != [('synthetic-only-v1',)]:
                raise ValueError('not an experimental database')
            resolved = target.resolve()
            stat = resolved.stat()
            identity = (stat.st_dev, stat.st_ino)
            cached = _demo_stores.get(resolved)
            if cached is None or cached[0] != identity:
                store = SeasoningStore(target)
                stat = resolved.stat()
                identity = (stat.st_dev, stat.st_ino)
                _demo_stores[resolved] = (identity, store)
            return _demo_stores[resolved][1]
        except (OSError, sqlite3.Error, ValueError) as exc:
            raise HTTPException(status_code=503, detail='Experimental storage is invalid or unavailable') from exc


def _suggestions(text):
    parsed = parse_nutrition_label(text)
    serving = parsed.serving_basis
    valid = [entry for entry in parsed.nutrients.values() if entry.value is not None]
    bases = {entry.basis for entry in valid}
    conflict = parsed.basis_conflict or len(bases) > 1
    candidate = valid[0].basis if valid and not conflict else None
    if candidate and candidate.unit == 'serving':
        basis = serving if serving and serving.unit in ('g', 'ml') else None
    else:
        basis = candidate if candidate and candidate.unit in ('g', 'ml') else None
    values = {name: (str(entry.value) if basis and entry.value is not None and entry.basis == candidate else None)
              for name, entry in parsed.nutrients.items()}
    return {'basis_quantity': str(basis.value) if basis else None,
            'basis_unit': basis.unit if basis else None, 'nutrients': values,
            'basis_conflict': conflict, 'requires_human_review': True}


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_demo_store_lock = threading.Lock()
# Experimental single-process cache: inode identity catches atomic replacements,
# but not in-place resets; separate worker processes do not share this lock/cache.
_demo_stores: dict[Path, tuple[tuple[int, int], SeasoningStore]] = {}


@app.get("/experimental/usda/search")
def search_usda_foods(q: str = Query(min_length=1, max_length=200), page: int = Query(default=1, ge=1)):
    if not q.strip():
        raise HTTPException(status_code=422, detail="Food search text is required")
    try:
        result = USDAFDCClient().search(q, page_number=page, page_size=10,
                                        data_types=("Foundation", "SR Legacy"))
        return {"items": result.foods, "page": result.page_number,
                "total_pages": result.total_pages, "total_hits": result.total_hits,
                "experimental": True}
    except USDAFDCError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


@app.post("/experimental/local-food-translation")
async def translate_local_food_text(payload: LocalFoodTranslationInput):
    """Optional translation of one food string through Ollama at loopback."""
    try:
        translation, model = await translate_food_text(payload.text, payload.target_language)
    except LocalTranslationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    return {"translation": translation, "target_language": payload.target_language,
            "model": model, "transport": "loopback"}


@app.middleware("http")
async def localhost_only(request: Request, call_next):
    if request.client is None or request.client.host not in ("127.0.0.1", "::1"):
        return JSONResponse(status_code=403, content={"detail": "Localhost access only"})
    raw_host = request.headers.get("host", "")
    try:
        host_parts = urlsplit("//" + raw_host)
        host = host_parts.hostname
        host_parts.port  # reject malformed ports
    except ValueError:
        host = None
        host_parts = None
    if (host not in ("localhost", "127.0.0.1", "::1") or host_parts is None
            or host_parts.username is not None or host_parts.password is not None
            or host_parts.path or host_parts.query or host_parts.fragment):
        return JSONResponse(status_code=403, content={"detail": "Localhost Host required"})
    origin = request.headers.get("origin")
    if origin:
        try:
            parsed_origin = urlsplit(origin)
            origin_host = parsed_origin.hostname
            origin_port = parsed_origin.port
        except ValueError:
            return JSONResponse(status_code=403, content={"detail": "Localhost Origin required"})
        if (parsed_origin.scheme not in ("http", "https")
                or origin_host not in ("localhost", "127.0.0.1", "::1")
                or parsed_origin.username is not None or parsed_origin.password is not None
                or parsed_origin.path or parsed_origin.query or parsed_origin.fragment):
            return JSONResponse(status_code=403, content={"detail": "Localhost Origin required"})
        if origin_host != host or origin_port != host_parts.port:
            return JSONResponse(status_code=403, content={"detail": "Origin and Host must match"})
    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/experimental/ocr")
async def experimental_ocr(request: Request):
    if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
        raise HTTPException(status_code=415, detail="JSON content type required")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 1024:
            raise HTTPException(status_code=413, detail="Image request too large")
    try:
        payload = OCRInput.model_validate(json.loads(body))
        image = base64.b64decode(payload.image_base64, validate=True)
        result = await ocr_image(image, payload.content_type)
    except (ValueError, UnicodeDecodeError, ValidationError, binascii.Error, OCRServiceError) as exc:
        raise HTTPException(status_code=422, detail="Image or local OCR request could not be processed") from exc
    return {"text": result.text, "suggestions": _suggestions(result.text),
            "requires_human_review": True, "clinical_use": False}


@app.get('/experimental/seasonings')
def list_seasonings():
    return {'items': _demo_store().list()}


@app.get('/experimental/ingredients/search')
def search_saved_ingredients(q: str = Query(min_length=1, max_length=100)):
    query = q.strip()
    if not query:
        raise HTTPException(status_code=422, detail='Enter a food name to search saved records')
    # This lookup stays in the local SQLite store. It does not contact USDA or another service.
    return {'items': _demo_store().ingredients.search_reviewed(query),
            'local_only': True, 'reviewed_by_user': True}


@app.post('/experimental/ingredients')
async def save_manual_ingredient(request: Request):
    if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
        raise HTTPException(status_code=415, detail='JSON content type required')
    try:
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 32768:
                raise HTTPException(status_code=413, detail='Request too large')
        payload = ManualIngredientInput.model_validate(json.loads(body))
        return _demo_store().ingredients.create_reviewed(
            name=payload.name, provider=payload.provider, version='1',
            source_version=payload.source_version,
            source_date=payload.source_date.isoformat() if payload.source_date else None,
            retrieved_on=datetime.now(ZoneInfo('Asia/Bangkok')).date().isoformat(),
            source_reference=payload.source_reference, provenance=payload.provenance,
            basis_quantity=payload.basis_quantity, basis_unit=payload.basis_unit,
            food_state=payload.food_state, reviewed=True, nutrients=payload.nutrients.model_dump(),
        )
    except (ValueError, DecimalException, UnicodeDecodeError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail='Invalid manual ingredient data') from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Ingredient storage is unavailable') from exc


@app.post('/experimental/seasonings')
async def save_seasoning(request: Request):
    if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
        raise HTTPException(status_code=415, detail='JSON content type required')
    try:
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 32768:
                raise HTTPException(status_code=413, detail='Request too large')
        payload = SeasoningInput.model_validate(json.loads(body))
        return _demo_store().create_reviewed(
            name=payload.name, brand=payload.brand, basis_quantity=payload.basis_quantity,
            basis_unit=payload.basis_unit, nutrients=payload.nutrients.model_dump(), reviewed=True,
            retrieved_on=datetime.now(ZoneInfo('Asia/Bangkok')).date().isoformat(),
            source_reference='synthetic test label',
        )
    except (ValueError, DecimalException, UnicodeDecodeError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail='Invalid seasoning data') from exc


@app.post("/experimental/recipes/calculate")
def calculate_recipe(payload: RecipeInput):
    ingredients = []
    source_details = []
    saved_source_details = []
    for index, item in enumerate(payload.ingredients, 1):
        if item.ingredient_version_id is not None and item.source_type != "saved":
            raise HTTPException(status_code=422, detail="A locally saved ingredient ID requires the saved source type")
        if item.source_type == "usda" and (item.fdc_id is None or item.seasoning_version_id is not None or item.ingredient_version_id is not None
                or any(getattr(item, name) is not None for name in NUTRIENTS)):
            raise HTTPException(status_code=422, detail="Select a USDA record; its nutrients are resolved by the server")
        if item.source_type == "seasoning" and (item.seasoning_version_id is None or item.fdc_id is not None or item.ingredient_version_id is not None):
            raise HTTPException(status_code=422, detail="Select a saved seasoning version")
        if item.source_type == "saved" and (item.ingredient_version_id is None or item.seasoning_version_id is not None or item.fdc_id is not None
                or any(getattr(item, name) is not None for name in NUTRIENTS)):
            raise HTTPException(status_code=422, detail="Select a saved reviewed ingredient version; values are resolved by the server")
        if item.source_type == "manual" and (item.fdc_id is not None or item.seasoning_version_id is not None or item.ingredient_version_id is not None):
            raise HTTPException(status_code=422, detail="Manual source cannot include a saved source ID")
        if item.fdc_id is not None:
            if item.seasoning_version_id is not None or item.ingredient_version_id is not None or any(
                    getattr(item, name) is not None for name in NUTRIENTS):
                raise HTTPException(status_code=422, detail="USDA food values are resolved by the server")
            try:
                food = USDAFDCClient().get_food(item.fdc_id)
            except USDAFDCError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from None
            if food["fdc_id"] != item.fdc_id:
                raise HTTPException(status_code=422, detail="USDA food ID did not match the selected record")
            if food["source_type"] not in ("Foundation", "SR Legacy"):
                raise HTTPException(status_code=422, detail="Only unbranded USDA Foundation and SR Legacy records are supported")
            if food["food_state"] is None:
                raise HTTPException(status_code=422, detail="USDA record does not identify raw or cooked state")
            if item.unit != "g":
                raise HTTPException(status_code=422, detail="USDA values use grams; volume conversion is unavailable")
            source_details.append({
                "source_id": food["source_id"], "description": food["description"],
                "source_type": food["source_type"], "source_version": food["source_version"],
                "food_state": food["food_state"], "energy_ambiguous": food["energy_ambiguous"],
                "energy_candidates": [
                    {**candidate, "value": str(candidate["value"]) if candidate["value"] is not None else None,
                     "source_value": str(candidate["source_value"]) if candidate["source_value"] is not None else None}
                    for candidate in food["energy_candidates"]
                ],
            })
            amount = Measure(item.amount, "g", food["food_state"])
            reference = Measure(Decimal("100"), "g", food["food_state"])
            source = NutrientSource(reference, food["nutrients"], food["source_id"], reviewed=False)
            ingredients.append((amount, source))
            continue
        amount = Measure(item.amount, item.unit, item.food_state)
        if item.ingredient_version_id is not None:
            saved = _demo_store().ingredients.get_reviewed_version(item.ingredient_version_id)
            if saved is None:
                raise HTTPException(status_code=422, detail="Unknown locally saved reviewed ingredient version")
            if (item.unit != saved["basis_unit"] or item.food_state != saved["food_state"]):
                raise HTTPException(status_code=422, detail="Amount unit and food state must match the saved ingredient")
            reference = Measure(saved["basis_quantity"], saved["basis_unit"], saved["food_state"])
            source = NutrientSource(reference, saved["nutrients"],
                                    f"local reviewed ingredient version {saved['version_id']}", reviewed=True)
            saved_source_details.append({
                "version_id": saved["version_id"], "name": saved["name"],
                "provider": saved["provider"], "source_version": saved["source_version"],
                "source_date": saved["source_date"], "source_reference": saved["source_reference"],
                "provenance": saved["provenance"],
                "retrieved_on": saved["retrieved_on"], "food_state": saved["food_state"],
            })
            ingredients.append((amount, source))
            continue
        if item.seasoning_version_id is not None:
            seasoning = _demo_store().get_reviewed_version(item.seasoning_version_id)
            if seasoning is None:
                raise HTTPException(status_code=422, detail="Unknown reviewed seasoning version")
            if (item.unit != seasoning["basis_unit"] or item.food_state != seasoning["food_state"]):
                raise HTTPException(status_code=422, detail="Amount unit and food state must match saved seasoning")
            reference = Measure(seasoning["basis_quantity"], seasoning["basis_unit"], seasoning["food_state"])
            source = NutrientSource(reference, seasoning["nutrients"],
                                    f"synthetic saved seasoning version {seasoning['version_id']}", reviewed=True)
        else:
            reference = Measure(item.reference_quantity, item.reference_unit, item.reference_food_state)
            values = {name: getattr(item, name) for name in NUTRIENTS}
            source = NutrientSource(reference, values, f"synthetic request ingredient {index}")
        ingredients.append((amount, source))
    try:
        totals, unreviewed = calculate(ingredients, payload.portion)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except DecimalException as exc:
        raise HTTPException(status_code=422, detail="Inputs exceed supported calculation range") from exc
    return {
        "experimental": True,
        "clinical_use": False,
        "rounding": "Decimal context precision is 28 significant digits; no display rounding is applied.",
        "portion": str(payload.portion),
        "sources": source_details,
        "saved_sources": saved_source_details,
        "totals": {
            name: {"value": str(value) if value is not None else None, "complete": complete}
            for name, (value, complete) in totals.items()
        },
        "unreviewed_sources": unreviewed,
    }
