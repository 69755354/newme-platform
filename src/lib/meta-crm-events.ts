import type { SupabaseClient } from "@supabase/supabase-js";
import { hashedContactKeys } from "./capi-hash.mjs";
import { funnelStagesBetween } from "./milestone-stage-advance.mjs";
export { hashedContactKeys };

/**
 * Meta Conversion Leads (CRM) events for native Instant Form leads.
 * Differs from the website CAPI path: it requires the form's leadgen_id,
 * action_source "system_generated" and lead_event_source "crm".
 */

// CRM progress key -> event name reported to Meta. Two UI paths move a lead:
// the pipeline stage endpoint (stage keys) and the lead-detail milestone flow
// (milestone keys). Both map onto one funnel; "Qualified" is the target.
export const META_CRM_STAGE_EVENTS: Readonly<Record<string, string>> = {
  // pipeline stages
  new: "Lead",
  contacted: "Contacted",
  requirement_confirmed: "Qualified",
  solution_submitted: "Solution Submitted",
  quotation_submitted: "Quoted",
  negotiation: "Negotiation",
  pending_decision: "Pending Decision",
  won: "Won",
  lost: "Lost",
  // lead-detail milestones
  first_contact: "Contacted",
  basic_info: "Basic Info Collected",
  drawings: "Drawings Received",
  requirements: "Qualified",
  solution: "Solution Submitted",
  quotation: "Quoted",
  meeting: "Meeting",
};

const LEADGEN_ID = /^[1-9]\d{7,31}$/;

/** Accepts "123", 123 or the Meta export form "l:123"; returns null if not a valid id. */
export function normalizeLeadgenId(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "number" && !Number.isSafeInteger(raw)) return null;
  const value = String(raw).trim().replace(/^l:/i, "");
  return LEADGEN_ID.test(value) ? value : null;
}

export type MetaCrmPayload = {
  data: Array<{
    event_name: string;
    event_time: number;
    /** Queue row id: lets Meta deduplicate a retry of the same stage event. */
    event_id?: string;
    action_source: "system_generated";
    user_data: { lead_id: string; ph?: string[]; em?: string[] };
    custom_data: { lead_event_source: "crm"; event_source: "crm"; value?: number; currency?: string };
  }>;
};

export function buildMetaCrmPayload(input: {
  leadgenId: string; eventName: string; eventTime: number; eventId?: string;
  /** Quoted (the quote amount) and Won (the contract amount) only. */
  value?: number | null; currency?: string | null;
  /** Optional extra matching keys, already hashed (see hashedContactKeys). */
  match?: { ph?: string[]; em?: string[] };
}): MetaCrmPayload {
  const leadId = normalizeLeadgenId(input.leadgenId);
  if (!leadId) throw new Error("Invalid Meta leadgen id");
  const hasValue = typeof input.value === "number" && Number.isFinite(input.value) && input.value > 0
    && typeof input.currency === "string" && /^[A-Z]{3}$/.test(input.currency);
  return {
    data: [{
      event_name: input.eventName,
      event_time: input.eventTime,
      ...(input.eventId ? { event_id: String(input.eventId) } : {}),
      action_source: "system_generated",
      // Retain exact digits until the numeric JSON wire serializer.
      user_data: { lead_id: leadId, ...(input.match?.ph ? { ph: input.match.ph } : {}), ...(input.match?.em ? { em: input.match.em } : {}) },
      custom_data: { lead_event_source: "crm", event_source: "crm",
        ...((input.eventName === "Won" || input.eventName === "Quoted") && hasValue ? { value: input.value as number, currency: input.currency as string } : {}) },
    }],
  };
}

/** Emit Meta's numeric lead_id without passing its digits through Number. */
export function serializeMetaCrmPayload(payload: MetaCrmPayload): string {
  const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
  if (!rawJSON) throw new Error("Exact Meta CRM ID serialization is unavailable");
  return JSON.stringify({
    ...payload,
    data: payload.data.map((event) => {
      const id = event.user_data.lead_id;
      if (typeof id !== "string" || normalizeLeadgenId(id) !== id) {
        throw new Error("Invalid Meta CRM payload lead id");
      }
      return { ...event, user_data: { ...event.user_data, lead_id: rawJSON(id) } };
    }),
  });
}

/**
 * Queue one event for a stage or milestone. Idempotent per (lead, event) and never
 * throws: a tracking problem must not block a salesperson's stage change.
 * event_time is the transition moment, so it is after the lead's creation.
 */
