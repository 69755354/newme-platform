import type { WhatsAppAdEvent } from "./whatsapp-ctwa.mjs";
export interface WhatsAppAdIngestSummary {
  recorded: number; duplicate: number; leads_created: number; attributed: number; queued: number; failed: number;
}
export function organicLeadsEnabled(env?: Record<string, string | undefined>): boolean;
export function adLeadsEnabled(env?: Record<string, string | undefined>): boolean;
export function recordWhatsAppAdEvents(
  db: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: Record<string, unknown> | null; error: unknown }> },
  events: WhatsAppAdEvent[], options?: { createOrganic?: boolean },
): Promise<WhatsAppAdIngestSummary>;
