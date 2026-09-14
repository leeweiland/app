// nutrition_calc.js — deterministic calorie/macro math (Mifflin-St Jeor),
// not AI-guessed. Shared by body_analysis_backend.js (a scan's saved macro
// plan) and body_stats_backend.js (the Food Log profile's live estimate) so
// the formula lives in exactly one place.

// Clamps a value into a plausible human range for its kind — a bad input
// (a height-field typo that produces something like 1,695,005cm, a weight
// pasted in the wrong unit, etc.) used to flow straight into the BMR
// formula unchecked, where a wildly-out-of-range height alone could
// dominate the whole calculation and produce a multi-million-calorie
// target. Clamping here means every caller of calcCalorieTarget is
// protected, not just whichever form happens to validate its own inputs.
function clampPlausible(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function calcCalorieTarget({ heightCm, weightKg, age, sex, activityLevel, goal }) {
  const h = clampPlausible(heightCm, 100, 250, 170);   // 3'3" to 8'2"
  const w = clampPlausible(weightKg, 30, 300, 70);      // ~66lb to ~660lb
  const a = clampPlausible(age, 10, 100, 30);
  const bmr = sex === "female"
    ? 10 * w + 6.25 * h - 5 * a - 161
    : 10 * w + 6.25 * h - 5 * a + 5;
  const activityMultipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  const tdee = bmr * (activityMultipliers[activityLevel] || 1.375);
  const goalMultipliers = { reduce: 0.8, maintain: 1.0, increase: 1.1 };
  return Math.round(tdee * (goalMultipliers[goal] || goalMultipliers.reduce));
}

export function calcMacros(calories) {
  // 40% protein / 30% fat / 30% carb, per the requested split.
  const proteinCal = calories * 0.40, fatCal = calories * 0.30, carbCal = calories * 0.30;
  return {
    proteinG: Math.round(proteinCal / 4),
    fatG: Math.round(fatCal / 9),
    carbG: Math.round(carbCal / 4),
  };
}

export function buildMealPlan(macros, calories) {
  // Even split across 6 meals — simple and predictable, matches what was asked for.
  const perMeal = {
    calories: Math.round(calories / 6),
    proteinG: Math.round(macros.proteinG / 6),
    fatG: Math.round(macros.fatG / 6),
    carbG: Math.round(macros.carbG / 6),
  };
  return Array.from({ length: 6 }, (_, i) => ({ meal: i + 1, ...perMeal }));
}
