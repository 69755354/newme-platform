// RBAC: active boss/admin only
/**
 * The missing hop: Meta ad insights → public.ad_spend.
 *
 * Nothing in this repository read public.meta_tokens before this route existed.
 * ad_spend was populated only by scripts/parse-ad-spend.py via
 * src/app/api/dashboard/ads-roi/import/route.ts, i.e. by hand, from an Excel
 * export sitting in COS. The ROI dashboard therefore showed CRM attribution
 * against manually imported spend, and a completed OAuth authorisation changed
 * nothing on screen.
 *
 * Idempotence: this route owns the source='meta_api' namespace of ad_spend and
 * replaces whole date windows inside it (delete then insert). Excel rows keep
 * source='meta' and are never read, deleted or rewritten here. Re-running the same
 * window twice is a no-op, which is what makes it safe to schedule. See
 * src/lib/meta-ads-insights.mjs for why replace-window rather than upsert.
 *
 * Deliberately not atomic: delete-then-insert is two statements, so a crash
 * between them leaves the window empty rather than doubled. That direction is the
 * safe one — ad_spend is derived data, re-running the window restores it, whereas
 * a doubled window silently inflates spend in the dashboard.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import {
  META_API_SOURCE,
  chooseTokenSource,
  classifyGraphError,
  insightsUrl,
  mapInsights,
  normaliseAccountId,
  windowFromRequest,
} from "@/lib/meta-ads-insights.mjs";

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

const MAX_PAGES = 40;

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
  const choice = chooseTokenSource({ tokenRow: secret, envToken });
  if (choice.kind === "none") {
    return NextResponse.json(
      { error: choice.reason, next: "grant_system_user_ads_read_or_authorise_via_oauth_start" },
      { status: 409 },
    );
  }
  const credential = choice.kind === "env" ? (envToken as string) : (secret!.access_token as string);

  // Fetch every page of the window before touching the database, so a Graph
  // failure halfway through cannot delete rows it has no replacement for.
  const insights: unknown[] = [];
  let after: string | null = null;
  let pages = 0;

  while (pages < MAX_PAGES) {
    let url;
    try {
      url = insightsUrl({ accountId: account, since, until, graphVersion: GRAPH_VERSION, after });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }

    let payload: GraphInsightsPage | null = null;
    let httpStatus = 0;
    try {
      const resp = await fetch(url, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${credential}` },
      });
      httpStatus = resp.status;
      payload = await resp.json();
      if (!resp.ok || payload?.error) {
        const classified = classifyGraphError(payload, httpStatus);
        logger.error(
          {
            request_id,
            operation: "meta_ads_sync",
            graph_kind: classified.kind,
            fb_error_code: classified.code,
            fb_error_subcode: classified.subcode,
            since,
            until,
          },
          "[MetaAds] insights refused",
        );
        return NextResponse.json({ error: classified.kind, graph_error: classified }, { status: classified.status });
      }
    } catch (e) {
      logger.error({ err: e, request_id, operation: "meta_ads_sync" }, "[MetaAds] insights unreachable");
      return NextResponse.json({ error: "graph_unreachable" }, { status: 502 });
    }

    if (Array.isArray(payload?.data)) insights.push(...payload.data);
    pages += 1;
    after = payload?.paging?.cursors?.after && payload?.paging?.next ? payload.paging.cursors.after : null;
    if (!after) break;
  }

  if (pages >= MAX_PAGES && after) {
    logger.error({ request_id, operation: "meta_ads_sync", pages, since, until }, "[MetaAds] pagination cap hit");
    return NextResponse.json({ error: "window_too_large_for_pagination", pages }, { status: 400 });
  }

  const { rows, rejected, duplicates } = mapInsights(insights);

  const { error: deleteError, count: deleted } = await admin
    .from("ad_spend")
    .delete({ count: "exact" })
    .eq("source", META_API_SOURCE)
    .gte("spend_date", since)
    .lte("spend_date", until);

  if (deleteError) {
    logger.error({ err: deleteError, request_id, operation: "meta_ads_sync" }, "[MetaAds] window clear failed");
    return NextResponse.json({ error: "window_clear_failed" }, { status: 500 });
  }

  let inserted = 0;
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const { data, error: insertError } = await admin
      .from("ad_spend")
      .insert(rows.slice(i, i + batchSize))
      .select("id");

    if (insertError) {
      // The window is now partially written. Say so with a 500 — a caller that
      // treats this as success would report a fraction of the real spend.
      logger.error(
        { err: insertError, request_id, operation: "meta_ads_sync", offset: i, inserted },
        "[MetaAds] insert failed mid-window",
      );
      return NextResponse.json(
        { error: "insert_failed", window: { since, until }, deleted: deleted ?? null, inserted, expected: rows.length },
        { status: 500 },
      );
    }
    inserted += data?.length || 0;
  }

  logger.info(
    { request_id, operation: "meta_ads_sync", since, until, fetched: insights.length, inserted, deleted: deleted ?? null },
    "[MetaAds] window replaced",
  );

  return NextResponse.json({
    ok: inserted === rows.length,
    window: { since, until },
    token_source: choice.kind,
    pages,
    fetched: insights.length,
    mappable: rows.length,
    inserted,
    deleted: deleted ?? null,
    duplicates_collapsed: duplicates,
    rejected,
  });
}
