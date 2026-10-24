// RBAC: active boss/admin only
/**
 * Admin-only read of Meta insights followed by one atomic window replacement.
 * All pages map successfully before the database is touched. The server-only
 * SECURITY INVOKER RPC owns the cross-process transaction lock, foreign-source
 * fence, delete/insert and full-row readback. The scheduler calls the same RPC.
 * No client can observe a committed empty/partial window after a failed write.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import {
  apiSourceForAccount,
  chooseTokenSource,
  classifyGraphError,
  insightsUrl,
  mapInsights,
  nextTokenSource,
  normaliseAccountId,
  windowFromRequest,
} from "@/lib/meta-ads-insights.mjs";

import { atomicWriteError, atomicWriteResult } from "@/lib/meta-ads-write.mjs";

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v22.0";
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || null;
/**
 * The only parts of a Graph insights page this route reads. Deliberately not
 * `any`: `data` stays `unknown[]` so every row still has to go through
 * mapInsights() before it can reach the database.
 */
type GraphInsightsPage = {
  data?: unknown[];
  paging?: { next?: string | null; cursors?: { after?: string | null } | null } | null;
  error?: { code?: number; error_subcode?: number; message?: string; type?: string } | null;
};

type Refusal = { kind: string; status: number; code: number | null; subcode: number | null };

const MAX_PAGES = 40;
const MAX_CREDENTIAL_ATTEMPTS = 2;

export const dynamic = "force-dynamic";

function serviceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin credentials");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function POST(request: NextRequest) {
  const request_id = genReqId();

  const bearerToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || undefined;
  const cookieHeader = request.headers.get("cookie") || "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, is_active")
    .eq("id", user.id)
    .single();

  if (
    profileError ||
    profile?.is_active !== true ||
    typeof profile?.role !== "string" ||
    !["admin", "boss"].includes(profile.role)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const account = normaliseAccountId(AD_ACCOUNT_ID || "");
  if (!account) {
    return NextResponse.json({ error: "ad_account_not_configured" }, { status: 500 });
  }
  // The namespace carries the account id, so pointing this route at a different
  // account cannot delete the previous account's rows.
  const namespace = apiSourceForAccount(account);

  const { searchParams } = new URL(request.url);
  const window = windowFromRequest(searchParams);
  if (window.error) return NextResponse.json({ error: window.error }, { status: 400 });
  const { since, until } = window as { since: string; until: string };

  let admin;
  try {
    admin = serviceRoleClient();
  } catch {
    return NextResponse.json({ error: "supabase_admin_unavailable" }, { status: 500 });
  }

  const { data: secret, error: secretError } = await admin
    .from("meta_tokens")
    .select("access_token, expires_at")
    .eq("id", 1)
    .maybeSingle();

  if (secretError) {
    logger.error({ err: secretError, request_id, operation: "meta_ads_sync" }, "[MetaAds] meta_tokens read failed");
    return NextResponse.json({ error: "token_lookup_failed" }, { status: 500 });
  }

  const envToken = process.env.META_SYSTEM_USER_TOKEN;
  let choice = chooseTokenSource({ tokenRow: secret, envToken });
  if (choice.kind === "none") {
    return NextResponse.json(
      { error: choice.reason, next: "grant_system_user_ads_read_or_authorise_via_oauth_start" },
      { status: 409 },
    );
  }
  let credential = choice.kind === "env" ? (envToken as string) : (secret!.access_token as string);

  // Fetch every page of the window before touching the database, so a Graph
  // failure halfway through cannot delete rows it has no replacement for.
  //
  // The outer loop exists for one case only: a stored OAuth token that Meta has
  // revoked while its expires_at is still in the future. chooseTokenSource()
  // prefers that row, so without a retry the sync stays dead until the row
  // expires even though a non-expiring system user token is configured.
  const insights: unknown[] = [];
  let pages = 0;
  let after: string | null = null;
  let refusal: Refusal | null = null;

  for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
    insights.length = 0;
    pages = 0;
    after = null;
    refusal = null;

    while (pages < MAX_PAGES) {
      let url;
      try {
        url = insightsUrl({ accountId: account, since, until, graphVersion: GRAPH_VERSION, after });
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 400 });
      }

      let payload: GraphInsightsPage | null = null;
      try {
        const resp = await fetch(url, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${credential}` },
        });
        payload = await resp.json();
        if (!resp.ok || payload?.error) {
          refusal = classifyGraphError(payload, resp.status) as Refusal;
          break;
        }
      } catch (e) {
        logger.error({ err: e, request_id, operation: "meta_ads_sync" }, "[MetaAds] insights unreachable");
        refusal = { kind: "graph_unreachable", status: 502, code: null, subcode: null };
        break;
      }

      if (Array.isArray(payload?.data)) insights.push(...payload.data);
      pages += 1;
      after = payload?.paging?.cursors?.after && payload?.paging?.next ? payload.paging.cursors.after : null;
      if (!after) break;
    }

    if (!refusal) break;

    const alternative = refusal.kind === "token_invalid" ? nextTokenSource(choice, { envToken }) : { kind: "none" };
    if (alternative.kind !== "env") break;
    logger.warn(
      { request_id, operation: "meta_ads_sync", fb_error_code: refusal.code },
      "[MetaAds] preferred credential rejected, retrying with the configured system user token",
    );
    choice = { ...choice, kind: "env", reason: "oauth_token_rejected_env_retry" };
    credential = envToken as string;
  }

  if (refusal) {
    logger.error(
      {
        request_id,
        operation: "meta_ads_sync",
        graph_kind: refusal.kind,
        fb_error_code: refusal.code,
        fb_error_subcode: refusal.subcode,
        token_source: choice.kind,
        since,
        until,
      },
      "[MetaAds] insights refused",
    );
    return NextResponse.json({ error: refusal.kind, graph_error: refusal }, { status: refusal.status });
  }

  if (pages >= MAX_PAGES && after) {
    logger.error({ request_id, operation: "meta_ads_sync", pages, since, until }, "[MetaAds] pagination cap hit");
    return NextResponse.json({ error: "window_too_large_for_pagination", pages }, { status: 400 });
  }

  const { rows, rejected, duplicates } = mapInsights(insights, { source: namespace });

  // Fail closed on a short window. Deleting the stored window and inserting only
  // the rows that happened to map would report ok:true for a window that
  // undercounts spend for good — a scheduler has no way to tell that apart from a
  // genuinely cheap week. A rejected row is a mapping bug or a currency this
  // table cannot represent; both need a human, and neither justifies a write.
  if (rejected.length > 0) {
    logger.error(
      { request_id, operation: "meta_ads_sync", since, until, rejected: rejected.length },
      "[MetaAds] window refused: unmappable rows",
    );
    return NextResponse.json(
      { error: "insight_rows_rejected", window: { since, until }, fetched: insights.length, rejected },
      { status: 422 },
    );
  }

  const { data, error } = await admin.rpc("replace_meta_ad_spend_window", {
    p_account_id: account.slice(4),
    p_since: since,
    p_until: until,
    p_rows: rows,
  });
  if (error) {
    const refusal = atomicWriteError(error);
    logger.error(
      { request_id, operation: "meta_ads_sync", error_code: error.code, since, until },
      "[MetaAds] atomic window replacement refused",
    );
    return NextResponse.json({ error: refusal.error, window: { since, until } }, { status: refusal.status });
  }
  const receipt = atomicWriteResult(data, rows.length);
  if (!receipt.ok) {
    return NextResponse.json({ error: receipt.error, window: { since, until } }, { status: 500 });
  }
  logger.info(
    { request_id, operation: "meta_ads_sync", since, until, fetched: insights.length,
      inserted: receipt.inserted, deleted: receipt.deleted },
    "[MetaAds] atomic window replaced",
  );
  return NextResponse.json({
    ok: true,
    atomic: true,
    window: { since, until },
    namespace,
    token_source: choice.kind,
    pages,
    fetched: insights.length,
    mappable: rows.length,
    inserted: receipt.inserted,
    deleted: receipt.deleted,
    present: receipt.present,
    duplicates_collapsed: duplicates,
    rejected,
  });
}
