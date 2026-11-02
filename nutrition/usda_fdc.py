"""Read-only USDA FoodData Central search and food-detail adapter."""

from __future__ import annotations

import os
import json as jsonlib
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx


BASE_URL = "https://api.nal.usda.gov/fdc/v1"
API_KEY_ENV = "USDA_FDC_API_KEY"
MAX_PAGE_SIZE = 50
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
NUTRIENT_IDS = {
    1008: ("energy_kcal", "kcal"),
    2047: ("energy_kcal", "kcal"),
    2048: ("energy_kcal", "kcal"),
    1003: ("protein_g", "g"),
    1093: ("sodium_mg", "mg"),
    1092: ("potassium_mg", "mg"),
    1091: ("phosphorus_mg", "mg"),
}
_RAW = re.compile(r"\braw\b", re.IGNORECASE)
_COOKED = re.compile(r"\b(?:cooked|boiled|roasted|baked|fried|grilled|steamed)\b", re.IGNORECASE)


class USDAFDCError(ValueError):
    """Safe adapter error; never includes request URL, API key, or response body."""


@dataclass(frozen=True)
class FoodPage:
    foods: tuple[dict[str, Any], ...]
    page_number: int
    total_pages: int | None
    total_hits: int | None

    @property
    def has_next_page(self) -> bool:
        return self.total_pages is not None and self.page_number < self.total_pages


def _food_state(description: str, data_type: str) -> str | None:
    if data_type.casefold() == "branded":
        return "as_sold"
    raw, cooked = bool(_RAW.search(description)), bool(_COOKED.search(description))
    if raw == cooked:
        return None
    return "raw" if raw else "cooked"


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() and number >= 0 else None


def _food_summary(item: dict[str, Any]) -> dict[str, Any]:
    fdc_id = item.get("fdcId")
    if isinstance(fdc_id, bool) or not isinstance(fdc_id, int) or fdc_id <= 0:
        raise USDAFDCError("USDA returned an invalid food record")
    description = item.get("description")
    data_type = item.get("dataType")
    if not isinstance(description, str) or not isinstance(data_type, str):
        raise USDAFDCError("USDA returned an invalid food record")
    return {
        "source_id": f"USDA-FDC:{fdc_id}",
        "fdc_id": fdc_id,
        "source_type": data_type,
        "source_version": item.get("publishedDate") or item.get("publicationDate"),
        "description": description,
        "food_state": _food_state(description, data_type),
        "requires_human_review": True,
        "imported": False,
    }


def _food_details(item: dict[str, Any]) -> dict[str, Any]:
    summary = _food_summary(item)
    values: dict[str, Decimal | None] = {
        "energy_kcal": None,
        "protein_g": None,
        "sodium_mg": None,
        "potassium_mg": None,
        "phosphorus_mg": None,
    }
    units = {key: unit for key, unit in (
        ("energy_kcal", "kcal"), ("protein_g", "g"),
        ("sodium_mg", "mg"), ("potassium_mg", "mg"), ("phosphorus_mg", "mg"),
    )}
    nutrients = item.get("foodNutrients", [])
    if not isinstance(nutrients, list):
        raise USDAFDCError("USDA returned an invalid nutrient list")
    candidates: dict[int, list[Decimal | None]] = {}
    energy_candidate_records = []
    for entry in nutrients:
        if not isinstance(entry, dict):
            continue
        nutrient = entry.get("nutrient")
        if isinstance(nutrient, dict):
            nutrient_id = nutrient.get("id")
            unit = nutrient.get("unitName")
            amount = entry.get("amount")
        else:
            nutrient_id = entry.get("nutrientId")
            unit = entry.get("unitName")
            amount = entry.get("value")
        if isinstance(nutrient_id, bool) or not isinstance(nutrient_id, int):
            continue
        mapped = NUTRIENT_IDS.get(nutrient_id)
        if mapped is None:
            continue
        _, expected_unit = mapped
        source_value = _decimal_or_none(amount)
        value = (source_value if isinstance(unit, str)
                 and unit.strip().casefold() == expected_unit.casefold() else None)
        candidates.setdefault(nutrient_id, []).append(value)
        if nutrient_id in (1008, 2047, 2048):
            energy_candidate_records.append({
                "nutrient_id": nutrient_id,
                "value": value,
                "source_value": source_value,
                "unit": unit,
            })

    def single_value(nutrient_id: int) -> Decimal | None:
        found = candidates.get(nutrient_id, [])
        return found[0] if found and found[0] is not None and all(v == found[0] for v in found) else None

    for nutrient_id, (name, _) in NUTRIENT_IDS.items():
        if name != "energy_kcal":
            values[name] = single_value(nutrient_id)
    energy_candidates = energy_candidate_records
    energy_values = [candidate["value"] for candidate in energy_candidates]
    valid_energy_values = [value for value in energy_values if value is not None]
    energy_ambiguous = bool(energy_candidates) and (
        len(valid_energy_values) != len(energy_values)
        or len(set(valid_energy_values)) > 1
    )
    if energy_values and not energy_ambiguous and valid_energy_values:
        values["energy_kcal"] = valid_energy_values[0]
    return {**summary, "nutrients": values, "nutrient_units": units,
            "energy_candidates": energy_candidates,
            "energy_ambiguous": energy_ambiguous,
            "basis_quantity": Decimal("100"), "basis_unit": "g"}


