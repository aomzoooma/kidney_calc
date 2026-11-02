import unittest
from decimal import Decimal
from types import MappingProxyType

from nutrition.calculator import Measure, NutrientSource, calculate


def measure(quantity, unit='g', state='raw'):
    return Measure(Decimal(quantity), unit, state)


def source(reference, values, citation='test source', reviewed=True):
    return NutrientSource(reference, values, citation, reviewed)


class CalculateTest(unittest.TestCase):
    def test_portion_and_incomplete_nutrients(self):
        result, _ = calculate([
            (measure('200'), source(measure('100'), {'protein_g': Decimal('10'), 'sodium_mg': None})),
            (measure('50'), source(measure('100'), {'protein_g': Decimal('4'), 'sodium_mg': Decimal('100')})),
        ], Decimal('0.25'))
        self.assertEqual(result['protein_g'], (Decimal('5.5'), True))
        self.assertEqual(result['sodium_mg'], (Decimal('12.5'), False))
        self.assertEqual(result['potassium_mg'], (None, False))

    def test_known_zero_is_not_unknown(self):
        result, _ = calculate([(measure('1'), source(measure('1'), {'sodium_mg': Decimal('0')}))], Decimal('1'))
        self.assertEqual(result['sodium_mg'], (Decimal('0'), True))

    def test_invalid_values_rejected(self):
        for quantity, reference, portion, value in [
            ('-1', '1', '1', '0'), ('1', '0', '1', '0'), ('1', '1', '0', '0'),
            ('1', '1', '1.1', '0'), ('1', '1', '1', '-1'), ('NaN', '1', '1', '0'),
        ]:
            with self.subTest(quantity=quantity, reference=reference, portion=portion, value=value):
                with self.assertRaises(ValueError):
                    calculate([(measure(quantity), source(measure(reference), {'protein_g': Decimal(value)}))], Decimal(portion))

    def test_units_and_food_states_must_be_explicit_and_match(self):
        for amount, reference in [
            (measure('1', 'g'), measure('1', 'ml')),
            (measure('1', state='raw'), measure('1', state='cooked')),
            (measure('1', 'cup'), measure('1', 'cup')),
            (measure('1', state='unknown'), measure('1', state='unknown')),
            (Decimal('1'), Decimal('1')),
        ]:
            with self.subTest(amount=amount, reference=reference):
                with self.assertRaises(ValueError):
                    calculate([(amount, source(reference, {}))], Decimal('1'))

    def test_volume_as_sold(self):
        result, _ = calculate([(measure('15', 'ml', 'as_sold'), source(measure('5', 'ml', 'as_sold'),
                             {'sodium_mg': Decimal('100')}))], Decimal('0.5'))
        self.assertEqual(result['sodium_mg'], (Decimal('150'), True))

    def test_unreviewed_sources_are_reported(self):
        totals, pending = calculate([
            (measure('100'), source(measure('100'), {'protein_g': Decimal('5')}, 'label', False)),
            (measure('100'), source(measure('100'), {'protein_g': Decimal('2')}, 'table', True)),
        ], Decimal('1'))
        self.assertEqual(totals['protein_g'], (Decimal('7'), True))
        self.assertEqual(pending, ('label',))

    def test_source_metadata_required(self):
        for invalid in (source(measure('1'), {}, ''), source(measure('1'), {}, ' ', True),
                        source(measure('1'), {}, 'label', 'yes'), None):
            with self.subTest(source=invalid), self.assertRaises(ValueError):
                calculate([(measure('1'), invalid)], Decimal('1'))

    def test_reviewed_values_cannot_change_after_creation(self):
        values = {'protein_g': Decimal('5')}
        item = source(measure('100'), values, 'label', True)
        values['protein_g'] = Decimal('500')
        with self.assertRaises(TypeError):
            item.values['protein_g'] = Decimal('500')
        totals, pending = calculate([(measure('100'), item)], Decimal('1'))
        self.assertEqual(totals['protein_g'], (Decimal('5'), True))
        self.assertEqual(pending, ())

    def test_proxy_backing_mapping_is_snapshotted(self):
        backing = {'protein_g': Decimal('5')}
        item = source(measure('100'), MappingProxyType(backing), 'label', True)
        backing['protein_g'] = Decimal('500')
        totals, _ = calculate([(measure('100'), item)], Decimal('1'))
        self.assertEqual(totals['protein_g'], (Decimal('5'), True))

    def test_empty_recipe_rejected(self):
        for ingredients in ([], iter([])):
            with self.subTest(ingredients=ingredients):
                with self.assertRaises(ValueError):
                    calculate(ingredients, Decimal('1'))


if __name__ == '__main__':
    unittest.main()
