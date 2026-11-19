// RBAC: cron (x-cron-secret). PREPARED, NOT ENABLED: answers "Disabled" unless ADS_SYNC_CRON_ENABLED=true
// is set in the runtime environment (S27).
//
// Daily Meta ad spend sync: the same read-then-one-atomic-replace as the admin route
// src/app/api/meta/ads-sync/route.ts, for the last 7 Dubai days ending yesterday. The window is deleted and
// re-inserted by replace_meta_ad_spend_window (it fences the delete to this account's source and refuses a
// window another source already covers), so running it twice changes nothing. Nothing is fetched from Meta
// unless the flag is on, and a failed or refused read never touches the stored rows.
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import {
  apiSourceForAccount,
  chooseTokenSource,
  classifyGraphError,
  defaultWindow,
  insightsUrl,
  mapInsights,
  normaliseAccountId,
} from "@/lib/meta-ads-insights.mjs";
import { atomicWriteError, atomicWriteResult } from "@/lib/meta-ads-write.mjs";

export const dynamic = "force-dynamic";

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v22.0";
const MAX_PAGES = 40;

type GraphPage = {
  data?: unknown[];
  paging?: { next?: string | null; cursors?: { after?: string | null } | null } | null;
  error?: { code?: number; message?: string } | null;
};

function secretMatches(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: Request) {
  if (!secretMatches(request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.ADS_SYNC_CRON_ENABLED !== "true") {
    return NextResponse.json({ message: "Disabled", reason: "Ads spend sync not enabled" }, { status: 200 });
  }

  const account = normaliseAccountId(process.env.META_AD_ACCOUNT_ID || "");
  if (!account) return NextResponse.json({ error: "ad_account_not_configured" }, { status: 500 });
  const namespace = apiSourceForAccount(account);
  const { since, until } = defaultWindow(7);

  const { data: secret, error: secretError } = await supabaseAdmin
    .from("meta_tokens").select("access_token, expires_at").eq("id", 1).maybeSingle();
  if (secretError) return NextResponse.json({ error: "token_lookup_failed" }, { status: 500 });
  const envToken = process.env.META_SYSTEM_USER_TOKEN;
  const choice = chooseTokenSource({ tokenRow: secret, envToken });
  if (choice.kind === "none") return NextResponse.json({ error: choice.reason }, { status: 409 });
  const credential = choice.kind === "env" ? (envToken as string) : (secret!.access_token as string);

  // Every page is read before the database is touched, so a Graph failure halfway cannot delete rows it has
  // no replacement for.
  const insights: unknown[] = [];
  let after: string | null = null;
  let pages = 0;
  while (pages < MAX_PAGES) {
    const url = insightsUrl({ accountId: account, since, until, graphVersion: GRAPH_VERSION, after });
    let payload: GraphPage | null = null;
    try {
      const resp = await fetch(url, { cache: "no-store", headers: { Authorization: `Bearer ${credential}` } });
      payload = await resp.json();
      if (!resp.ok || payload?.error) {
        const refusal = classifyGraphError(payload, resp.status) as { kind: string; status: number };
        logger.error({ operation: "cron_ads_sync", graph_kind: refusal.kind, since, until }, "[AdsSync] insights refused");
        return NextResponse.json({ error: refusal.kind, window: { since, until } }, { status: refusal.status });
      }
    } catch (e) {
      logger.error({ err: e, operation: "cron_ads_sync" }, "[AdsSync] insights unreachable");
      return NextResponse.json({ error: "graph_unreachable", window: { since, until } }, { status: 502 });
    }
    if (Array.isArray(payload?.data)) insights.push(...payload.data);
    pages += 1;
    after = payload?.paging?.cursors?.after && payload?.paging?.next ? payload.paging.cursors.after : null;
    if (!after) break;
  }
  if (pages >= MAX_PAGES && after) return NextResponse.json({ error: "window_too_large_for_pagination" }, { status: 400 });

  const { rows, rejected } = mapInsights(insights, { source: namespace });
  if (rejected.length > 0) {
    logger.error({ operation: "cron_ads_sync", since, until, rejected: rejected.length }, "[AdsSync] window refused: unmappable rows");
    return NextResponse.json({ error: "insight_rows_rejected", window: { since, until }, rejected: rejected.length }, { status: 422 });
  }

  const { data, error } = await supabaseAdmin.rpc("replace_meta_ad_spend_window", {
    p_account_id: account.slice(4),
    p_since: since,
    p_until: until,
    p_rows: rows,
  });
  if (error) {
    const refusal = atomicWriteError(error);
    logger.error({ operation: "cron_ads_sync", error_code: error.code, since, until }, "[AdsSync] atomic window replacement refused");
    return NextResponse.json({ error: refusal.error, window: { since, until } }, { status: refusal.status });
  }
  const receipt = atomicWriteResult(data, rows.length);
  if (!receipt.ok) return NextResponse.json({ error: receipt.error, window: { since, until } }, { status: 500 });
  logger.info({ operation: "cron_ads_sync", since, until, fetched: insights.length, inserted: receipt.inserted, deleted: receipt.deleted }, "[AdsSync] window replaced");
  return NextResponse.json({ ok: true, window: { since, until }, namespace, fetched: insights.length, inserted: receipt.inserted, deleted: receipt.deleted });
}

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
