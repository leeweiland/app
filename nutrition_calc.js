// nutrition_calc.js — deterministic calorie/macro math (Mifflin-St Jeor),
// not AI-guessed. Shared by body_analysis_backend.js (a scan's saved macro
// plan) and body_stats_backend.js (the Food Log profile's live estimate) so
// the formula lives in exactly one place.

export function calcCalorieTarget({ heightCm, weightKg, age, sex, activityLevel, goal }) {
  const h = Number(heightCm), w = Number(weightKg), a = Number(age) || 30;
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
