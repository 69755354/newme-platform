import type { SupabaseClient } from "@supabase/supabase-js";
import { attemptCapiDelivery, QUOTE_DELIVERY, PURCHASE_DELIVERY, type CapiDeliveryKind } from "./meta-capi-delivery";
import { sendMetaCapiPayload } from "./meta-capi";
import {
  enqueueWebsiteQuoteForProgress as quoteCore, enqueueWebsiteValuedEvent,
  enqueueWebsitePurchaseForContract as contractCore, enqueueWebsitePurchaseForQuotation as quotationCore,
} from "./website-capi-valued.mjs";

// Binds the real Meta sender; the .mjs core stays free of TypeScript imports so node tests can load it.
const KINDS: Record<string, CapiDeliveryKind> = { quote: QUOTE_DELIVERY, purchase: PURCHASE_DELIVERY };
const attempt = (db: SupabaseClient, row: unknown, kind: string) =>
  attemptCapiDelivery(db, row as never, sendMetaCapiPayload, Date.now(), KINDS[kind]);
const opts = { attempt };

export const enqueueWebsiteQuoteForProgress = (db: SupabaseClient, leadId: string, key: string) => quoteCore(db, leadId, key, opts);
export const enqueueWebsiteQuoteForLead = (db: SupabaseClient, leadId: string) => enqueueWebsiteValuedEvent(db, leadId, "quote", opts);
export const enqueueWebsitePurchaseForLead = (db: SupabaseClient, leadId: string) => enqueueWebsiteValuedEvent(db, leadId, "purchase", opts);
export const enqueueWebsitePurchaseForContract = (db: SupabaseClient, id: string) => contractCore(db, id, opts);
export const enqueueWebsitePurchaseForQuotation = (db: SupabaseClient, id: string) => quotationCore(db, id, opts);
