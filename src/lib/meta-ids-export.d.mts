export const META_IDS_ROLES: readonly string[];
export const META_IDS_MIN_TOKEN_LENGTH: number;
export const META_IDS_HEADER: readonly string[];
export type MetaIdRow = Record<(typeof META_IDS_HEADER)[number], string>;
export type MetaIdLead = {
  id: string; meta_leadgen_id: string | null; ctwa_clid: string | null; campaign_id: string | null; campaign_name: string | null;
  adset_id: string | null; ad_id: string | null; ad_name: string | null; created_at: string | null; stage: string | null;
  final_status: string | null; archived: boolean | null;
};
export type MetaIdEvent = { lead_id: string; event_name: string; status: string; created_at: string | null; delivered_at: string | null };
export function canExportMetaIds(role: unknown): boolean;
export function tokenMatches(provided: unknown, expected: unknown): boolean;
export function extractExportToken(headers: Headers, searchParams: URLSearchParams): { query: string | null; bearer: string | null };
export function leadRef(id: string): string;
export function toDubaiIso(value: string | null | undefined): string;
export function buildMetaIdRows(leads: MetaIdLead[], formEvents: MetaIdEvent[], whatsappEvents: MetaIdEvent[]): MetaIdRow[];
export function buildMetaIdsCsv(rows: MetaIdRow[]): string;
