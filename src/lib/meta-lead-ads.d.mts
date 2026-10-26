import type { SupabaseClient } from "@supabase/supabase-js";

export const MAX_LEADGEN_WEBHOOK_BYTES: number;
export const LEAD_FIELDS: string;
export interface LeadgenNotification {
  leadgen_id: string; page_id: string; form_id: string | null; ad_id: string | null; created_time: number | null;
}
export interface MetaLeadRow {
  meta_leadgen_id: string; source: "ins" | "fb"; source_platform: string; source_channel: string;
  customer_name: string | null; phone: string | null; email: string | null; location: string | null;
  form_id: string | null; form_name: string | null; ad_id: string | null; meta_ad_id: string | null;
  ad_name: string | null; adset_id: string | null; adset_name: string | null; campaign_id: string | null;
  campaign_name: string | null; meta_campaign: string | null; raw_import_data: Record<string, unknown>;
  lead_status: string; next_action: string; next_followup_date: string; first_touch_at: string; created_at: string;
}
export type StoreOutcome = "inserted" | "merged" | "duplicate";
export function normalizeMetaId(raw: unknown, pattern?: RegExp): string | null;
export function verifyMetaSignature(bytes: Uint8Array, signature: string | null, secret: string | undefined): boolean;
export function extractLeadgenNotifications(payload: unknown, allowedPageIds: Iterable<string>): LeadgenNotification[];
export function mapMetaLeadToRow(lead: unknown, options?: { formName?: string | null; now?: Date }): MetaLeadRow;
export function storeMetaLead(db: SupabaseClient, row: MetaLeadRow): Promise<{ outcome: StoreOutcome; id: string | null }>;
export function graphUrl(version: string, path: string, params?: Record<string, unknown>): URL;
export function graphGet(fetchImpl: typeof fetch, url: URL, token: string): Promise<unknown>;
export function fetchMetaLead(fetchImpl: typeof fetch, options: { version: string; token: string; leadgenId: string }): Promise<unknown>;
