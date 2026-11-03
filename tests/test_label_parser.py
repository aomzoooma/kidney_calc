"""Synthetic-only tests for conservative nutrition-label text extraction."""

import unittest
from decimal import Decimal

from nutrition.label_parser import parse_nutrition_label


class NutritionLabelParserTest(unittest.TestCase):
    def test_parses_thai_values_and_explicit_per_serving_basis(self):
        result = parse_nutrition_label("""
หนึ่งหน่วยบริโภค 30 กรัม
คุณค่าทางโภชนาการต่อหนึ่งหน่วยบริโภค
พลังงาน 120 กิโลแคลอรี
โปรตีน 4 กรัม
โซเดียม 80 มิลลิกรัม
โพแทสเซียม 90 มก.
ฟอสฟอรัส 25 มก.
""")
        self.assertEqual(result.serving_basis.value, Decimal("30"))
        self.assertEqual(result.serving_basis.unit, "g")
        self.assertEqual(result.nutrients["energy_kcal"].value, Decimal("120"))
        self.assertEqual(result.nutrients["protein_g"].value, Decimal("4"))
        self.assertEqual(result.nutrients["sodium_mg"].value, Decimal("80"))
        self.assertEqual(result.nutrients["potassium_mg"].value, Decimal("90"))
        self.assertEqual(result.nutrients["phosphorus_mg"].value, Decimal("25"))
        self.assertTrue(result.requires_human_review)
        self.assertEqual(result.confidence, "low")

    def test_parses_english_values_and_per_100g_basis(self):
        result = parse_nutrition_label("""
Serving size 40 g
Nutrition per 100 g
Energy 200 kcal
Protein 8 g
Sodium 300 mg
Potassium 180 mg
Phosphorus 75 mg
""")
        self.assertEqual(result.nutrients["protein_g"].basis.value, Decimal("100"))
        self.assertEqual(result.nutrients["protein_g"].basis.unit, "g")
        self.assertEqual(result.nutrients["sodium_mg"].value, Decimal("300"))

    def test_missing_values_and_missing_nutrient_basis_are_unknown(self):
        missing = parse_nutrition_label("Serving size 1 pack\nNutrition per serving\nProtein 3 g")
        self.assertIsNone(missing.nutrients["sodium_mg"].value)
        no_basis = parse_nutrition_label("Protein 3 g\nSodium 10 mg")
        self.assertIsNone(no_basis.nutrients["protein_g"].value)
        self.assertIsNone(no_basis.serving_basis)

    def test_duplicate_or_conflicting_values_are_unknown(self):
        result = parse_nutrition_label("""
Serving size 30 g
Nutrition per serving
Sodium 10 mg
Sodium 20 mg
Protein 3 g
Protein 4 g
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)
        self.assertIsNone(result.nutrients["protein_g"].value)

        identical = parse_nutrition_label("Nutrition per serving\nSodium 10 mg\nSodium 10 mg")
        self.assertIsNone(identical.nutrients["sodium_mg"].value)

    def test_ignores_gda_percentages(self):
        result = parse_nutrition_label("""
Serving size 30 g
Nutrition per serving
GDA Sodium 800 mg 40%
Protein 5 g
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)
        self.assertIsNone(result.nutrients["protein_g"].value)

    def test_does_not_apply_serving_amount_to_per_100g_values(self):
        result = parse_nutrition_label("""
Serving size 30 g
Nutrition per 100 g
Protein 10 g
""")
        nutrient = result.nutrients["protein_g"]
        self.assertEqual(nutrient.value, Decimal("10"))
        self.assertEqual(nutrient.basis.value, Decimal("100"))
        self.assertNotEqual(nutrient.basis, result.serving_basis)

    def test_mixed_nutrient_bases_make_affected_value_unknown(self):
        result = parse_nutrition_label("""
Serving size 30 g
Nutrition per serving
Protein 5 g
Sodium 80 mg per 100 g
""")
        self.assertEqual(result.nutrients["protein_g"].value, Decimal("5"))
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_ambiguous_thousands_separator_stays_unknown(self):
        result = parse_nutrition_label("Nutrition per serving\nSodium 1,000 mg")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_two_amounts_on_one_nutrient_line_stay_unknown(self):
        result = parse_nutrition_label("Nutrition per serving\nSodium 10 mg 20 mg")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_conflicting_shared_basis_headers_invalidate_even_explicit_row_basis(self):
        result = parse_nutrition_label("""
Nutrition per serving
Nutrition per 100 g
Sodium 80 mg per 100 g
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_multiple_basis_tokens_on_same_header_invalidate_rows(self):
        result = parse_nutrition_label("""
Nutrition per serving and per 100 g
Sodium 80 mg per 100 g
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_gda_header_blocks_following_rows_until_new_basis_section(self):
        result = parse_nutrition_label("""
Nutrition per serving
Sodium GDA (%)
Sodium 800 mg
Protein 20 g
Nutrition per serving
Sodium 100 mg
""")
        self.assertEqual(result.nutrients["sodium_mg"].value, Decimal("100"))
        self.assertIsNone(result.nutrients["protein_g"].value)

    def test_second_numeric_column_without_unit_invalidates_row(self):
        result = parse_nutrition_label("Nutrition per serving\nSodium 10 mg 20")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_any_second_numeric_occurrence_invalidates_before_unit_validation(self):
        for line in ("Sodium 10 mg 20 mcg", "Sodium 10 mcg 20 mg", "Sodium 10 mg 1,000 mg"):
            with self.subTest(line=line):
                result = parse_nutrition_label(f"Nutrition per serving\n{line}")
                self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_nutrient_row_basis_does_not_end_gda_section(self):
        result = parse_nutrition_label("""
Nutrition per serving
GDA (%)
Sodium 10 mg per 100 g
Protein 3 g
Nutrition per serving
Sodium 20 mg
""")
        self.assertEqual(result.nutrients["sodium_mg"].value, Decimal("20"))
        self.assertIsNone(result.nutrients["protein_g"].value)

    def test_invalid_duplicate_row_invalidates_valid_value(self):
        result = parse_nutrition_label("""
Nutrition per serving
Sodium 10 mg
Sodium 1,000 mg
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_numeric_column_after_basis_marker_invalidates_row(self):
        result = parse_nutrition_label("Nutrition per serving\nSodium 10 mg per 100 g 20")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_zero_serving_size_is_unknown(self):
        result = parse_nutrition_label("Serving size 0 g\nNutrition per serving\nSodium 10 mg")
        self.assertIsNone(result.serving_basis)

    def test_row_per_serving_mismatching_shared_per_100g_is_unknown(self):
        result = parse_nutrition_label("""
Nutrition per 100 g
Sodium 10 mg per serving
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_less_than_gda_row_blocks_following_nutrients(self):
        result = parse_nutrition_label("""
Nutrition per serving
Sodium < 10 mg (GDA)
Protein 3 g
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)
        self.assertIsNone(result.nutrients["protein_g"].value)

    def test_percent_duplicate_invalidates_previously_valid_row(self):
        result = parse_nutrition_label("""
Nutrition per serving
Sodium 10 mg
Sodium 20 mg 10%
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_invalid_duplicate_serving_size_invalidates_basis(self):
        result = parse_nutrition_label("""
Serving size 30 g
Serving size 0 g
Nutrition per serving
Sodium 10 mg
""")
        self.assertIsNone(result.serving_basis)

    def test_inequality_duplicate_invalidates_previously_valid_row(self):
        result = parse_nutrition_label("""
Nutrition per serving
Sodium 10 mg
Sodium < 20 mg
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_unsupported_nutrient_row_does_not_end_gda_section(self):
        result = parse_nutrition_label("""
Nutrition per serving
GDA (%)
Fat 1 g per 100 g
Protein 3 g
""")
        self.assertIsNone(result.nutrients["protein_g"].value)

    def test_bound_values_are_not_exact_in_english_or_thai(self):
        for line in ("Sodium 10 mg or less", "Sodium 10 mg ไม่เกิน", "Sodium 10 mg หรือน้อยกว่า"):
            with self.subTest(line=line):
                result = parse_nutrition_label(f"Nutrition per serving\n{line}")
                self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_unsupported_duplicate_serving_unit_invalidates_basis(self):
        result = parse_nutrition_label("""
Serving size 30 g
Serving size 2 cups
Nutrition per serving
Sodium 10 mg
""")
        self.assertIsNone(result.serving_basis)

    def test_strict_lines_reject_approximate_values_and_headers(self):
        for line in ("Sodium approximately 10 mg", "Sodium 10 mg approx.", "Sodium 10 mg or less"):
            with self.subTest(line=line):
                result = parse_nutrition_label(f"Nutrition per serving\n{line}")
                self.assertIsNone(result.nutrients["sodium_mg"].value)
        malformed_header = parse_nutrition_label("Nutrition per serving or less\nSodium 10 mg")
        self.assertIsNone(malformed_header.nutrients["sodium_mg"].value)

    def test_serving_size_bounds_and_extra_words_are_unknown(self):
        for line in ("Serving size 30 g or less", "Serving size about 30 g"):
            with self.subTest(line=line):
                result = parse_nutrition_label(f"{line}\nNutrition per serving\nSodium 10 mg")
                self.assertIsNone(result.serving_basis)

    def test_bare_basis_does_not_reopen_gda_section(self):
        result = parse_nutrition_label("""
Nutrition per serving
GDA (%)
per serving
Sodium 10 mg
""")
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_parses_explicit_thai_html_table_rows(self):
        result = parse_nutrition_label("""
<table>
  <tr><th>หนึ่งหน่วยบริโภค 30 กรัม</th></tr>
  <tr><th>คุณค่าทางโภชนาการต่อหนึ่งหน่วยบริโภค</th></tr>
  <tr><td>โปรตีน</td><td>4 กรัม</td></tr>
  <tr><td>โซเดียม</td><td>80 มิลลิกรัม</td></tr>
</table>
""")
        self.assertEqual(result.serving_basis.value, Decimal("30"))
        self.assertEqual(result.serving_basis.unit, "g")
        self.assertEqual(result.nutrients["protein_g"].value, Decimal("4"))
        self.assertEqual(result.nutrients["sodium_mg"].value, Decimal("80"))

    def test_html_table_missing_basis_and_duplicate_rows_stay_unknown(self):
        no_basis = parse_nutrition_label("<table><tr><td>Protein</td><td>3 g</td></tr></table>")
        self.assertIsNone(no_basis.nutrients["protein_g"].value)

        duplicate = parse_nutrition_label("""
<table><tr><th>Nutrition per serving</th></tr>
<tr><td>Sodium</td><td>10 mg</td></tr>
<tr><td>Sodium</td><td>10 mg</td></tr></table>
""")
        self.assertIsNone(duplicate.nutrients["sodium_mg"].value)

    def test_html_table_conflicting_headers_and_script_text_do_not_supply_values(self):
        result = parse_nutrition_label("""
<script>Nutrition per serving Sodium 1 mg</script>
<table><tr><th>Nutrition per serving</th></tr>
<tr><th>Nutrition per 100 g</th></tr>
<tr><td>Sodium</td><td>80 mg</td></tr></table>
""")
        self.assertTrue(result.basis_conflict)
        self.assertIsNone(result.nutrients["sodium_mg"].value)

    def test_html_mode_ignores_script_style_figure_and_outside_table_text(self):
        script_only = parse_nutrition_label(
            "<script>\nNutrition per serving\nSodium 90 mg\n</script>"
        )
        self.assertTrue(all(item.value is None for item in script_only.nutrients.values()))

        result = parse_nutrition_label("""
Nutrition per serving
Sodium 10 mg
<script>\nNutrition per serving\nSodium 20 mg\n</script>
<style>Nutrition per serving Sodium 30 mg</style>
<figure>Nutrition per serving Sodium 40 mg</figure>
<table></table>
""")
        self.assertTrue(all(item.value is None for item in result.nutrients.values()))

        outside_value = parse_nutrition_label("""
Nutrition per serving
Sodium 10 mg
<table><tr><th>Nutrition per serving</th></tr></table>
""")
        self.assertIsNone(outside_value.nutrients["sodium_mg"].value)

    def test_html_table_ambiguous_columns_and_structure_yield_no_suggestions(self):
        ambiguous = (
            '<tr><td>Sodium</td><td></td><td>80 mg</td></tr>',
            '<tr><td colspan="2">Sodium 80 mg</td></tr>',
            '<tr><td rowspan="2">Sodium</td><td>80 mg</td></tr>',
            '<tr><td>Sodium</td><td>80</td><td>mg</td></tr>',
            '<tr><td>Sodium</td><td><table><tr><td>80 mg</td></tr></table></td></tr>',
            '<tr><td>Sodium</td><td>80 mg</td></table>',
        )
        for row in ambiguous:
            with self.subTest(row=row):
                result = parse_nutrition_label(
                    f'<table><tr><th>Nutrition per serving</th></tr>{row}</table>'
                )
                self.assertTrue(all(item.value is None for item in result.nutrients.values()))


if __name__ == "__main__":
    unittest.main()
