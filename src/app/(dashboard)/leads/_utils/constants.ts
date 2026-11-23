/**
 * leads/_utils/constants.ts — T3-3 step 4 extracted from leads/page.tsx (L28-70)
 *
 * Pure constants module for the leads dashboard. Zero business logic, zero
 * React runtime — consumed by leads/page.tsx and any future lead-feature
 * components. Grouped by domain:
 *   - 9-stage pipeline definition (PIPELINE_STAGES) and per-stage chip colors
 *   - lead-status tailwind class lookups
 *   - win-probability buckets and lost-reason enum
 *   - placeholder detector for DB "unknown"/"n/a"/"-" values
 */

/* ─── 9-stage pipeline ─── */
export { PIPELINE_STAGES } from "@/shared/kanban/types";

export { STAGE_CLASS as STAGE_COLORS } from "@/lib/status-palette";

// Filter out DB placeholder values that should show as "no data"
export const isPlaceholder = (v: string | null | undefined): boolean => {
  if (!v) return true;
  const lower = v.toLowerCase().trim();
  return lower === "unknown" || lower === "n/a" || lower === "" || lower === "-";
};

import { LEAD_STATUS_CLASS } from "@/lib/status-palette";
// Calm palette (S38): only "hot" gets the accent; no emoji in the UI.
export const STATUS_LABELS: Record<string, { color: string; bg: string }> = Object.fromEntries(
  Object.entries(LEAD_STATUS_CLASS).map(([k, v]) => {
    const [bg, color] = v.split(" ");
    return [k, { bg, color }];
  }),
);
export const PROBABILITIES = [10, 30, 50, 70, 90];
export const LOST_REASONS = ["Price", "Competitor", "No Budget", "Project Cancelled", "Project Delayed", "No Response", "Other"];
