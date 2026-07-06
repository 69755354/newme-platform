export function fmtAED(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return "AED 0";
  return v >= 1_000_000
    ? `AED ${(v / 1_000_000).toFixed(1)}M`
    : `AED ${v.toLocaleString()}`;
}
