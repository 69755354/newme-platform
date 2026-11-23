export type WhatsAppCapiEventName = "LeadSubmitted" | "QualifiedLead" | "Purchase";
export const WA_CAPI_EVENTS: readonly WhatsAppCapiEventName[];
export const WA_STAGE_EVENTS: Readonly<Record<string, WhatsAppCapiEventName>>;
export const WA_CAPI_EVENT_MAX_AGE_SECONDS: number;
export interface WhatsAppCapiPayload { data: Array<Record<string, unknown>>; }
export function buildWhatsAppCapiPayload(input: {
  eventId?: string; wabaId: string; ctwaClid: string; eventName: string; eventTime: number;
  value?: number | null; currency?: string | null; hashedPhone?: string[] | null;
}): WhatsAppCapiPayload;
export const WA_VALUED_EVENTS: readonly string[];
export function sendWhatsAppCapiPayload(payload: WhatsAppCapiPayload, options?: {
  env?: Record<string, string | undefined>; fetchImpl?: typeof fetch;
}): Promise<void>;
type Db = { from: (table: string) => unknown };
type Outcome = "queued" | "skipped";
export function enqueueWhatsAppCapiEvent(db: Db, leadId: string, eventName: string, options?: {
  value?: number | null; currency?: string | null; nowSeconds?: number;
}): Promise<Outcome>;
export type WhatsAppQuoteOptions = {
  attempt?: ((db: Db, row: { id: string; event_data: unknown }) => Promise<unknown>) | null;
  env?: Record<string, string | undefined>; nowSeconds?: number;
  /** Sheet-reported quote (AED); replaces the OS quotation lookup. */
  amount?: { value: number; currency: string } | null;
};
export function enqueueWhatsAppCapiForProgress(db: Db, leadId: string, progressKey: string, options?: WhatsAppQuoteOptions): Promise<Outcome>;
export function enqueueWhatsAppQuoteForLead(db: Db, leadId: string, options?: WhatsAppQuoteOptions): Promise<Outcome>;
export function enqueueWhatsAppCapiForQuality(db: Db, leadId: string, quality: string): Promise<Outcome>;
export function enqueueWhatsAppPurchaseForLead(db: Db, leadId: string): Promise<Outcome>;
export function enqueueWhatsAppPurchaseForContract(db: Db, contractId: string): Promise<Outcome>;
export function enqueueWhatsAppPurchaseForQuotation(db: Db, quotationId: string): Promise<Outcome>;
