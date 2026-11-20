import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetaCapiPayload } from "./meta-capi";

export type CapiDelivery = {
  id: string;
  event_data: {
    status: string;
    attempts: number;
    queued_at: string;
    event_id: string;
    payload: MetaCapiPayload;
    lease_id?: string;
    lease_until?: string;
  };
};

export type CapiDeliveryKind = {
  eventType: string; eventName: string; actionSource: string; maxAgeMs: number; requireSiteUrl: boolean;
};
export const LEAD_DELIVERY: CapiDeliveryKind = {
  eventType: "meta_capi_lead_delivery", eventName: "Lead", actionSource: "website", maxAgeMs: 86_400_000, requireSiteUrl: true,
};
// Valued follow-up events (quote sent, deal signed) are queued days after the visit; Meta rejects events older than
// 7 days, so retry for up to 6 days and never change event_id/event_time.
export const QUOTE_DELIVERY: CapiDeliveryKind = {
  eventType: "meta_capi_lead_delivery", eventName: "InitiateCheckout", actionSource: "system_generated",
  maxAgeMs: 6 * 86_400_000, requireSiteUrl: false,
};
export const PURCHASE_DELIVERY: CapiDeliveryKind = {
  eventType: "meta_capi_lead_delivery", eventName: "Purchase", actionSource: "system_generated",
  maxAgeMs: 6 * 86_400_000, requireSiteUrl: false,
};
// Click-to-WhatsApp quote: business-messaging payload, sent to the WhatsApp dataset by the caller's sender.
export const WA_QUOTE_DELIVERY: CapiDeliveryKind = {
  eventType: "meta_capi_lead_delivery", eventName: "InitiateCheckout", actionSource: "business_messaging",
  maxAgeMs: 6 * 86_400_000, requireSiteUrl: false,
};
export const OUTBOX_KINDS = { LEAD_DELIVERY, QUOTE_DELIVERY, PURCHASE_DELIVERY, WA_QUOTE_DELIVERY } as const;

/** Which delivery kind an outbox row is, from its stored payload; null when unknown. */
export function kindOfOutboxRow(row: { event_data?: { payload?: { data?: Array<{ event_name?: string; action_source?: string }> } } }): CapiDeliveryKind | null {
  const e = row?.event_data?.payload?.data?.[0];
  return Object.values(OUTBOX_KINDS).find((k) => k.eventName === e?.event_name && k.actionSource === e?.action_source) ?? null;
}

/** A database compare-and-set coordinates independent requests/processes. */
export async function attemptCapiDelivery(
  db: SupabaseClient,
  delivery: CapiDelivery,
  send: (payload: MetaCapiPayload) => Promise<void>,
  now = Date.now(),
  kind: CapiDeliveryKind = LEAD_DELIVERY,
): Promise<"delivered" | "busy" | "failed" | "review_required"> {
  const prior = delivery.event_data;
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) return "review_required";
  if (prior.status === "delivered") return "delivered";
  const queuedAt = Date.parse(prior.queued_at);
  const event = prior.payload?.data?.[0];
  const eventTime = Number.isInteger(event?.event_time) ? event.event_time * 1000 : NaN;
  // Bound ambiguous retries (Lead 24h; Purchase 6 days, see PURCHASE_DELIVERY). Never
  // change event_id/event_time on a retry, or blindly resend an old conversion.
  if (!Number.isFinite(queuedAt) || queuedAt > now || now - queuedAt >= kind.maxAgeMs
    || !Number.isInteger(prior.attempts) || prior.attempts < 0 || prior.attempts >= 5
    || prior.payload?.data?.length !== 1 || event?.event_id !== prior.event_id
    || event.event_name !== kind.eventName || event.action_source !== kind.actionSource
    || !Number.isFinite(eventTime) || eventTime > now || now - eventTime >= kind.maxAgeMs) {
    return "review_required";
  }
  if (kind.requireSiteUrl) try {
    if (!["https://newme.ae", "https://www.newme.ae"].includes(new URL(event.event_source_url).origin)) {
      return "review_required";
    }
  } catch { return "review_required"; }
  if (prior.status === "sending" && Date.parse(prior.lease_until || "") > now) return "busy";
  if (!["pending", "failed", "sending"].includes(prior.status)
    || (prior.status === "sending" && (!prior.lease_id || !Number.isFinite(Date.parse(prior.lease_until || ""))))) {
    return "review_required";
  }
  const leaseId = randomUUID();
  const claimed = { ...prior, status: "sending", attempts: prior.attempts + 1,
    lease_id: leaseId, lease_until: new Date(now + 60_000).toISOString() };
  let claim = db.from("business_events").update({ event_data: claimed })
    .eq("id", delivery.id).eq("event_type", kind.eventType)
    .eq("event_data->>status", prior.status).eq("event_data->>attempts", String(prior.attempts));
  if (prior.status === "sending") claim = claim.eq("event_data->>lease_id", prior.lease_id!);
  const acquired = await claim.select("id").maybeSingle();
  if (acquired.error) throw new Error("CAPI delivery claim unavailable");
  if (!acquired.data) return "busy";
  let status: "delivered" | "failed" = "delivered";
  try { await send(prior.payload); } catch { status = "failed"; }
  const result = await db.from("business_events").update({ event_data: {
    ...prior, status, attempts: claimed.attempts,
    ...(status === "delivered" ? { delivered_at: new Date().toISOString() } : { failed_at: new Date().toISOString() }),
    // Keep ownership until the final write. A late previous sender cannot
    // overwrite a newer claim after lease recovery.
    lease_id: leaseId, lease_until: claimed.lease_until,
  } }).eq("id", delivery.id).eq("event_data->>lease_id", leaseId).eq("event_data->>status", "sending")
    .select("id").maybeSingle();
  if (result.error || !result.data) throw new Error("CAPI delivery receipt unavailable");
  return status;
}
