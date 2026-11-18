export type WhatsAppCapiEventName = "LeadSubmitted" | "QualifiedLead" | "Purchase";
export const WA_CAPI_EVENTS: readonly WhatsAppCapiEventName[];
export const WA_STAGE_EVENTS: Readonly<Record<string, WhatsAppCapiEventName>>;
export const WA_CAPI_EVENT_MAX_AGE_SECONDS: number;
export interface WhatsAppCapiPayload { data: Array<Record<string, unknown>>; }
export function buildWhatsAppCapiPayload(input: {
  eventId?: string; wabaId: string; ctwaClid: string; eventName: string; eventTime: number;
  value?: number | null; currency?: string | null;
}): WhatsAppCapiPayload;
export function sendWhatsAppCapiPayload(payload: WhatsAppCapiPayload, options?: {
  env?: Record<string, string | undefined>; fetchImpl?: typeof fetch;
}): Promise<void>;
type Db = { from: (table: string) => unknown };
type Outcome = "queued" | "skipped";
export function enqueueWhatsAppCapiEvent(db: Db, leadId: string, eventName: string, options?: {
  value?: number | null; currency?: string | null; nowSeconds?: number;
}): Promise<Outcome>;
export function enqueueWhatsAppCapiForProgress(db: Db, leadId: string, progressKey: string): Promise<Outcome>;
export function enqueueWhatsAppCapiForQuality(db: Db, leadId: string, quality: string): Promise<Outcome>;
export function enqueueWhatsAppPurchaseForLead(db: Db, leadId: string): Promise<Outcome>;
export function enqueueWhatsAppPurchaseForContract(db: Db, contractId: string): Promise<Outcome>;
export function enqueueWhatsAppPurchaseForQuotation(db: Db, quotationId: string): Promise<Outcome>;