export async function enqueueMetaCrmStageEvent(
  db: SupabaseClient,
  lead: { id: string; meta_leadgen_id?: string | null },
  stage: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<"queued" | "skipped"> {
  try {
    const eventName = META_CRM_STAGE_EVENTS[stage];
    const leadgenId = normalizeLeadgenId(lead.meta_leadgen_id);
    if (!eventName || !leadgenId) return "skipped";
    // crm_stage stores the funnel event, so the stage and milestone paths
    // reporting the same step (e.g. contacted / first_contact) send it once.
    const { error } = await db.from("meta_crm_stage_events").upsert({
      lead_id: lead.id, meta_leadgen_id: leadgenId, crm_stage: eventName,
      event_name: eventName, event_time: nowSeconds,
    }, { onConflict: "lead_id,crm_stage", ignoreDuplicates: true });
    return error ? "skipped" : "queued";
  } catch {
    return "skipped";
  }
}

/**
 * S39: a stage may be skipped forward, so queue every funnel event from the step after the old stage up to and
 * including the new one, in order. Idempotent per (lead, event); a step already reported is not sent twice.
 */
export async function enqueueMetaCrmFunnelBetween(
  db: SupabaseClient, lead: { id: string; meta_leadgen_id?: string | null },
  fromStage: string | null | undefined, toStage: string | null | undefined,
): Promise<number> {
  let queued = 0;
  try {
    const base = Math.floor(Date.now() / 1000);
    const stages = funnelStagesBetween(fromStage, toStage);
    // Earlier steps get earlier times so Meta sees them in funnel order.
    for (let i = 0; i < stages.length; i += 1) {
      const at = base - (stages.length - 1 - i);
      if (await enqueueMetaCrmStageEvent(db, lead, stages[i], at) === "queued") queued += 1;
    }
  } catch { /* tracking must never fail a stage change */ }
  return queued;
}

/** Same, reading the lead's Meta id with the server client. Never throws. */
export async function enqueueMetaCrmFunnelForLead(
  db: SupabaseClient, leadId: string, fromStage: string | null | undefined, toStage: string | null | undefined,
): Promise<number> {
  try {
    const { data, error } = await db.from("leads").select("meta_leadgen_id").eq("id", leadId).maybeSingle();
    if (error || !data?.meta_leadgen_id) return 0;
    return await enqueueMetaCrmFunnelBetween(db, { id: leadId, meta_leadgen_id: data.meta_leadgen_id }, fromStage, toStage);
  } catch {
    return 0;
  }
}

/** Sends one batch to Meta using the server-side token. The token is never logged. */
export async function sendMetaCrmPayload(payload: MetaCrmPayload): Promise<void> {
  const datasetId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!datasetId || !accessToken) throw new Error("Meta CRM configuration is unavailable");
  const graphVersion = process.env.META_GRAPH_API_VERSION || "v25.0";
  const endpoint = new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(datasetId)}/events`);
  let result: Response;
  try {
    result = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: serializeMetaCrmPayload(payload),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("Meta CRM transport failed");
  }
  if (!result.ok) throw new Error(`Meta CRM returned ${result.status}`);
  let receipt: unknown;
  try { receipt = await result.json(); } catch { throw new Error("Meta CRM returned an invalid receipt"); }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || "error" in receipt || !("events_received" in receipt)
    || (receipt as { events_received: unknown }).events_received !== payload.data.length) {
    throw new Error("Meta CRM did not acknowledge every event");
  }
}

/**
 * Route helper: read the lead's Meta id with the server client and queue the
 * event. Tolerates the optional schema being absent; never throws.
 */
export async function enqueueMetaCrmEventForLead(
  db: SupabaseClient, leadId: string, progressKey: string,
): Promise<"queued" | "skipped"> {
  try {
    if (!META_CRM_STAGE_EVENTS[progressKey]) return "skipped";
    const { data, error } = await db.from("leads").select("meta_leadgen_id").eq("id", leadId).maybeSingle();
    if (error || !data?.meta_leadgen_id) return "skipped";
    return await enqueueMetaCrmStageEvent(db, { id: leadId, meta_leadgen_id: data.meta_leadgen_id }, progressKey);
  } catch {
    return "skipped";
  }
}

/**
 * A contract becoming active wins its lead inside the database routine (S2: the
 * lead is won on activation, no longer on conversion). Queue "Won" only once the
 * lead is committed as won.
 */
export async function enqueueMetaCrmWonForContract(
  db: SupabaseClient, contractId: string,
): Promise<"queued" | "skipped"> {
  try {
    const { data: contract, error } = await db.from("contracts").select("lead_id").eq("id", contractId).maybeSingle();
    if (error || !contract?.lead_id) return "skipped";
    const { data: lead, error: leadError } = await db.from("leads")
      .select("final_status, meta_leadgen_id").eq("id", contract.lead_id).maybeSingle();
    if (leadError || lead?.final_status !== "won" || !lead.meta_leadgen_id) return "skipped";
    return await enqueueMetaCrmStageEvent(db, { id: contract.lead_id, meta_leadgen_id: lead.meta_leadgen_id }, "won");
  } catch {
    return "skipped";
  }
}

/**
 * A quotation converted to a contract wins its lead inside the database routine,
 * outside the lead endpoints. Queue "Won" only once the lead is committed as won.
 */
export async function enqueueMetaCrmWonForQuotation(
  db: SupabaseClient, quotationId: string,
): Promise<"queued" | "skipped"> {
  try {
    const { data: quote, error } = await db.from("quotations").select("lead_id").eq("id", quotationId).maybeSingle();
    if (error || !quote?.lead_id) return "skipped";
    const { data: lead, error: leadError } = await db.from("leads")
      .select("final_status, meta_leadgen_id").eq("id", quote.lead_id).maybeSingle();
    if (leadError || lead?.final_status !== "won" || !lead.meta_leadgen_id) return "skipped";
    return await enqueueMetaCrmStageEvent(db, { id: quote.lead_id, meta_leadgen_id: lead.meta_leadgen_id }, "won");
  } catch {
    return "skipped";
  }
}