class USDAFDCClient:
    """Small read-only API client. Send food terms only; never patient information."""

    def __init__(self, *, client: httpx.Client | None = None):
        key = os.getenv(API_KEY_ENV)
        if not isinstance(key, str) or not key.strip():
            raise USDAFDCError(f"Set {API_KEY_ENV} to use USDA FoodData Central")
        self._api_key = key.strip()
        self._client = client

    def _request(self, path: str, *, params: dict[str, Any], json: dict[str, Any] | None = None):
        transport = self._client
        owns_client = transport is None
        if owns_client:
            transport = httpx.Client(follow_redirects=False, trust_env=False)
        try:
            request_params = {"api_key": self._api_key}
            if json is None:
                request_params.update(params)
            with transport.stream(
                "POST" if json is not None else "GET", f"{BASE_URL}/{path}",
                params=request_params, json=json,
                headers={"Accept": "application/json"}, follow_redirects=False,
                timeout=httpx.Timeout(connect=5, read=20, write=10, pool=5),
            ) as response:
                if response.is_redirect:
                    raise USDAFDCError("USDA request redirect refused")
                response.raise_for_status()
                body = bytearray()
                for chunk in response.iter_bytes():
                    if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise USDAFDCError("USDA response exceeds the supported size")
                    body.extend(chunk)
            try:
                return jsonlib.loads(body)
            except (ValueError, TypeError):
                raise USDAFDCError("USDA returned invalid data") from None
        except USDAFDCError:
            raise
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status == 429:
                message = "USDA request limit reached; try again later"
            elif status in (401, 403):
                message = "USDA rejected the API key"
            elif status == 404:
                message = "USDA food record was not found"
            else:
                message = f"USDA request failed (HTTP {status})"
            raise USDAFDCError(message) from None
        except httpx.HTTPError:
            raise USDAFDCError("USDA request failed or timed out") from None
        finally:
            if owns_client:
                transport.close()

    def search(self, query: str, *, page_number: int = 1, page_size: int = 25,
               data_types: tuple[str, ...] | None = None) -> FoodPage:
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be non-empty text")
        if type(page_number) is not int or page_number < 1:
            raise ValueError("page_number must be a positive integer")
        if type(page_size) is not int or not 1 <= page_size <= MAX_PAGE_SIZE:
            raise ValueError(f"page_size must be between 1 and {MAX_PAGE_SIZE}")
        allowed_types = {"Foundation", "SR Legacy", "Branded", "Survey (FNDDS)"}
        if data_types is not None and (not data_types or set(data_types) - allowed_types):
            raise ValueError("data_types contains an unsupported USDA data type")
        payload: dict[str, Any] = {"query": query.strip(), "pageNumber": page_number,
                                   "pageSize": page_size}
        if data_types is not None:
            payload["dataType"] = list(data_types)
        result = self._request("foods/search", params={}, json=payload)
        if not isinstance(result, dict) or not isinstance(result.get("foods"), list):
            raise USDAFDCError("USDA returned an invalid search response")
        foods = tuple(_food_summary(food) for food in result["foods"] if isinstance(food, dict))
        total_pages = result.get("totalPages")
        total_hits = result.get("totalHits")
        return FoodPage(foods=foods, page_number=page_number,
                        total_pages=total_pages if type(total_pages) is int and total_pages >= 0 else None,
                        total_hits=total_hits if type(total_hits) is int and total_hits >= 0 else None)

    def get_food(self, fdc_id: int) -> dict[str, Any]:
        if type(fdc_id) is not int or fdc_id <= 0:
            raise ValueError("fdc_id must be a positive integer")
        result = self._request(f"food/{fdc_id}", params={})
        if not isinstance(result, dict):
            raise USDAFDCError("USDA returned an invalid food record")
        return _food_details(result)
