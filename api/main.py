"""Local development API; calculation results are experimental, not clinical advice."""

from __future__ import annotations

import base64
import binascii
import json
from decimal import Decimal, DecimalException, InvalidOperation
from typing import Annotated, Literal, Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

from nutrition.calculator import NUTRIENTS, Measure, NutrientSource, calculate
from api.ocr import MAX_IMAGE_BYTES, OCRServiceError, ocr_image


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


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


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
    return {"text": result.text, "requires_human_review": True, "clinical_use": False}


@app.post("/experimental/recipes/calculate")
def calculate_recipe(payload: RecipeInput):
    ingredients = []
    for index, item in enumerate(payload.ingredients, 1):
        reference = Measure(item.reference_quantity, item.reference_unit, item.reference_food_state)
        amount = Measure(item.amount, item.unit, item.food_state)
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
        "totals": {
            name: {"value": str(value) if value is not None else None, "complete": complete}
            for name, (value, complete) in totals.items()
        },
        "unreviewed_sources": unreviewed,
    }
