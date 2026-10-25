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

/** A database compare-and-set coordinates independent requests/processes. */
export async function attemptCapiDelivery(
  db: SupabaseClient,
  delivery: CapiDelivery,
  send: (payload: MetaCapiPayload) => Promise<void>,
  now = Date.now(),
): Promise<"delivered" | "busy" | "failed" | "review_required"> {
  const prior = delivery.event_data;
  if (prior.status === "delivered") return "delivered";
  const queuedAt = Date.parse(prior.queued_at);
  // Bound ambiguous retries to 24h, inside Meta's deduplication window. Never
  // change event_id/event_time on a retry, or blindly resend an old conversion.
  if (!Number.isFinite(queuedAt) || queuedAt > now || now - queuedAt >= 86_400_000
    || !Number.isInteger(prior.attempts) || prior.attempts < 0 || prior.attempts >= 5
    || prior.payload?.data?.length !== 1 || prior.payload.data[0].event_id !== prior.event_id) {
    return "review_required";
  }
  if (prior.status === "sending" && Date.parse(prior.lease_until || "") > now) return "busy";
  if (!["pending", "failed", "sending"].includes(prior.status)
    || (prior.status === "sending" && (!prior.lease_id || !Number.isFinite(Date.parse(prior.lease_until || ""))))) {
    return "review_required";
  }
  const leaseId = randomUUID();
  const claimed = { ...prior, status: "sending", attempts: prior.attempts + 1,
    lease_id: leaseId, lease_until: new Date(now + 60_000).toISOString() };
  let claim = db.from("business_events").update({ event_data: claimed })
    .eq("id", delivery.id).eq("event_type", "meta_capi_lead_delivery")
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
