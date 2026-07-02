"use client";

/**
 * useLeadsFiltering — T3-3 step 15 extracted from leads/page.tsx (was L167-230)
 *
 * Pure derivation hook for the leads dashboard filter pipeline. Owns:
 *   1. `filtered` — the leads array after all 11 filter clauses + sort
 *   2. `columns`  — bucketed-by-stage index (filtered leads → 9 stage buckets)
 *   3. `stageTotals` — per-stage {count, value} for the summary strip
 *   4. `sources` — distinct source values across all leads (filter dropdown)
 *
 * Receives leads + every filter state value. Does NOT receive setters
 * — filter mutation lives on the page because LeadsFilters calls those
 * setters directly. The hook is purely a derived-state calculator with
 * the same useMemo dependency surface as the inline version, so users
 * see byte-identical filter results.
 *
 * Filter clauses preserved verbatim (in order):
 *   - stageFilter        (final_status || stage lookup)
 *   - sourceFilter       (exact match)
 *   - statusFilter       (lead_status exact)
 *   - qualityFilter      (quality exact)
 *   - probabilityFilter  (win_probability exact, nullable)
 *   - alertFilter        (yellow: 7≤d<14 days since last contact, no
 *                         final_status; red: d≥14, no final_status;
 *                         uses daysSince helper on last_contact_date or
 *                         updated_at fallback)
 *   - recoveryFilter     (recovery_candidate truthy)
 *   - transferFilter     (transfer_candidate truthy)
 *   - reviewFilter       (sales_manager_review truthy)
 *   - assignedToFilter   (assigned_to exact, "all" otherwise)
 *   - followupFilter     (next_followup_date ≤ today AND no final_status)
 *   - search (trim)      (case-insensitive substring across
 *                         customer_name / phone / location / assigned_to)
 * Final step: sort by updated_at desc.
 *
 * Behaviour contract: 100% identical filter result. Memoisation deps
 * match the inline version, so no spurious recomputes and no missed
 * recomputes.
 */

import { useMemo } from "react";
import { Lead } from "./useLeadsData";
import { PIPELINE_STAGES } from "../_utils/constants";
import { daysSince } from "../_utils/format";

export type StageTotal = { count: number; value: number };

export type FilterColumns = Record<string, Lead[]>;
export type FilterStageTotals = Record<string, StageTotal>;

type FilterParams = {
  leads: Lead[];
  search: string;
  stageFilter: string;
  sourceFilter: string;
  statusFilter: string;
  qualityFilter: string;
  probabilityFilter: number | null;
  alertFilter: string;
  recoveryFilter: boolean;
  transferFilter: boolean;
  reviewFilter: boolean;
  followupFilter: boolean;
  assignedToFilter: string;
};

export function useLeadsFiltering({
  leads,
  search,
  stageFilter,
  sourceFilter,
  statusFilter,
  qualityFilter,
  probabilityFilter,
  alertFilter,
  recoveryFilter,
  transferFilter,
  reviewFilter,
  followupFilter,
  assignedToFilter,
}: FilterParams) {
  const filtered = useMemo(() => {
    let result = [...leads];
    if (stageFilter !== "all")
      result = result.filter((l) => (l.final_status || l.stage) === stageFilter);
    if (sourceFilter !== "all") result = result.filter((l) => l.source === sourceFilter);
    if (statusFilter !== "all") result = result.filter((l) => l.lead_status === statusFilter);
    if (qualityFilter !== "all") result = result.filter((l) => l.quality === qualityFilter);
    if (probabilityFilter !== null)
      result = result.filter((l) => l.win_probability === probabilityFilter);
    if (alertFilter === "yellow") {
      result = result.filter((l) => {
        const d = daysSince(l.last_contact_date || l.updated_at);
        return d !== null && d >= 7 && d < 14 && !l.final_status;
      });
    }
    if (alertFilter === "red") {
      result = result.filter((l) => {
        const d = daysSince(l.last_contact_date || l.updated_at);
        return d !== null && d >= 14 && !l.final_status;
      });
    }
    if (recoveryFilter) result = result.filter((l) => l.recovery_candidate);
    if (transferFilter) result = result.filter((l) => l.transfer_candidate);
    if (reviewFilter) result = result.filter((l) => l.sales_manager_review);
    if (assignedToFilter !== "all")
      result = result.filter((l) => l.assigned_to === assignedToFilter);
    if (followupFilter) {
      const todayStr = new Date().toISOString().split("T")[0];
      result = result.filter((l) => {
        if (!l.next_followup_date) return false;
        if (l.final_status) return false;
        return l.next_followup_date <= todayStr;
      });
    }
    if (search.trim()) {
      const s = search.toLowerCase().trim();
      result = result.filter(
        (l) =>
          (l.customer_name || "").toLowerCase().includes(s) ||
          (l.phone || "").includes(s) ||
          (l.location || "").toLowerCase().includes(s) ||
          (l.assigned_to || "").toLowerCase().includes(s)
      );
    }
    result.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
    return result;
  }, [
    leads,
    search,
    stageFilter,
    sourceFilter,
    statusFilter,
    alertFilter,
    recoveryFilter,
    transferFilter,
    reviewFilter,
    probabilityFilter,
    followupFilter,
    assignedToFilter,
    qualityFilter,
  ]);

  const columns = useMemo(() => {
    const g: FilterColumns = {};
    for (const s of PIPELINE_STAGES) g[s.key] = [];
    // won/lost now live in final_status; fall back to stage for the dual-source transition
    for (const l of filtered) {
      const key = l.final_status || l.stage;
      if (g[key]) g[key].push(l);
    }
    return g;
  }, [filtered]);

  const stageTotals = useMemo(() => {
    const t: FilterStageTotals = {};
    for (const s of PIPELINE_STAGES) {
      t[s.key] = {
        count: columns[s.key]?.length || 0,
        value: columns[s.key]?.reduce((sum, l) => sum + (l.quotation_value || 0), 0) || 0,
      };
    }
    return t;
  }, [columns]);

  const sources = useMemo(
    () => [...new Set(leads.map((l) => l.source))].filter(Boolean).sort(),
    [leads]
  );

  return { filtered, columns, stageTotals, sources };
}
