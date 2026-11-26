export const PUBLIC_LEAD_DEDUPE_SWITCH: string;
export function publicLeadDedupeEnabled(env?: Record<string, string | undefined>): boolean;
export interface OpenLeadCandidate { id: string; phone?: string | null; email?: string | null; archived?: boolean | null; final_status?: string | null; assigned_to?: string | null; [key: string]: unknown }
export function pickOpenLeadMatch<T extends OpenLeadCandidate>(candidates: T[], contact: { phone?: string | null; email?: string | null }): T | null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findOpenLeadByContact<T extends OpenLeadCandidate = OpenLeadCandidate>(db: any, contact: { phone?: string | null; email?: string | null }, columns?: string): Promise<{ lead: T | null; error: string | null }>;
