#!/usr/bin/env node
// Meta Lead Ads backfill + daily reconciliation. Default is read-only (dry run):
// it lists every Instant Form lead on the configured pages since --since and
// reports, per day, how many Meta has versus how many the CRM holds by leadgen id.
// --execute stores the missing ones (idempotent) and queues their "Lead" event.
// Only aggregate counts are printed: no names, contacts, answers or tokens.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  LEAD_FIELDS, graphGet, isCrmEventDeliverable, graphUrl, mapMetaLeadToRow, normalizeMetaId, resolvePageAccessToken, storeMetaLead,
} from "../src/lib/meta-lead-ads.mjs";
import { enqueueMetaCrmStageEvent } from "../src/lib/meta-crm-events.ts";
import { lookupTestForm } from "../src/lib/meta-lead-test-isolation.mjs";

const MAX_PAGES = 500; // safety stop only; reaching it with pages left is a failure, never a silent truncation

async function* paged(fetchImpl, firstUrl, token) {
  let url = firstUrl;
  for (let i = 0; url; i++) {
    if (i >= MAX_PAGES) throw new Error("pagination_limit_reached");
    const body = await graphGet(fetchImpl, url, token);
    for (const item of Array.isArray(body?.data) ? body.data : []) yield item;
    const next = body?.paging?.next;
    // Follow only Graph's own cursor URLs; the token stays in the header.
    url = typeof next === "string" && next.startsWith("https://graph.facebook.com/") ? new URL(next) : null;
    if (url) url.searchParams.delete("access_token");
  }
}

export async function listMetaLeads(fetchImpl, { version, token, pageIds, sinceSeconds }) {
  const leads = [];
  for (const rawPage of pageIds) {
    const pageId = normalizeMetaId(rawPage);
    if (!pageId) throw new Error("invalid_page_id");
    const pageToken = await resolvePageAccessToken(fetchImpl, { version, token, pageId });
    const formsUrl = graphUrl(version, `${pageId}/leadgen_forms`, { fields: "id,name,status", limit: 100 });
    for await (const form of paged(fetchImpl, formsUrl, pageToken)) {
      const formId = normalizeMetaId(form?.id);
      if (!formId) continue;
      const leadsUrl = graphUrl(version, `${formId}/leads`, {
        fields: LEAD_FIELDS, limit: 100,
        filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: sinceSeconds }]),
      });
      for await (const lead of paged(fetchImpl, leadsUrl, pageToken)) leads.push({ lead, formName: form?.name ?? null });
    }
  }
  return leads;
}

const day = (iso) => (iso ?? "").slice(0, 10) || "unknown";
// Submission hour in Dubai time, used to choose pull times around real demand.
const dubaiHour = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? String(new Date(t + 4 * 3_600_000).getUTCHours()).padStart(2, "0") : "unknown";
};

export async function pullMetaLeads(db, fetchImpl, { version, token, pageIds, sinceSeconds, execute = false, nowMs = Date.now() }) {
  const metaLeads = await listMetaLeads(fetchImpl, { version, token, pageIds, sinceSeconds });
  const ids = metaLeads.map(({ lead }) => normalizeMetaId(lead?.id)).filter(Boolean);
  const stored = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await db.from("leads").select("id, meta_leadgen_id").in("meta_leadgen_id", chunk);
    if (error) throw new Error("crm_lookup_failed");
    for (const row of data ?? []) stored.set(row.meta_leadgen_id, row.id);
  }
  // Leads older than the sender's age limit are stored but their Lead event is
  // not queued (it could never be sent); they are counted as event_too_old.
  const queueLead = async (id, row) => {
    const eventTime = Math.floor(Date.parse(row.created_at) / 1000);
    if (!isCrmEventDeliverable(eventTime, nowMs)) { summary.event_too_old++; return; }
    const queued = await enqueueMetaCrmStageEvent(db, { id, meta_leadgen_id: row.meta_leadgen_id }, "new", eventTime);
    if (queued !== "queued") throw new Error("lead_event_not_queued");
  };
  const byDay = {};
  const summary = { mode: execute ? "execute" : "dry_run", meta_leads: metaLeads.length,
    already_in_crm: 0, missing: 0, inserted: 0, merged: 0, duplicate: 0, isolated: 0, failed: 0, event_too_old: 0, by_day: byDay, by_hour_dubai: {} };
  for (const { lead, formName } of metaLeads) {
    let row;
    try { row = mapMetaLeadToRow(lead, { formName }); } catch { summary.failed++; continue; }
    try {
      if (await lookupTestForm(db, row.form_id)) {
        if (execute) {
          const result = await storeMetaLead(db, row, "backfill");
          if (result.outcome !== "isolated") throw Error("test_isolation_changed");
        }
        summary.isolated++;
        continue;
      }
    } catch { summary.failed++; continue; }
    const bucket = (byDay[day(row.created_at)] ??= { meta: 0, crm_before: 0 });
    bucket.meta++;
    const hour = dubaiHour(row.created_at);
    summary.by_hour_dubai[hour] = (summary.by_hour_dubai[hour] ?? 0) + 1;
    if (stored.has(row.meta_leadgen_id)) {
      summary.already_in_crm++; bucket.crm_before++;
      // Idempotent repair: re-ensure the Lead event for leads already stored.
      if (execute) { try { await queueLead(stored.get(row.meta_leadgen_id), row); } catch { summary.failed++; } }
      continue;
    }
    summary.missing++;
    if (!execute) continue;
    try {
      const result = await storeMetaLead(db, row);
      if (result.outcome === "isolated") { summary.isolated++; continue; }
      if (!result.id) throw new Error("lead_id_unavailable");
      await queueLead(result.id, row);
      summary[result.outcome]++;
    } catch { summary.failed++; }
  }
  return summary;
}

// The public Supabase URL lives in the release's .env.local, not in
// /etc/newme/newme-runtime.env; read it from there when the env lacks it.
function releaseSupabaseUrl() {
  try {
    const text = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const value = text.match(/^NEXT_PUBLIC_SUPABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
    return value || undefined;
  } catch { return undefined; }
}

function parseArgs(argv) {
  const args = { execute: argv.includes("--execute"), sinceDays: 45 };
  const i = argv.indexOf("--since-days");
  if (i >= 0) args.sinceDays = Number(argv[i + 1]);
  if (!Number.isInteger(args.sinceDays) || args.sinceDays < 1 || args.sinceDays > 90) throw new Error("--since-days must be 1..90");
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { execute, sinceDays } = parseArgs(process.argv.slice(2));
  const env = process.env;
  const pageIds = (env.META_LEADGEN_PAGE_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const url = env.NEXT_PUBLIC_SUPABASE_URL || releaseSupabaseUrl();
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !env.META_LEADS_ACCESS_TOKEN || !pageIds.length) {
    console.error("missing configuration: Supabase server credentials, META_LEADS_ACCESS_TOKEN or META_LEADGEN_PAGE_IDS");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const summary = await pullMetaLeads(db, fetch, {
      version: env.META_GRAPH_API_VERSION || "v22.0", token: env.META_LEADS_ACCESS_TOKEN, pageIds,
      sinceSeconds: Math.floor(Date.now() / 1000) - sinceDays * 86_400, execute,
    });
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.failed ? 1 : 0);
  } catch (error) {
    console.error(`meta-leads-pull failed: ${error?.message ?? "unknown"}`);
    process.exit(1);
  }
}
