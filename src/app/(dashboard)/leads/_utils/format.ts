/**
 * leads/_utils/format.ts — T3-3 step 4 extracted from leads/page.tsx (L92-101)
 *
 * Pure formatting helpers for the leads dashboard. Zero business logic, zero
 * React runtime. Two utilities:
 *   - daysSince: integer day count from an ISO date string (null → null)
 *   - fmtAED: compact AED currency (M / K / full) with empty string for zero
 */

/** Whole days elapsed since `d`. Returns null when `d` is null. */
export function daysSince(d: string | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}

/** Compact AED formatter: "" for zero/null, "AED 1.2M" / "AED 45K" / "AED 9,999" otherwise. */
export function fmtAED(v: number | null | undefined): string {
  if (v == null || v === 0) return "";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}