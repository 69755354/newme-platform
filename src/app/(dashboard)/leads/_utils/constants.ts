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
export const PIPELINE_STAGES = [
  { key: "new", label: "New Lead", color: "#6B7280", bg: "bg-muted/30", border: "border-border/40" },
  { key: "contacted", label: "Contacted", color: "#C48A52", bg: "bg-amber-950/30", border: "border-amber-800/40" },
  { key: "requirement_confirmed", label: "Req Confirmed", color: "#E0B95A", bg: "bg-yellow-950/20", border: "border-yellow-800/40" },
  { key: "solution_submitted", label: "Solution Sub.", color: "#4A5568", bg: "bg-slate-950/20", border: "border-slate-800/40" },
  { key: "quotation_submitted", label: "Quotation Sub.", color: "#8B5CF6", bg: "bg-purple-950/20", border: "border-purple-800/40" },
  { key: "negotiation", label: "Negotiation", color: "#3B82F6", bg: "bg-blue-950/20", border: "border-blue-800/40" },
  { key: "pending_decision", label: "Pending Decision", color: "#F59E0B", bg: "bg-amber-950/20", border: "border-amber-800/40" },
  { key: "won", label: "Won", color: "#4ADE80", bg: "bg-emerald-950/20", border: "border-emerald-800/40" },
  { key: "lost", label: "Lost", color: "#6B7280", bg: "bg-muted/30", border: "border-border/40" },
] as const;

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