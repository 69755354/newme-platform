/**
 * leads/_utils/format.ts — T3-3 step 4 extracted from leads/page.tsx (L92-101)
 *
 * Pure formatting helpers for the leads dashboard. Zero business logic, zero
 * React runtime. Two utilities:
 *   - daysSince: integer day count from an ISO date string (null → null)
 *   - fmtAED: AED with thousands separators with empty string for zero
 */

import { formatAED } from "@/lib/display-format.mjs";

/** Whole days elapsed since `d`. Returns null when `d` is null. */
export function daysSince(d: string | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}

/** AED formatter: "" for zero/null, "AED 12,345" (whole dirhams) otherwise. */
export function fmtAED(v: number | null | undefined): string {
  if (v == null || v === 0) return "";
  return formatAED(v);
}