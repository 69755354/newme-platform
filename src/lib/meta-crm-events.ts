import type { SupabaseClient } from "@supabase/supabase-js";

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
    action_source: "system_generated";
    user_data: { lead_id: string };
    custom_data: { lead_event_source: "crm"; event_source: "crm" };
  }>;
};

export function buildMetaCrmPayload(input: {
  leadgenId: string; eventName: string; eventTime: number;
}): MetaCrmPayload {
  const leadId = normalizeLeadgenId(input.leadgenId);
  if (!leadId) throw new Error("Invalid Meta leadgen id");
  return {
    data: [{
      event_name: input.eventName,
      event_time: input.eventTime,
      action_source: "system_generated",
      // Retain exact digits until the numeric JSON wire serializer.
      user_data: { lead_id: leadId },
      custom_data: { lead_event_source: "crm", event_source: "crm" },
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
