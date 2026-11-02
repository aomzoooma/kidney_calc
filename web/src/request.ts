export const nutrients = [
  ['energy_kcal', 'พลังงาน', 'กิโลแคลอรี'],
  ['protein_g', 'โปรตีน', 'กรัม'],
  ['sodium_mg', 'โซเดียม', 'มก.'],
  ['potassium_mg', 'โพแทสเซียม', 'มก.'],
  ['phosphorus_mg', 'ฟอสฟอรัส', 'มก.'],
] as const
export type NutrientKey = typeof nutrients[number][0]
export type FoodState = 'raw' | 'cooked' | 'as_sold'
export type IngredientSource = 'manual' | 'usda' | 'seasoning' | 'saved'
export type Ingredient = {
  name: string; amount: string; unit: 'g' | 'ml'; state: FoodState; reference: string;
  values: Record<NutrientKey, string>; source: IngredientSource; seasoningVersionId: number | null;
  ingredientVersionId: number | null; fdcId: number | null; fdcState: FoodState | null
}
export type SavedSeasoning = {
  version_id: number; name: string; brand: string | null; basis_quantity: string; basis_unit: 'g' | 'ml';
  reviewed: boolean; nutrients: Record<NutrientKey, string | null>
}
export type SavedIngredient = {
  ingredient_id: number; version_id: number; name: string; brand: string | null;
  version: string; provider: string; source_version: string; source_date: string | null;
  retrieved_on: string; source_reference: string; provenance: string;
  basis_quantity: string; basis_unit: 'g' | 'ml'; food_state: FoodState; reviewed: true;
  nutrients: Record<NutrientKey, string | null>
}

export const isCurrentRevision = (submitted: number, current: number) => submitted === current

export function buildCalculationPayload(ingredients: Ingredient[], portion: string) {
  return {
    synthetic_only: true as const, portion,
    ingredients: ingredients.map(item => ({
      amount: item.amount, unit: item.unit, food_state: item.state,
      reference_quantity: item.reference, reference_unit: item.unit, reference_food_state: item.state,
      source_type: item.source ?? (item.seasoningVersionId != null ? 'seasoning' : item.fdcId != null ? 'usda' : 'manual'),
      ...(item.seasoningVersionId == null ? {} : { seasoning_version_id: item.seasoningVersionId }),
      ...(item.ingredientVersionId == null ? {} : { ingredient_version_id: item.ingredientVersionId }),
      ...(item.ingredientVersionId != null || item.seasoningVersionId != null
        ? {}
        : item.fdcId == null
          ? Object.fromEntries(nutrients.map(([key]) => [key, item.values[key].trim() || null]))
          : { fdc_id: item.fdcId }),
    })),
  }
}
