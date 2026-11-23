import { formatAED } from "@/lib/display-format.mjs";

/** "AED 12,345" (whole dirhams, thousands separators). null / NaN -> "AED 0". */
export function fmtAED(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return "AED 0";
  return formatAED(v);
}
