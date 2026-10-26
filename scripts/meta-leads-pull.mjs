#!/usr/bin/env node
// Meta Lead Ads backfill + daily reconciliation. Default is read-only (dry run):
// it lists every Instant Form lead on the configured pages since --since and
// reports, per day, how many Meta has versus how many the CRM holds by leadgen id.
// --execute stores the missing ones (idempotent) and queues their "Lead" event.
// Only aggregate counts are printed: no names, contacts, answers or tokens.
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { LEAD_FIELDS, graphGet, graphUrl, mapMetaLeadToRow, normalizeMetaId, storeMetaLead } from "../src/lib/meta-lead-ads.mjs";
import { enqueueMetaCrmStageEvent } from "../src/lib/meta-crm-events.ts";

const MAX_PAGES = 50;

async function* paged(fetchImpl, firstUrl, token) {
  let url = firstUrl;
  for (let i = 0; url && i < MAX_PAGES; i++) {
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
    const formsUrl = graphUrl(version, `${pageId}/leadgen_forms`, { fields: "id,name,status", limit: 100 });
    for await (const form of paged(fetchImpl, formsUrl, token)) {
      const formId = normalizeMetaId(form?.id);
      if (!formId) continue;
      const leadsUrl = graphUrl(version, `${formId}/leads`, {
        fields: LEAD_FIELDS, limit: 100,
        filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: sinceSeconds }]),
      });
      for await (const lead of paged(fetchImpl, leadsUrl, token)) leads.push({ lead, formName: form?.name ?? null });
    }
  }
  return leads;
}

const day = (iso) => (iso ?? "").slice(0, 10) || "unknown";

export async function pullMetaLeads(db, fetchImpl, { version, token, pageIds, sinceSeconds, execute = false }) {
  const metaLeads = await listMetaLeads(fetchImpl, { version, token, pageIds, sinceSeconds });
  const ids = metaLeads.map(({ lead }) => normalizeMetaId(lead?.id)).filter(Boolean);
  const stored = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await db.from("leads").select("meta_leadgen_id").in("meta_leadgen_id", chunk);
    if (error) throw new Error("crm_lookup_failed");
    for (const row of data ?? []) stored.add(row.meta_leadgen_id);
  }
  const byDay = {};
  const summary = { mode: execute ? "execute" : "dry_run", meta_leads: metaLeads.length,
    already_in_crm: 0, missing: 0, inserted: 0, merged: 0, duplicate: 0, failed: 0, by_day: byDay };
  for (const { lead, formName } of metaLeads) {
    let row;
    try { row = mapMetaLeadToRow(lead, { formName }); } catch { summary.failed++; continue; }
    const bucket = (byDay[day(row.created_at)] ??= { meta: 0, crm_before: 0 });
    bucket.meta++;
    if (stored.has(row.meta_leadgen_id)) { summary.already_in_crm++; bucket.crm_before++; continue; }
    summary.missing++;
    if (!execute) continue;
    try {
      const result = await storeMetaLead(db, row);
      summary[result.outcome]++;
      if (result.id && result.outcome !== "duplicate") {
        await enqueueMetaCrmStageEvent(db, { id: result.id, meta_leadgen_id: row.meta_leadgen_id }, "new",
          Math.floor(Date.parse(row.created_at) / 1000));
      }
    } catch { summary.failed++; }
  }
  return summary;
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
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.META_LEADS_ACCESS_TOKEN || !pageIds.length) {
    console.error("missing configuration: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, META_LEADS_ACCESS_TOKEN, META_LEADGEN_PAGE_IDS");
    process.exit(2);
  }
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
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
