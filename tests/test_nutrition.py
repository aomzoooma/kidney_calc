import unittest
from decimal import Decimal

from nutrition.calculator import calculate


class CalculateTest(unittest.TestCase):
    def test_portion_and_incomplete_nutrients(self):
        result = calculate([
            (Decimal('200'), Decimal('100'), {'protein_g': Decimal('10'), 'sodium_mg': None}),
            (Decimal('50'), Decimal('100'), {'protein_g': Decimal('4'), 'sodium_mg': Decimal('100')}),
        ], Decimal('0.25'))
        self.assertEqual(result['protein_g'], (Decimal('5.5'), True))
        self.assertEqual(result['sodium_mg'], (Decimal('12.5'), False))
        self.assertEqual(result['potassium_mg'], (None, False))

    def test_known_zero_is_not_unknown(self):
        result = calculate([(Decimal('1'), Decimal('1'), {'sodium_mg': Decimal('0')})], Decimal('1'))
        self.assertEqual(result['sodium_mg'], (Decimal('0'), True))

    def test_invalid_values_rejected(self):
        for quantity, reference, portion, value in [
            ('-1', '1', '1', '0'), ('1', '0', '1', '0'), ('1', '1', '0', '0'),
            ('1', '1', '1.1', '0'), ('1', '1', '1', '-1'), ('NaN', '1', '1', '0'),
        ]:
            with self.subTest(quantity=quantity, reference=reference, portion=portion, value=value):
                with self.assertRaises(ValueError):
                    calculate([(Decimal(quantity), Decimal(reference), {'protein_g': Decimal(value)})], Decimal(portion))

    def test_empty_recipe_rejected(self):
        with self.assertRaises(ValueError):
            calculate([], Decimal('1'))


if __name__ == '__main__':
    unittest.main()
