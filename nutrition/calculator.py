"""Calculate known nutrient contributions and preserve missing data."""

from decimal import Decimal
from dataclasses import dataclass
from collections.abc import Mapping
from types import MappingProxyType


NUTRIENTS = ('energy_kcal', 'protein_g', 'sodium_mg', 'potassium_mg', 'phosphorus_mg')


@dataclass(frozen=True)
class Measure:
    quantity: Decimal
    unit: str
    food_state: str


@dataclass(frozen=True)
class NutrientSource:
    reference: Measure
    values: dict
    citation: str
    reviewed: bool = False

    def __post_init__(self):
        if isinstance(self.values, Mapping):
            object.__setattr__(self, 'values', MappingProxyType(dict(self.values)))


def _positive(value):
    return isinstance(value, Decimal) and value.is_finite() and value > 0


def calculate(ingredients, portion):
    """Scale nutrients per reference quantity by quantity and fraction consumed.

    Each ingredient is (amount, source); the source binds its reference basis,
    values and citation. Review is a recorded human assertion, not proof.
    Returns (nutrient totals, citations needing review). None means unknown.
    """
    if not _positive(portion) or portion > 1:
        raise ValueError('A nonempty recipe and portion in (0, 1] are required')

    totals = {name: None for name in NUTRIENTS}
    complete = {name: True for name in NUTRIENTS}
    unreviewed = []
    found_ingredient = False
    for amount, source in ingredients:
        found_ingredient = True
        if (not isinstance(source, NutrientSource) or not isinstance(source.citation, str)
                or not source.citation.strip() or type(source.reviewed) is not bool
                or not isinstance(source.values, MappingProxyType)):
            raise ValueError('A source citation, nutrient values and review status are required')
        reference, values = source.reference, source.values
        if not source.reviewed:
            unreviewed.append(source.citation)
        if not isinstance(amount, Measure) or not isinstance(reference, Measure):
            raise ValueError('Amount and reference must specify units and food state')
        if not _positive(amount.quantity) or not _positive(reference.quantity):
            raise ValueError('Quantities must be positive finite decimals')
        if (amount.unit not in ('g', 'ml') or amount.unit != reference.unit
                or amount.food_state not in ('raw', 'cooked', 'as_sold')
                or amount.food_state != reference.food_state):
            raise ValueError('Units and food states must be supported and match')
        if set(values) - set(NUTRIENTS):
            raise ValueError('Unknown nutrient key')
        for name in NUTRIENTS:
            value = values.get(name)
            if value is None:
                complete[name] = False
            elif not isinstance(value, Decimal) or not value.is_finite() or value < 0:
                raise ValueError('Nutrients must be nonnegative finite decimals or None')
            else:
                contribution = value * amount.quantity / reference.quantity * portion
                totals[name] = (totals[name] if totals[name] is not None else Decimal(0)) + contribution
    if not found_ingredient:
        raise ValueError('A nonempty recipe and portion in (0, 1] are required')
    return {name: (totals[name], complete[name]) for name in NUTRIENTS}, tuple(unreviewed)
