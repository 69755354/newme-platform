/**
 * leads/_utils/constants.ts — T3-3 step 4 extracted from leads/page.tsx (L28-70)
 *
 * Pure constants module for the leads dashboard. Zero business logic, zero
 * React runtime — consumed by leads/page.tsx and any future lead-feature
 * components. Grouped by domain:
 *   - 9-stage pipeline definition (PIPELINE_STAGES) and per-stage chip colors
 *   - lead-status emoji + tailwind class lookups
 *   - lead-source emoji icons
 *   - win-probability buckets and lost-reason enum
 *   - placeholder detector for DB "unknown"/"n/a"/"-" values
 */

/* ─── 9-stage pipeline ─── */
export { PIPELINE_STAGES } from "@/shared/kanban/types";

export const STATUS_EMOJIS: Record<string, string> = {
  hot: "🔥", warm: "☀️", cold: "❄️", dormant: "💤",
};

export const STAGE_COLORS: Record<string, string> = {
  new: "bg-gray-500/10 text-muted-foreground", contacted: "bg-amber-500/10 text-amber-400",
  requirement_confirmed: "bg-yellow-500/10 text-yellow-400", solution_submitted: "bg-rose-500/10 text-rose-400",
  quotation_submitted: "bg-purple-500/10 text-purple-400", negotiation: "bg-blue-500/10 text-blue-400",
  pending_decision: "bg-amber-500/10 text-amber-400", won: "bg-emerald-500/10 text-emerald-400",
  lost: "bg-gray-500/10 text-muted-foreground",
};

// Filter out DB placeholder values that should show as "no data"
export const isPlaceholder = (v: string | null | undefined): boolean => {
  if (!v) return true;
  const lower = v.toLowerCase().trim();
  return lower === "unknown" || lower === "n/a" || lower === "" || lower === "-";
};

export const SOURCE_ICONS: Record<string, string> = {
  meta_ads: "📱", whatsapp: "💬", website: "🌐", offline: "🏢", referral: "🤝", other: "📋",
};
export const STATUS_LABELS: Record<string, { color: string; bg: string }> = {
  hot: { color: "text-rose-400", bg: "bg-rose-500/10" },
  warm: { color: "text-amber-400", bg: "bg-amber-500/10" },
  cold: { color: "text-sky-400", bg: "bg-sky-500/10" },
  dormant: { color: "text-muted-foreground", bg: "bg-gray-500/10" },
};
export const PROBABILITIES = [10, 30, 50, 70, 90];
export const LOST_REASONS = ["Price", "Competitor", "No Budget", "Project Cancelled", "Project Delayed", "No Response", "Other"];
