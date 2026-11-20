import type { PilotChannel } from "./whatsapp-pilot.mjs";
export interface HistoryMessage {
  waba_id: string; phone_number_id: string; customer_phone: string; direction: "inbound" | "outbound";
  message_id: string; message_type: string; body: string | null; body_kind: "text" | "media" | "other"; occurred_at: string;
}
export interface HistoryContact {
  waba_id: string; phone_number_id: string; phone: string; full_name: string | null; first_name: string | null; action: "add" | "remove";
}
export interface HistoryExtract {
  messages: HistoryMessage[]; contacts: HistoryContact[];
  chunks: Array<{ phase: number | null; chunk_order: number | null; progress: number | null }>; declined: number;
}
export interface HistorySummary {
  messages: number; inserted: number; duplicate: number; rejected: number;
  contacts: number; contacts_upserted: number; contacts_removed: number; failed: number;
}
export const MAX_HISTORY_WEBHOOK_BYTES: number;
export const MAX_HISTORY_AGE_DAYS: number;
export const HISTORY_BATCH: number;
export function historySyncEnabled(env?: Record<string, string | undefined>): boolean;
export function hasHistorySyncFields(payload: unknown): boolean;
export function extractWhatsAppHistory(payload: unknown, channels: PilotChannel[], now?: number): HistoryExtract;
export function recordWhatsAppHistory(db: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> },
  parsed: Pick<HistoryExtract, "messages" | "contacts">): Promise<HistorySummary>;
