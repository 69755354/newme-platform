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
 * Idempotence: this route owns one namespace of ad_spend per ad account —
 * apiSourceForAccount(), i.e. the 'meta_api' prefix plus the account id — and
 * replaces whole date windows inside it (delete then insert). Manually imported
 * rows keep the column default and are never read, deleted or rewritten here.
 * Re-running the same window twice is a no-op, which is what makes it safe to
 * schedule. See src/lib/meta-ads-insights.mjs for why replace-window rather than
 * upsert, and why the account id is part of the namespace.
 *
 * Deliberately not atomic: delete-then-insert is two statements, so a crash
 * between them leaves the window empty rather than doubled. That direction is the
 * safe one — ad_spend is derived data, re-running the window restores it, whereas
 * a doubled window silently inflates spend in the dashboard. Two guards make the
 * gap observable rather than merely hoped about: a single-flight latch around the
 * write phase, and a row count read back afterwards.
 *
 * Four things this route refuses to do rather than do approximately, because every
 * reader of ad_spend (src/app/api/dashboard/ads-roi/route.ts,
 * src/app/api/analytics/summary/route.ts) sums every row it can see without
 * looking at source or currency:
 *   1. write into a window that already holds rows from another source — that is
 *      double counting, not merging;
 *   2. write a window in which any row failed to map — a silently short window
 *      reads as cheaper advertising;
 *   3. write non-AED amounts, which the dashboard would format as AED;
 *   4. share one namespace between ad accounts.
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

/**
 * Single-flight latch over the write phase.
 *
 * delete-then-insert has no unique key behind it, so two overlapping runs — a
 * schedule and a manual retry, say — can both finish deleting before either
 * inserts, and the window ends up holding both copies. Node keeps one module
 * instance per server process, so this latch serialises the case that actually
 * occurs. It is not a distributed lock, which is why the row count is read back
 * after the insert: that check catches the multi-process case this cannot.
 */
let writeInFlight = false;

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

  if (writeInFlight) {
    return NextResponse.json({ error: "sync_already_running", window: { since, until } }, { status: 409 });
  }
  writeInFlight = true;
  try {
    // Every reader sums ad_spend without filtering on source, so an overlapping
    // window is double counting rather than a merge: the manually imported rows
    // for those dates stay, these rows are added, and CPL/ROAS inflate. The
    // overlap is named instead of resolved here — deciding which source wins for a
    // given date is a data migration, not a side effect of a sync.
    const { count: foreign, error: foreignError } = await admin
      .from("ad_spend")
      .select("id", { count: "exact", head: true })
      .neq("source", namespace)
      .gte("spend_date", since)
      .lte("spend_date", until);

    if (foreignError) {
      logger.error({ err: foreignError, request_id, operation: "meta_ads_sync" }, "[MetaAds] overlap probe failed");
      return NextResponse.json({ error: "overlap_probe_failed" }, { status: 500 });
    }

    if ((foreign ?? 0) > 0) {
      logger.error(
        { request_id, operation: "meta_ads_sync", since, until, foreign },
        "[MetaAds] window refused: spend from another source already covers it",
      );
      return NextResponse.json(
        {
          error: "overlapping_spend_window",
          window: { since, until },
          foreign_rows: foreign,
          next: "retire_or_re_source_the_overlapping_rows_before_syncing_this_window",
        },
        { status: 409 },
      );
    }

    const { error: deleteError, count: deleted } = await admin
      .from("ad_spend")
      .delete({ count: "exact" })
      .eq("source", namespace)
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

    // Read the window back. The latch above only covers this process; if a second
    // process replaced the same window concurrently, the count is the evidence.
    const { count: present, error: verifyError } = await admin
      .from("ad_spend")
      .select("id", { count: "exact", head: true })
      .eq("source", namespace)
      .gte("spend_date", since)
      .lte("spend_date", until);

    if (verifyError) {
      logger.error({ err: verifyError, request_id, operation: "meta_ads_sync" }, "[MetaAds] read-back failed");
      return NextResponse.json({ error: "window_verify_failed", inserted }, { status: 500 });
    }

    if ((present ?? -1) !== rows.length) {
      logger.error(
        { request_id, operation: "meta_ads_sync", since, until, present, expected: rows.length },
        "[MetaAds] window holds an unexpected row count",
      );
      return NextResponse.json(
        {
          ok: false,
          error: "window_row_count_mismatch",
          window: { since, until },
          present: present ?? null,
          expected: rows.length,
          next: "re_run_this_window_alone",
        },
        { status: 409 },
      );
    }

    logger.info(
      { request_id, operation: "meta_ads_sync", since, until, fetched: insights.length, inserted, deleted: deleted ?? null },
      "[MetaAds] window replaced",
    );

    return NextResponse.json({
      ok: inserted === rows.length,
      window: { since, until },
      namespace,
      token_source: choice.kind,
      pages,
      fetched: insights.length,
      mappable: rows.length,
      inserted,
      deleted: deleted ?? null,
      duplicates_collapsed: duplicates,
      rejected,
    });
  } finally {
    writeInFlight = false;
  }
}
