import type { SupabaseClient } from "@supabase/supabase-js";
import { attemptCapiDelivery, QUOTE_DELIVERY, PURCHASE_DELIVERY, WA_QUOTE_DELIVERY, type CapiDeliveryKind } from "./meta-capi-delivery";
import { sendMetaCapiPayload } from "./meta-capi";
import { enqueueWhatsAppCapiForProgress, sendWhatsAppCapiPayload } from "./whatsapp-capi.mjs";
import {
  enqueueWebsiteQuoteForProgress as quoteCore, enqueueWebsiteValuedEvent,
  enqueueWebsitePurchaseForContract as contractCore, enqueueWebsitePurchaseForQuotation as quotationCore,
} from "./website-capi-valued.mjs";

// Binds the real Meta senders; the .mjs cores stay free of TypeScript imports so node tests can load them.
const KINDS: Record<string, CapiDeliveryKind> = { quote: QUOTE_DELIVERY, purchase: PURCHASE_DELIVERY };
const attempt = (db: SupabaseClient, row: unknown, kind: string) =>
  attemptCapiDelivery(db, row as never, sendMetaCapiPayload, Date.now(), KINDS[kind]);
const opts = { attempt };
const waAttempt = (dbArg: unknown, row: unknown) =>
  attemptCapiDelivery(dbArg as SupabaseClient, row as never, sendWhatsAppCapiPayload as never, Date.now(), WA_QUOTE_DELIVERY);

export const enqueueWebsiteQuoteForProgress = (db: SupabaseClient, leadId: string, key: string) => quoteCore(db, leadId, key, opts);
export const enqueueWebsitePurchaseForLead = (db: SupabaseClient, leadId: string) => enqueueWebsiteValuedEvent(db, leadId, "purchase", opts);
export const enqueueWebsitePurchaseForContract = (db: SupabaseClient, id: string) => contractCore(db, id, opts);
export const enqueueWebsitePurchaseForQuotation = (db: SupabaseClient, id: string) => quotationCore(db, id, opts);
/** WhatsApp progress (QualifiedLead queue + the valued quote event, delivered now with the WhatsApp sender). */
export const enqueueWhatsAppProgressWithDelivery = (db: SupabaseClient, leadId: string, key: string) =>
  enqueueWhatsAppCapiForProgress(db, leadId, key, { attempt: waAttempt });
