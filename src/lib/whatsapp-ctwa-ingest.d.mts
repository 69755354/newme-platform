import type { WhatsAppAdEvent } from "./whatsapp-ctwa.mjs";
export interface WhatsAppAdIngestSummary {
  recorded: number; duplicate: number; leads_created: number; attributed: number; queued: number; failed: number; notify_failed?: number;
}
export function organicLeadsEnabled(env?: Record<string, string | undefined>): boolean;
export function internalNumberKeys(env?: Record<string, string | undefined>): Set<string>;
export function adLeadsEnabled(env?: Record<string, string | undefined>): boolean;
export function recordWhatsAppAdEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { from?: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: Record<string, unknown> | null; error: unknown }> },
  events: WhatsAppAdEvent[], options?: { createOrganic?: boolean; internalKeys?: Set<string> },
): Promise<WhatsAppAdIngestSummary>;
