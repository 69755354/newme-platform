export function searchDigitCandidates(search: unknown): string[];
export function phoneMatches(phone: unknown, search: unknown): boolean;
export function leadMatchesSearch(
  lead: { customer_name?: string | null; phone?: string | null; location?: string | null; assigned_to?: string | null },
  search: string,
): boolean;
