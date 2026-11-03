"""Local development API; calculation results are experimental, not clinical advice."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import secrets
import sqlite3
import tempfile
import threading
from datetime import date, datetime
from decimal import Decimal, DecimalException, InvalidOperation
from pathlib import Path
from typing import Annotated, Literal, Optional
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, StrictInt, StrictStr, ValidationError, model_validator

from nutrition.calculator import NUTRIENTS, Measure, NutrientSource, calculate
from nutrition.label_parser import parse_nutrition_label
from nutrition.recipes import RecipeStore
from nutrition.seasonings import SeasoningStore
from nutrition.profiles import ProfileStore
from api.ocr import MAX_IMAGE_BYTES, OCRServiceError, ocr_image
from nutrition.local_translation import LocalTranslationError, translate_food_text
from nutrition.usda_fdc import USDAFDCClient, USDAFDCError
from pwdlib import PasswordHash
from api.auth import (AuthCsrfLimiter, AuthLimiter, AuthSessions, AuthSessionMiddleware,
                      csrf_bootstrap_valid, csrf_origin_valid,
                      csrf_token, load_auth_config)


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


class SavedRecipeIngredientInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ingredient_version_id: Optional[Annotated[StrictInt, Field(gt=0)]] = None
    seasoning_version_id: Optional[Annotated[StrictInt, Field(gt=0)]] = None
    amount: Positive
    unit: Literal["g", "ml"]
    food_state: Literal["raw", "cooked", "as_sold"]

    @model_validator(mode="after")
    def require_one_reviewed_source(self):
        if (self.ingredient_version_id is None) == (self.seasoning_version_id is None):
            raise ValueError("Provide exactly one ingredient or seasoning version ID")
        return self


class SavedRecipeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    synthetic_only: Literal[True]
    name: str = Field(min_length=1, max_length=150)
    ingredients: list[SavedRecipeIngredientInput] = Field(min_length=1, max_length=100)


class SavedRecipeIngredientsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    synthetic_only: Literal[True]
    ingredients: list[SavedRecipeIngredientInput] = Field(min_length=1, max_length=100)


class SavedRecipeUpdateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    synthetic_only: Literal[True]
    name: Optional[str] = Field(default=None, min_length=1, max_length=150)
    favorite: Optional[StrictBool] = None


class SavedRecipeCalculationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    synthetic_only: Literal[True]
    portion: Portion


class SavedRecipeOpenInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    synthetic_only: Literal[True]


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: StrictStr = Field(min_length=1, max_length=128)
    password: StrictStr = Field(min_length=1, max_length=1024)


class LoginConfirmInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    login_ticket: StrictStr = Field(min_length=32, max_length=128)


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


class USDAIngredientPreviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    synthetic_only: Literal[True]
    fdc_id: Annotated[StrictInt, Field(gt=0)]


class USDAIngredientSnapshotInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    synthetic_only: Literal[True]
    reviewed: Literal[True]
    fdc_id: Annotated[StrictInt, Field(gt=0)]
    food_state: Literal["raw", "cooked"]
    snapshot_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class SyntheticProfileInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    synthetic_only: Literal[True]
    name: str = Field(min_length=1, max_length=80)


class SyntheticGoalInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    synthetic_only: Literal[True]
    clinician_set: Literal[True]
    nutrient: str = Field(min_length=1, max_length=80)
    amount: Number = Field(ge=0)
    unit: str = Field(min_length=1, max_length=32)
    effective_on: date


class SyntheticWeightInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    synthetic_only: Literal[True]
    measured_on: date
    kilograms: Positive


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


def _recipe_store():
    return RecipeStore(_demo_store().ingredients.database)


def _recipe_response(recipe):
    result = {"experimental": True, "clinical_use": False, **recipe, "ingredients": []}
    for source in recipe["ingredients"]:
        item = dict(source)
        for key in ("amount", "basis_quantity", *NUTRIENTS):
            if item[key] is not None:
                item[key] = str(item[key])
        item["reviewed"] = bool(item["reviewed"])
        result["ingredients"].append(item)
    return result


def _recipe_entries(items):
    store = _demo_store()
    entries = []
    for item in items:
        if item.seasoning_version_id is not None:
            version_id = item.seasoning_version_id
            source = store.get_reviewed_version(version_id)
        else:
            version_id = item.ingredient_version_id
            source = store.ingredients.get_reviewed_version(version_id)
        if source is None:
            raise ValueError("Recipe ingredients must use locally reviewed source versions")
        entries.append((version_id, item.amount, item.unit, item.food_state))
    return entries


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
_auth_config = load_auth_config()
_auth_password = PasswordHash.recommended() if _auth_config.enabled else None
if (_auth_config.enabled and not _auth_password.current_hasher.identify(
        _auth_config.admin_password_hash)):
    raise RuntimeError("ADMIN_PASSWORD_HASH must be a supported Argon2id hash")
_auth_limiter = AuthLimiter()
_auth_sessions = AuthSessions()
_auth_csrf_limiter = AuthCsrfLimiter()
_SESSION_TTL_SECONDS = 8 * 60 * 60
_demo_store_lock = threading.Lock()
# Experimental single-process cache: inode identity catches atomic replacements,
# but not in-place resets; separate worker processes do not share this lock/cache.
_demo_stores: dict[Path, tuple[tuple[int, int], SeasoningStore]] = {}
_profile_stores: dict[Path, tuple[tuple[int, int], ProfileStore]] = {}


def _profile_store():
    _demo_store()  # Validate and initialize only the marked experimental database.
    try:
        target = Path(os.environ["KIDNEY_EXPERIMENTAL_DB"])
        resolved = target.resolve()
        with _demo_store_lock:
            stat = resolved.stat()
            identity = (stat.st_dev, stat.st_ino)
            cached = _profile_stores.get(resolved)
            if cached is None or cached[0] != identity:
                store = ProfileStore(resolved)
                _profile_stores[resolved] = ((resolved.stat().st_dev, resolved.stat().st_ino), store)
            return _profile_stores[resolved][1]
    except (OSError, sqlite3.Error, ValueError) as exc:
        raise HTTPException(status_code=503, detail='Experimental profile storage is unavailable') from exc


@app.get('/experimental/profiles')
def list_profiles():
    return {'items': _profile_store().list_profiles(), 'synthetic_only': True}


@app.post('/experimental/profiles')
def create_profile(payload: SyntheticProfileInput):
    try:
        profile_id = _profile_store().create_profile(payload.name)
        return {'id': profile_id, 'name': payload.name.strip(), 'synthetic_only': True}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail='Enter a profile name for synthetic data') from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Profile storage is unavailable') from exc


@app.get('/experimental/profiles/{profile_id}')
def get_profile(profile_id: Annotated[int, Field(gt=0)]):
    try:
        profile = _profile_store().get_profile(profile_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail='Invalid profile') from exc
    if profile is None:
        raise HTTPException(status_code=404, detail='Profile not found')
    return {**profile, 'synthetic_only': True, 'clinical_use': False}


@app.post('/experimental/profiles/{profile_id}/goals')
def add_profile_goal(profile_id: Annotated[int, Field(gt=0)], payload: SyntheticGoalInput):
    store = _profile_store()
    if store.get_profile(profile_id) is None:
        raise HTTPException(status_code=404, detail='Profile not found')
    try:
        goal_id = store.add_goal(profile_id, payload.nutrient, float(payload.amount), payload.unit,
                                 payload.effective_on.isoformat(), 'Synthetic clinician-set goal')
        return {'goal_id': goal_id, 'profile_id': profile_id, 'saved': True,
                'synthetic_only': True, 'clinical_use': False}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail='Check the goal fields and try again') from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Goal storage is unavailable') from exc


@app.post('/experimental/profiles/{profile_id}/dry-weights')
def add_profile_weight(profile_id: Annotated[int, Field(gt=0)], payload: SyntheticWeightInput):
    store = _profile_store()
    if store.get_profile(profile_id) is None:
        raise HTTPException(status_code=404, detail='Profile not found')
    try:
        weight_id = store.add_dry_weight(profile_id, payload.measured_on.isoformat(), float(payload.kilograms))
        return {'weight_id': weight_id, 'profile_id': profile_id, 'saved': True,
                'synthetic_only': True, 'clinical_use': False}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail='Check the weight fields and try again') from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Weight storage is unavailable') from exc


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
    if (_auth_config.enabled and (request.url.path == "/experimental"
            or request.url.path.startswith("/experimental/"))):
        if not _is_authenticated(request):
            return JSONResponse(status_code=401, content={"detail": "Authentication required"})
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            token = csrf_token(request)
            if (not csrf_origin_valid(request, _auth_config.auth_origin)
                    or not _auth_sessions.consume_write_nonce(token, request.session["sid"])):
                return JSONResponse(status_code=403, content={"detail": "Invalid request"})
    return await call_next(request)


@app.get("/auth/csrf")
def get_auth_csrf(request: Request, response: Response, purpose: Literal["login", "write"] = "login"):
    if not _auth_config.enabled:
        raise HTTPException(status_code=404, detail="Not found")
    if not csrf_bootstrap_valid(request, _auth_config.auth_origin):
        raise HTTPException(status_code=403, detail="Invalid request")
    client_key = request.client.host if request.client is not None else ""
    if not _auth_csrf_limiter.allow(client_key):
        raise HTTPException(status_code=429, detail="Too many authentication requests")
    session_id = _current_session_id(request)
    token = _auth_sessions.issue_csrf(session_id, purpose, client_key)
    if token is None:
        raise HTTPException(status_code=429, detail="Authentication transition is unavailable")
    response.headers["Cache-Control"] = "no-store"
    return {"csrf_token": token, "purpose": purpose}


@app.post("/auth/login")
def login(payload: LoginInput, request: Request):
    if not _auth_config.enabled:
        raise HTTPException(status_code=404, detail="Not found")
    token = csrf_token(request)
    client_session_id = _current_session_id(request)
    if (not csrf_origin_valid(request, _auth_config.auth_origin)
            or not _auth_sessions.valid_login_nonce(token, client_session_id)):
        raise HTTPException(status_code=403, detail="Invalid request")
    reservation = _auth_limiter.reserve("admin")
    if reservation is None:
        raise HTTPException(status_code=429, detail="Too many attempts")
    try:
        expected_epoch = _auth_sessions.begin_login()
        password_valid = _auth_password.verify(payload.password, _auth_config.admin_password_hash)
        username_valid = secrets.compare_digest(payload.username.encode("utf-8"),
                                                _auth_config.admin_username.encode("utf-8"))
    except Exception:
        _auth_limiter.release("admin", reservation)
        raise
    if not username_valid or not password_valid:
        _auth_limiter.failed("admin", reservation)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    _auth_limiter.succeeded("admin", reservation)
    ticket = _auth_sessions.prepare_login(token, client_session_id, expected_epoch)
    if ticket is None:
        raise HTTPException(status_code=409, detail="Authentication changed; sign in again")
    return {"login_ticket": ticket, "confirmation_required": True}


def _is_authenticated(request: Request) -> bool:
    session_id = request.session.get("sid")
    expires_at = request.session.get("exp")
    return (request.session.get("admin") is True and isinstance(session_id, str)
            and isinstance(expires_at, int) and not isinstance(expires_at, bool)
            and _auth_sessions.valid(session_id, expires_at))


def _current_session_id(request: Request) -> str | None:
    session_id = request.session.get("sid")
    expires_at = request.session.get("exp")
    if (request.session.get("admin") is True and isinstance(session_id, str)
            and isinstance(expires_at, int) and not isinstance(expires_at, bool)
            and _auth_sessions.valid(session_id, expires_at)):
        return session_id
    return None


@app.post("/auth/confirm")
def confirm_login(payload: LoginConfirmInput, request: Request):
    if not _auth_config.enabled:
        raise HTTPException(status_code=404, detail="Not found")
    token = csrf_token(request)
    if not csrf_origin_valid(request, _auth_config.auth_origin):
        raise HTTPException(status_code=403, detail="Invalid request")
    confirmed = _auth_sessions.confirm_login(payload.login_ticket, token, _SESSION_TTL_SECONDS)
    if confirmed is None:
        raise HTTPException(status_code=409, detail="Login ticket is invalid or expired")
    issued, ack_token = confirmed
    request.session.clear()
    request.session.update({"admin": True, "sid": issued.session_id, "exp": issued.expires_at})
    request.state.auth_cookie_confirm = True
    return {"authenticated": True, "acknowledgment_required": True, "csrf_token": ack_token}


@app.post("/auth/ack", status_code=204)
def acknowledge_auth_session(request: Request):
    if not _auth_config.enabled:
        raise HTTPException(status_code=404, detail="Not found")
    session_id = request.session.get("sid")
    expires_at = request.session.get("exp")
    token = csrf_token(request)
    if (not isinstance(session_id, str) or not isinstance(expires_at, int)
            or isinstance(expires_at, bool) or not csrf_origin_valid(request, _auth_config.auth_origin)
            or not _auth_sessions.acknowledge(session_id, expires_at, token)):
        raise HTTPException(status_code=401, detail="Authentication confirmation required")
    return Response(status_code=204)


@app.get("/auth/me")
def whoami(request: Request):
    if not _auth_config.enabled:
        raise HTTPException(status_code=404, detail="Not found")
    if not _is_authenticated(request):
        raise HTTPException(status_code=401, detail="Authentication required")
    return {"authenticated": True, "username": _auth_config.admin_username}


@app.post("/auth/logout", status_code=204)
def logout(request: Request):
    if not _auth_config.enabled:
        raise HTTPException(status_code=404, detail="Not found")
    if not _is_authenticated(request):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = csrf_token(request)
    if (not csrf_origin_valid(request, _auth_config.auth_origin)
            or not _auth_sessions.consume_write_nonce(token, request.session["sid"])):
        raise HTTPException(status_code=403, detail="Invalid request")
    if not _auth_sessions.revoke(request.session["sid"]):
        raise HTTPException(status_code=401, detail="Authentication required")
    return Response(status_code=204)


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


def _usda_review_snapshot(fdc_id: int) -> dict:
    """Resolve canonical, reviewable detail. Never accept nutrient fields from a caller."""
    try:
        food = USDAFDCClient().get_food(fdc_id)
    except USDAFDCError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    if not isinstance(food, dict):
        raise HTTPException(status_code=503, detail='USDA returned an invalid food record')
    if food.get('fdc_id') != fdc_id:
        raise HTTPException(status_code=422, detail='USDA food ID did not match the selected record')
    if food.get('source_type') not in ('Foundation', 'SR Legacy'):
        raise HTTPException(status_code=422, detail='Only USDA Foundation and SR Legacy records are supported')
    if food.get('food_state') not in ('raw', 'cooked'):
        raise HTTPException(status_code=422, detail='USDA record does not identify raw or cooked state')
    nutrients = food.get('nutrients')
    if not isinstance(nutrients, dict) or any(
            key not in NUTRIENTS or (value is not None and not isinstance(value, Decimal))
            for key, value in nutrients.items()):
        raise HTTPException(status_code=503, detail='USDA returned invalid nutrient data')
    source_version = food.get('source_version')
    if not isinstance(source_version, str) or not source_version.strip():
        source_version = f"FoodData Central record {fdc_id}"
    source_version = source_version.strip()
    if len(source_version) > 200:
        raise HTTPException(status_code=503, detail='USDA returned invalid source version data')
    try:
        source_date = date.fromisoformat(source_version).isoformat()
    except ValueError:
        source_date = None
    retrieved_on = datetime.now(ZoneInfo('Asia/Bangkok')).date().isoformat()
    name = food.get('description')
    if not isinstance(name, str) or not name.strip() or len(name) > 150:
        raise HTTPException(status_code=503, detail='USDA returned an invalid food description')
    canonical = {
        'fdc_id': fdc_id, 'source_type': food['source_type'],
        'source_version': source_version, 'source_date': source_date,
        'name': name.strip(), 'food_state': food['food_state'],
        'basis_quantity': '100', 'basis_unit': 'g',
        'nutrients': {key: str(nutrients.get(key)) if nutrients.get(key) is not None else None
                      for key in NUTRIENTS},
    }
    digest_material = json.dumps(canonical, sort_keys=True, separators=(',', ':'))
    canonical['snapshot_digest'] = hashlib.sha256(digest_material.encode()).hexdigest()
    return canonical


@app.post('/experimental/ingredients/usda/preview')
def preview_usda_ingredient_snapshot(payload: USDAIngredientPreviewInput):
    """Return exact data user must review before saving a USDA source snapshot."""
    try:
        _demo_store()  # Validate the synthetic-only storage marker before external access.
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail='Experimental storage is unavailable') from None
    return _usda_review_snapshot(payload.fdc_id)


@app.post('/experimental/ingredients/usda')
def save_usda_ingredient_snapshot(payload: USDAIngredientSnapshotInput):
    """Refetch and save only the exact USDA snapshot the user confirmed."""
    try:
        store = _demo_store()  # Gate storage before external access or any write attempt.
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail='Experimental storage is unavailable') from None
    canonical = _usda_review_snapshot(payload.fdc_id)
    if canonical['snapshot_digest'] != payload.snapshot_digest:
        raise HTTPException(status_code=409, detail='USDA record changed; preview and review it again')
    if canonical['food_state'] != payload.food_state:
        raise HTTPException(status_code=409, detail='USDA food state changed; preview and review it again')
    nutrients = {key: Decimal(value) if value is not None else None
                 for key, value in canonical['nutrients'].items()}
    source_reference = f"https://fdc.nal.usda.gov/food-details/{payload.fdc_id}/nutrients"
    snapshot_version = (f"fdc-{payload.fdc_id}-{canonical['food_state']}-"
                        f"{canonical['snapshot_digest'][:20]}")
    retrieved_on = datetime.now(ZoneInfo('Asia/Bangkok')).date().isoformat()
    provenance = ('USDA FoodData Central; source record fetched by server and reviewed confirmation '
                  f"provided for preview digest {canonical['snapshot_digest']}; source values preserved as returned.")
    try:
        saved = store.ingredients.create_reviewed(
            name=canonical['name'], provider='USDA FoodData Central', version=snapshot_version,
            source_version=canonical['source_version'], source_date=canonical['source_date'], retrieved_on=retrieved_on,
            source_reference=source_reference, provenance=provenance,
            basis_quantity=Decimal('100'), basis_unit='g', food_state=canonical['food_state'],
            reviewed=True, nutrients={key: nutrients.get(key) for key in NUTRIENTS},
            idempotency_key=source_reference,
        )
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail='Ingredient storage is unavailable') from None
    except ValueError:
        raise HTTPException(status_code=503, detail='USDA ingredient snapshot could not be saved') from None
    return {
        **canonical, **saved, 'version': snapshot_version,
        'provider': 'USDA FoodData Central', 'source_version': canonical['source_version'],
        'retrieved_on': saved['retrieved_on'],
        'source_reference': source_reference, 'provenance': provenance,
        'reviewed': True, 'synthetic_only': True,
    }


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


@app.post("/experimental/recipes")
def create_saved_recipe(payload: SavedRecipeInput):
    try:
        store = _recipe_store()
        name = payload.name.strip()
        recipe_id = store.create_recipe(name, _recipe_entries(payload.ingredients))
        return {"id": recipe_id, "name": name, "saved": True,
                "experimental": True, "clinical_use": False}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Recipe storage is unavailable') from exc


@app.get("/experimental/recipes")
def list_saved_recipes():
    try:
        return {"items": _recipe_store().list_recipes(), "experimental": True, "clinical_use": False}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Recipe storage is unavailable') from exc


@app.get("/experimental/recipes/recent")
def list_recent_saved_recipes():
    try:
        return {"items": _recipe_store().list_recent_recipes(), "history_type": "explicit_open",
                "experimental": True, "clinical_use": False}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Recipe storage is unavailable') from exc


@app.post("/experimental/recipes/{recipe_id}/open")
def record_saved_recipe_open(recipe_id: Annotated[int, Field(gt=0)], payload: SavedRecipeOpenInput):
    """Record an explicit open in the synthetic store; item points to current recipe, no patient data."""
    try:
        opened = _recipe_store().record_recipe_open(recipe_id)
        return {**opened, "recorded": True, "history_type": "explicit_open",
                "experimental": True, "clinical_use": False}
    except LookupError as exc:
        raise HTTPException(status_code=404, detail='Recipe not found') from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail='Invalid recipe ID') from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Recipe storage is unavailable') from exc


@app.get("/experimental/recipes/{recipe_id}")
def get_saved_recipe(recipe_id: int):
    try:
        recipe = _recipe_store().get_recipe(recipe_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Recipe storage is unavailable') from exc
    if recipe is None:
        raise HTTPException(status_code=404, detail='Recipe not found')
    return _recipe_response(recipe)


@app.patch("/experimental/recipes/{recipe_id}")
def update_saved_recipe(recipe_id: int, payload: SavedRecipeUpdateInput):
    if payload.name is None and payload.favorite is None:
        raise HTTPException(status_code=422, detail='Provide a recipe name or favorite value')
    try:
        store = _recipe_store()
        name = payload.name.strip() if payload.name is not None else None
        store.update_recipe(recipe_id, name=name, favorite=payload.favorite)
        return {"id": recipe_id, "updated": True,
                "updated_fields": {key: value for key, value in (
                    ("name", name), ("favorite", payload.favorite),
                ) if value is not None},
                "experimental": True, "clinical_use": False}
    except LookupError as exc:
        raise HTTPException(status_code=404, detail='Recipe not found') from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Recipe storage is unavailable') from exc


@app.put("/experimental/recipes/{recipe_id}/ingredients")
def replace_saved_recipe_ingredients(recipe_id: int, payload: SavedRecipeIngredientsInput):
    try:
        store = _recipe_store()
        store.replace_ingredients(recipe_id, _recipe_entries(payload.ingredients))
        return {"id": recipe_id, "ingredients_updated": True,
                "experimental": True, "clinical_use": False}
    except LookupError as exc:
        raise HTTPException(status_code=404, detail='Recipe not found') from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Recipe storage is unavailable') from exc


@app.post("/experimental/recipes/{recipe_id}/calculate")
def calculate_saved_recipe(recipe_id: int, payload: SavedRecipeCalculationInput):
    try:
        result = _recipe_store().calculate_recipe(recipe_id, payload.portion)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail='Recipe not found') from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except DecimalException as exc:
        raise HTTPException(status_code=422, detail='Inputs exceed supported calculation range') from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Recipe storage is unavailable') from exc
    return {
        "experimental": True, "clinical_use": False,
        "portion": str(result["portion"]),
        "totals": {
            name: {"value": str(value) if value is not None else None, "complete": complete}
            for name, (value, complete) in result["totals"].items()
        },
        "unreviewed_sources": result["unreviewed_sources"],
    }


@app.delete("/experimental/recipes/{recipe_id}", status_code=204)
def delete_saved_recipe(recipe_id: int, synthetic_only: Literal["true"] = Query(...)):
    try:
        _recipe_store().delete_recipe(recipe_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail='Recipe not found') from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail='Recipe is referenced by saved meal history') from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail='Recipe storage is unavailable') from exc


if _auth_config.enabled:
    app = AuthSessionMiddleware(app, _auth_config.session_secret, _SESSION_TTL_SECONDS,
                                _auth_config.cookie_secure)
