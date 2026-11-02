export const nutrients = [
  ['energy_kcal', 'พลังงาน', 'กิโลแคลอรี'],
  ['protein_g', 'โปรตีน', 'กรัม'],
  ['sodium_mg', 'โซเดียม', 'มก.'],
  ['potassium_mg', 'โพแทสเซียม', 'มก.'],
  ['phosphorus_mg', 'ฟอสฟอรัส', 'มก.'],
] as const
export type NutrientKey = typeof nutrients[number][0]
export type FoodState = 'raw' | 'cooked' | 'as_sold'
export type Ingredient = {
  name: string; amount: string; unit: 'g' | 'ml'; state: FoodState; reference: string;
  values: Record<NutrientKey, string>
}

export const isCurrentRevision = (submitted: number, current: number) => submitted === current

export function buildCalculationPayload(ingredients: Ingredient[], portion: string) {
  return {
    synthetic_only: true as const, portion,
    ingredients: ingredients.map(item => ({
      amount: item.amount, unit: item.unit, food_state: item.state,
      reference_quantity: item.reference, reference_unit: item.unit, reference_food_state: item.state,
      ...Object.fromEntries(nutrients.map(([key]) => [key, item.values[key].trim() || null])),
    })),
  }
}
