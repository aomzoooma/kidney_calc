"""Synthetic contract tests for USDA FoodData Central; no live API calls."""

import json
import unittest
from decimal import Decimal
from unittest.mock import patch

import httpx

from nutrition.usda_fdc import USDAFDCClient, USDAFDCError, _food_state


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def adapter_for(http):
    with patch.dict("os.environ", {"USDA_FDC_API_KEY": "test-secret"}):
        return USDAFDCClient(client=http)


class USDAFDCTest(unittest.TestCase):
    def test_search_is_paged_and_preserves_source_identity_and_prep(self):
        seen = {}

        def handle(request):
            seen["body"] = request.read()
            seen["key"] = request.url.params.get("api_key")
            return httpx.Response(200, json={
                "totalPages": 3, "totalHits": 51,
                "foods": [{"fdcId": 987, "dataType": "Foundation",
                           "publishedDate": "2026-05-01",
                           "description": "Rice, brown, long-grain, cooked"},
                          {"fdcId": 988, "dataType": "Branded",
                           "description": "Rice, brown, long-grain, cooked"}],
            })

        with client_for(handle) as http:
            page = adapter_for(http).search(
                "brown rice", page_number=2, page_size=25, data_types=("Foundation",))
        self.assertEqual(seen["key"], "test-secret")
        self.assertEqual(json.loads(seen["body"]), {
            "query": "brown rice", "pageNumber": 2, "pageSize": 25,
            "dataType": ["Foundation"],
        })
        self.assertEqual(page.page_number, 2)
        self.assertEqual(page.total_pages, 3)
        self.assertTrue(page.has_next_page)
        self.assertEqual(page.foods[0]["source_id"], "USDA-FDC:987")
        self.assertEqual(page.foods[0]["source_type"], "Foundation")
        self.assertEqual(page.foods[0]["source_version"], "2026-05-01")
        self.assertEqual(page.foods[0]["food_state"], "cooked")
        self.assertEqual(len(page.foods), 1)
        self.assertTrue(page.foods[0]["requires_human_review"])
        self.assertFalse(page.foods[0]["imported"])

    def test_details_keep_missing_unknown_and_genuine_zero_distinct(self):
        def handle(_request):
            return httpx.Response(200, json={
                "fdcId": 123, "dataType": "SR Legacy", "publishedDate": "2019-04-01",
                "description": "Spinach, raw",
                "foodNutrients": [
                    {"nutrient": {"id": 1008, "unitName": "KCAL"}, "amount": 23},
                    {"nutrient": {"id": 1003, "unitName": "G"}, "amount": 2.86},
                    {"nutrient": {"id": 1093, "unitName": "MG"}, "amount": 0},
                    {"nutrient": {"id": 1092, "unitName": "mg"}, "amount": 558},
                    # A present value with an unexpected unit is unknown, not coerced.
                    {"nutrient": {"id": 1091, "unitName": "g"}, "amount": 0.099},
                    # Conflicting duplicates remain unknown instead of last-write-wins.
                    {"nutrient": {"id": 1091, "unitName": "mg"}, "amount": 99},
                ],
            })

        with client_for(handle) as http:
            food = adapter_for(http).get_food(123)
        self.assertEqual(food["food_state"], "raw")
        self.assertEqual(food["source_id"], "USDA-FDC:123")
        self.assertEqual(food["source_type"], "SR Legacy")
        self.assertEqual(food["source_version"], "2019-04-01")
        self.assertEqual(food["basis_quantity"], Decimal("100"))
        self.assertEqual(food["basis_unit"], "g")
        self.assertEqual(food["nutrients"]["sodium_mg"], Decimal("0"))
        self.assertEqual(food["nutrients"]["energy_kcal"], Decimal("23"))
        self.assertEqual(food["nutrients"]["protein_g"], Decimal("2.86"))
        self.assertEqual(food["nutrients"]["potassium_mg"], Decimal("558"))
        self.assertIsNone(food["nutrients"]["phosphorus_mg"])
        self.assertEqual(food["nutrient_units"]["phosphorus_mg"], "mg")

    def test_conflicting_foundation_energy_candidates_are_unknown_and_retained(self):
        def handle(_request):
            return httpx.Response(200, json={
                "fdcId": 456, "dataType": "Foundation", "publishedDate": "2026-10-01",
                "description": "Oats, raw",
                "foodNutrients": [
                    {"nutrient": {"id": 1008, "unitName": "KCAL"}, "amount": 380},
                    {"nutrient": {"id": 2047, "unitName": "KCAL"}, "amount": 389},
                    {"nutrient": {"id": 2048, "unitName": "KCAL"}, "amount": 376},
                ],
            })

        with client_for(handle) as http:
            food = adapter_for(http).get_food(456)
        self.assertIsNone(food["nutrients"]["energy_kcal"])
        self.assertTrue(food["energy_ambiguous"])
        self.assertEqual(
            [(candidate["nutrient_id"], candidate["value"]) for candidate in food["energy_candidates"]],
            [(1008, Decimal("380")), (2047, Decimal("389")), (2048, Decimal("376"))],
        )

    def test_conflicting_nonfoundation_energy_candidates_are_unknown(self):
        def handle(_request):
            return httpx.Response(200, json={
                "fdcId": 457, "dataType": "Survey (FNDDS)",
                "description": "Oatmeal, cooked",
                "foodNutrients": [
                    {"nutrient": {"id": 1008, "unitName": "KCAL"}, "amount": 71},
                    {"nutrient": {"id": 2047, "unitName": "KCAL"}, "amount": 72},
                ],
            })

        with client_for(handle) as http:
            food = adapter_for(http).get_food(457)
        self.assertIsNone(food["nutrients"]["energy_kcal"])
        self.assertTrue(food["energy_ambiguous"])
        self.assertEqual(
            [(candidate["nutrient_id"], candidate["value"]) for candidate in food["energy_candidates"]],
            [(1008, Decimal("71")), (2047, Decimal("72"))],
        )

    def test_invalid_foundation_candidate_is_not_masked_by_other_energy_value(self):
        def handle(_request):
            return httpx.Response(200, json={
                "fdcId": 458, "dataType": "Foundation", "description": "Food, raw",
                "foodNutrients": [
                    {"nutrient": {"id": 1008, "unitName": "KCAL"}, "amount": 10},
                    {"nutrient": {"id": 2047, "unitName": "kJ"}, "amount": 42},
                ],
            })

        with client_for(handle) as http:
            food = adapter_for(http).get_food(458)
        self.assertIsNone(food["nutrients"]["energy_kcal"])
        self.assertTrue(food["energy_ambiguous"])
        self.assertEqual(food["energy_candidates"][1], {
            "nutrient_id": 2047, "value": None, "source_value": Decimal("42"), "unit": "kJ",
        })

    def test_equal_energy_values_from_multiple_ids_are_retained_without_conflict(self):
        def handle(_request):
            return httpx.Response(200, json={
                "fdcId": 459, "dataType": "Foundation", "description": "Food, raw",
                "foodNutrients": [
                    {"nutrient": {"id": 2047, "unitName": "KCAL"}, "amount": 11},
                    {"nutrient": {"id": 2048, "unitName": "KCAL"}, "amount": 11},
                ],
            })

        with client_for(handle) as http:
            food = adapter_for(http).get_food(459)
        self.assertEqual(food["nutrients"]["energy_kcal"], Decimal("11"))
        self.assertFalse(food["energy_ambiguous"])
        self.assertEqual([candidate["nutrient_id"] for candidate in food["energy_candidates"]], [2047, 2048])

    def test_unknown_prep_is_not_guessed_and_branded_stays_as_sold(self):
        self.assertIsNone(_food_state("Rice", "Foundation"))
        self.assertEqual(_food_state("Rice", "Branded"), "as_sold")

    def test_missing_key_and_bad_arguments_fail_before_request(self):
        with self.assertRaises(USDAFDCError):
            with patch.dict("os.environ", {"USDA_FDC_API_KEY": " "}):
                USDAFDCClient()
        with client_for(lambda _request: self.fail("unexpected request")) as http:
            adapter = adapter_for(http)
            for kwargs in ({"page_number": 0}, {"page_size": 51}):
                with self.assertRaises(ValueError):
                    adapter.search("rice", **kwargs)
            with self.assertRaises(ValueError):
                adapter.get_food(0)

    def test_rate_limit_errors_are_safe_and_do_not_echo_key_or_body(self):
        def handle(_request):
            return httpx.Response(429, text="test-secret private-response")

        with client_for(handle) as http:
            adapter = adapter_for(http)
            with self.assertRaisesRegex(USDAFDCError, "request limit") as error:
                adapter.search("rice")
        self.assertNotIn("test-secret", str(error.exception))
        self.assertNotIn("private-response", str(error.exception))

    def test_redirect_is_refused(self):
        with client_for(lambda _request: httpx.Response(302, headers={"Location": "https://example.com"})) as http:
            with self.assertRaisesRegex(USDAFDCError, "redirect refused"):
                adapter_for(http).search("rice")

    def test_streaming_response_limit_stops_reading_at_limit(self):
        class Chunks(httpx.SyncByteStream):
            def __init__(self):
                self.consumed = 0

            def __iter__(self):
                for chunk in (b"12345678", b"abcdefgh", b"must-not-be-read"):
                    self.consumed += 1
                    yield chunk

            def close(self):
                pass

        stream = Chunks()
        with client_for(lambda _request: httpx.Response(200, stream=stream)) as http:
            adapter = adapter_for(http)
            with patch("nutrition.usda_fdc.MAX_RESPONSE_BYTES", 12):
                with self.assertRaisesRegex(USDAFDCError, "exceeds the supported size"):
                    adapter.search("rice")
        self.assertEqual(stream.consumed, 2)


if __name__ == "__main__":
    unittest.main()
