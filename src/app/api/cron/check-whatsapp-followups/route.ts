// RBAC: cron (x-cron-secret). PREPARED, NOT ENABLED: answers "Disabled" unless
// WHATSAPP_FOLLOWUP_MONITOR_ENABLED=true is set in the runtime environment (S21).
//
// Sales follow-up monitor v1. For every open lead that has a WhatsApp conversation it computes the first
// response time, the contacts in the first 5 working days and the follow-up state (normal, at_risk, overdue)
// from the stored message events (times and directions only, never the text), then hands the result to
// upsert_lead_followup_state(). That function is the idempotency boundary: it writes the system note and the
// notifications in one transaction and only when the state (or the abandon-risk flag) really changed, so
// running this route any number of times in a row changes nothing the second time.
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import { buildFollowupNote, evaluateFollowup, resolveFollowupConfig, type FollowupState } from "@/lib/followup-monitor.mjs";

export const dynamic = "force-dynamic";

const PAGE = 1000;
const MAX_PAGES = 10;
const CHUNK = 100;
const MAX_LEADS = 2000;
const MAX_CHANGES = 200;
const MAX_EVENTS_PER_LEAD = 5000;
const SILENCE_STAGES = new Set(["new", "contacted"]);
// Test and release-acceptance accounts are not people: they never receive these notifications.
const SYSTEM_ACCOUNT = /(@qa\.newme\.ae$|^release-uat-)/i;

function secretMatches(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readConfig() {
  try { return resolveFollowupConfig(process.env.FOLLOWUP_MONITOR_CONFIG ? JSON.parse(process.env.FOLLOWUP_MONITOR_CONFIG) : {}); }
  catch { return resolveFollowupConfig({}); }
}

type LeadRow = { id: string; assigned_to: string | null; customer_name: string | null; stage: string | null; archived: boolean | null; final_status: string | null };
type StateRow = { lead_id: string; state: FollowupState; abandon_risk: boolean };

async function handle(request: Request) {
  if (!secretMatches(request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.WHATSAPP_FOLLOWUP_MONITOR_ENABLED !== "true") {
    return NextResponse.json({ message: "Disabled", reason: "WhatsApp follow-up monitor not enabled" }, { status: 200 });
  }
  try {
    const config = readConfig();
    const now = Date.now();

    // Conversations that belong to a lead, grouped by lead.
    const conversationsByLead = new Map<string, string[]>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { data, error } = await supabaseAdmin.from("whatsapp_conversations").select("id, lead_id")
        .not("lead_id", "is", null).order("id").range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw new Error("conversation_query_failed");
      for (const row of (data ?? []) as Array<{ id: string; lead_id: string }>) {
        const list = conversationsByLead.get(row.lead_id) ?? [];
        list.push(row.id);
        conversationsByLead.set(row.lead_id, list);
      }
      if ((data ?? []).length < PAGE) break;
    }
    const leadIds = [...conversationsByLead.keys()].slice(0, MAX_LEADS);

    const { data: operatorRows, error: operatorError } = await supabaseAdmin.from("profiles").select("id, email")
      .eq("role", "operator").eq("is_active", true);
    if (operatorError) throw new Error("operator_query_failed");
    const operators = ((operatorRows ?? []) as Array<{ id: string; email: string | null }>)
      .filter((p) => !SYSTEM_ACCOUNT.test(p.email ?? "")).map((p) => p.id);

    const summary = { scanned: 0, changed: 0, notes: 0, notifications: 0, failed: 0, skipped_closed: 0, capped: leadIds.length < conversationsByLead.size };
    for (let i = 0; i < leadIds.length; i += CHUNK) {
      if (summary.changed >= MAX_CHANGES) { summary.capped = true; break; }
      const ids = leadIds.slice(i, i + CHUNK);
      const [{ data: leads, error: leadError }, { data: states, error: stateError }] = await Promise.all([
        supabaseAdmin.from("leads").select("id, assigned_to, customer_name, stage, archived, final_status").in("id", ids),
        supabaseAdmin.from("lead_followup_state").select("lead_id, state, abandon_risk").in("lead_id", ids),
      ]);
      if (leadError || stateError) throw new Error("lead_query_failed");
      const stateByLead = new Map(((states ?? []) as StateRow[]).map((row) => [row.lead_id, row]));
      for (const lead of (leads ?? []) as LeadRow[]) {
        if (lead.archived || lead.final_status) { summary.skipped_closed += 1; continue; }
        const conversationIds = conversationsByLead.get(lead.id) ?? [];
        const { data: events, error: eventError } = await supabaseAdmin.from("whatsapp_message_events")
          .select("direction, occurred_at").in("conversation_id", conversationIds).order("occurred_at").limit(MAX_EVENTS_PER_LEAD);
        if (eventError) { summary.failed += 1; continue; }
        summary.scanned += 1;
        const result = evaluateFollowup({
          events: ((events ?? []) as Array<{ direction: "inbound" | "outbound"; occurred_at: string }>).map((e) => ({ direction: e.direction, occurredAt: e.occurred_at })),
          now, config, silenceRules: SILENCE_STAGES.has(lead.stage ?? ""),
        });
        const previous = stateByLead.get(lead.id);
        const message = buildFollowupNote({
          result, previous: previous ? { state: previous.state, abandonRisk: previous.abandon_risk } : { state: "normal", abandonRisk: false },
          now, config, leadName: lead.customer_name ?? "",
        });
        const recipients = [...new Set([lead.assigned_to, ...operators].filter((id): id is string => Boolean(id)))];
        const { data, error } = await supabaseAdmin.rpc("upsert_lead_followup_state", {
          p_lead_id: lead.id,
          p_first_inbound_at: result.firstInboundAt,
          p_first_reply_at: result.firstReplyAt,
          p_first_response_minutes: result.firstResponseMinutes,
          p_contact_count_5wd: result.contactCount5wd,
          p_last_outbound_at: result.lastOutboundAt,
          p_state: result.state,
          p_abandon_risk: result.abandonRisk,
          p_note: message?.note ?? null,
          p_notify_user_ids: message ? recipients : [],
          p_notify_title: message?.title ?? null,
          p_notify_body: message?.body ?? null,
        });
        if (error) { summary.failed += 1; continue; }
        const outcome = (data ?? {}) as { changed?: boolean; note_written?: boolean; notified?: number };
        if (outcome.changed) summary.changed += 1;
        if (outcome.note_written) summary.notes += 1;
        summary.notifications += Number(outcome.notified ?? 0);
      }
    }
    // A run where nothing could be written is a failure the timer must report; partial failures are counted.
    if (summary.failed > 0 && summary.scanned - summary.failed <= 0) return NextResponse.json({ error: "Follow-up monitor failed", ...summary }, { status: 500 });
    return NextResponse.json(summary);
  } catch (error) {
    logger.error({ operation: "whatsapp_followup_monitor", code: error instanceof Error ? error.message : "unknown" }, "whatsapp follow-up monitor failed");
    return NextResponse.json({ error: "Follow-up monitor failed" }, { status: 500 });
  }
}

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
