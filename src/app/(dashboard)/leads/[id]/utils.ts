// Pure utility helpers for the Lead Detail three-column layout.

import type { Lead } from "./types";
// Extracted verbatim from page.tsx (logic unchanged) so every column component
// can share them without duplication. Plain .ts — no JSX, no React.

export function fmtAED(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

export function daysSince(d: string | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}

// Build the Project Info batch-save draft from a lead row. Used both on initial
// fetch (keep form in sync with persisted values) and by resetProjectInfoDraft
// (undo local edits back to the last saved values).
export function projectDraftFromLead(l: Pick<Lead, "project_type" | "emirate" | "area" | "ac_brand" | "customer_budget"> | null | undefined) {
  return {
    project_type: l?.project_type || "",
    emirate: l?.emirate || "",
    area: l?.area || "",
    ac_brand: l?.ac_brand || "",
    customer_budget: l?.customer_budget != null ? String(l.customer_budget) : "",
  };
}

// Customer-status (hot/warm/cold/dormant) label + colour map. Takes the active
// `t` so labels localise. Kept here so both the header badges and any column can
// reuse it.
export const getStatusLabels = (
  t: (key: string) => string
): Record<string, { label: string; color: string; bg: string }> => ({
  hot: { label: "🔥 " + t("leads.hot"), color: "text-rose-400", bg: "bg-rose-500/10" },
  warm: { label: "☀️ " + t("leads.warm"), color: "text-amber-400", bg: "bg-amber-500/10" },
  cold: { label: "❄️ " + t("leads.cold"), color: "text-sky-400", bg: "bg-sky-500/10" },
  dormant: {
    label: "💤 " + t("leads.dormant"),
    color: "text-muted-foreground",
    bg: "bg-gray-500/10",
  },
});
