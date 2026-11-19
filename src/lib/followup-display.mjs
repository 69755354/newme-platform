// Display helpers for the follow-up card (S21).
export function followupStateTone(state) {
  if (state === "overdue") return "bg-red-500/15 text-red-400";
  if (state === "at_risk") return "bg-amber-500/15 text-amber-400";
  return "bg-emerald-500/15 text-emerald-400";
}

export function formatSuggestedValue(field, value) {
  if (field === "budget_aed" && typeof value === "number") return `AED ${value.toLocaleString("en-US")}`;
  if (field === "area_sqm" && typeof value === "number") return `${value} m²`;
  return String(value);
}
