export const MAX_WEBHOOK_BYTES: number;
export interface PilotChannel {
  id: string; label: string; purpose: "intake" | "follow_up";
  phone_number_id: string; waba_id: string; business_phone: string;
  enabled: boolean; accept_since: string;
}
export interface PilotEvent {
  channel_id: string; message_id: string; customer_key: string;
  direction: "inbound" | "outbound"; source: "messages" | "smb_message_echoes";
  message_type: string; occurred_at: string;
}
export interface PilotConversation {
  channel_id: string; customer_ref: string; inbound_count: number; outbound_count: number;
  pending_since: string | null; last_inbound_at: string | null; last_outbound_at: string | null;
  observed_response_seconds: number[];
}
export function verifyWhatsAppSignature(bytes: Uint8Array, signature: string | null, secret: string): boolean;
export function extractWhatsAppEvents(payload: unknown, channels: PilotChannel[], contactSalt: string, now?: number): PilotEvent[];
export function summarizeWhatsAppEvents(events: PilotEvent[]): PilotConversation[];
