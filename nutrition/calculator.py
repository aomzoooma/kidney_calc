"""Calculate known nutrient contributions and preserve missing data."""

from decimal import Decimal


NUTRIENTS = ('energy_kcal', 'protein_g', 'sodium_mg', 'potassium_mg', 'phosphorus_mg')


def _positive(value):
    return isinstance(value, Decimal) and value.is_finite() and value > 0


def calculate(ingredients, portion):
    """Scale nutrients per reference quantity by quantity and fraction consumed.

    Each ingredient is (quantity, reference_quantity, nutrient_values). Both
    quantities must use the same unit. None or a missing nutrient means unknown.
    Returns nutrient -> (known subtotal or None, complete).
    """
    if not ingredients or not _positive(portion) or portion > 1:
        raise ValueError('A nonempty recipe and portion in (0, 1] are required')

    totals = {name: None for name in NUTRIENTS}
    complete = {name: True for name in NUTRIENTS}
    for quantity, reference, values in ingredients:
        if not _positive(quantity) or not _positive(reference):
            raise ValueError('Quantities must be positive finite decimals')
        if set(values) - set(NUTRIENTS):
            raise ValueError('Unknown nutrient key')
        for name in NUTRIENTS:
            value = values.get(name)
            if value is None:
                complete[name] = False
            elif not isinstance(value, Decimal) or not value.is_finite() or value < 0:
                raise ValueError('Nutrients must be nonnegative finite decimals or None')
            else:
                contribution = value * quantity / reference * portion
                totals[name] = (totals[name] if totals[name] is not None else Decimal(0)) + contribution
    return {name: (totals[name], complete[name]) for name in NUTRIENTS}
