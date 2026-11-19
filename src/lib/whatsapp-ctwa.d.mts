import type { PilotChannel } from "./whatsapp-pilot.mjs";
export interface CtwaReferral {
  source_type: string | null; source_id: string | null; source_url: string | null;
  headline: string | null; ctwa_clid: string | null;
}
export interface WhatsAppAdEvent {
  waba_id: string; phone_number_id: string; channel_id: string; customer_phone: string;
  direction: "inbound" | "outbound"; source: "messages" | "smb_message_echoes";
  message_id: string; message_type: string; body: string | null; body_kind: "text" | "media" | "other"; occurred_at: string;
  profile_name: string | null; referral: CtwaReferral | null;
}
export function normalizeCtwaClid(raw: unknown): string | null;
export function normalizeWhatsAppPhoneKey(raw: unknown): string | null;
export function extractWhatsAppAdEvents(payload: unknown, channels: PilotChannel[], now?: number): WhatsAppAdEvent[];
export const MAX_MESSAGE_BODY: number;
export function messageBody(message: unknown): string | null;
export function messageBodyKind(type: string): "text" | "media" | "other";
