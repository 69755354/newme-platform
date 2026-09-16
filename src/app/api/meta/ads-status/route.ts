// RBAC: active boss/admin only
/**
 * Read-only preflight for the Meta Ads connection.
 *
 * The acceptance list for this feature has six independent steps — login,
 * authorisation, the token actually persisting, the ad account being readable,
 * real rows arriving, and the sync running on a schedule — and until now the only
 * evidence available for the middle two was an HTML page that says
 * "Authorization Successful!". That page proves nothing:
 * src/app/api/meta/oauth-callback/route.ts logs a failed database write and
 * returns success anyway, and its long-lived-token exchange falls back to
 * returning the SHORT token stamped with a made-up expires_in of 3600. So a
 * separate, read-only check is the only way to tell those steps apart.
 *
 * This route writes nothing and touches no Meta object other than reading. It
 * never returns the access token, and never logs it.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import {
  chooseTokenSource,
  classifyGraphError,
  describeToken,
  insightsUrl,
  mapInsights,
  normaliseAccountId,
} from "@/lib/meta-ads-insights.mjs";

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v22.0";
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || null;

export const dynamic = "force-dynamic";

async function requireAdmin(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || undefined;
  const cookieHeader = request.headers.get("cookie") || "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

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
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user };
}

function serviceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin credentials");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function GET(request: NextRequest) {
  const request_id = genReqId();
  const gate = await requireAdmin(request);
  if (gate.error) return gate.error;

  const checks: Record<string, unknown> = {
    // Measured on production 2026-09-15: neither of the first two is set in
    // /etc/newme/newme-runtime.env, so the OAuth flow cannot even reach Meta.
    // That is why a system user token is a first-class alternative here and not a
    // workaround.
    app_id_configured: Boolean(process.env.META_APP_ID),
    app_secret_configured: Boolean(process.env.META_APP_SECRET),
    system_user_token_configured: Boolean(process.env.META_SYSTEM_USER_TOKEN),
    ad_account_configured: Boolean(normaliseAccountId(AD_ACCOUNT_ID || "")),
    graph_version: GRAPH_VERSION,
  };

  let admin;
  try {
    admin = serviceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, checks, error: "supabase_admin_unavailable" }, { status: 500 });
  }

  const { data: tokenRow, error: tokenError } = await admin
    .from("meta_tokens")
    .select("id, expires_at, created_at")
    .eq("id", 1)
    .maybeSingle();

  if (tokenError) {
    logger.error({ err: tokenError, request_id, operation: "meta_ads_status" }, "[MetaAds] meta_tokens read failed");
    return NextResponse.json({ ok: false, checks, error: "token_lookup_failed" }, { status: 500 });
  }

  checks.token = describeToken(tokenRow);

  // Two possible credentials. The OAuth flow is not the only one, and as of
  // 2026-09-15 it is the broken one — see chooseTokenSource() for the evidence.
  const envToken = process.env.META_SYSTEM_USER_TOKEN;
  const { data: secret } = tokenRow
    ? await admin.from("meta_tokens").select("access_token").eq("id", 1).maybeSingle()
    : { data: null };

  const choice = chooseTokenSource({ tokenRow: { ...tokenRow, ...secret }, envToken });
  checks.token_source = choice;

  if (choice.kind === "none") {
    return NextResponse.json({
      ok: false,
      checks,
      next: "grant_system_user_ads_read_or_authorise_via_oauth_start",
    });
  }
  const credential = choice.kind === "env" ? (envToken as string) : (secret?.access_token as string);

  // Does the token see any ad account at all, and specifically the configured one?
  const accountsUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts`);
  accountsUrl.searchParams.set("fields", "account_id,name,account_status,currency");
  accountsUrl.searchParams.set("limit", "100");

  let visible: Array<{ account_id?: string; name?: string; account_status?: number; currency?: string }> = [];
  try {
    const resp = await fetch(accountsUrl, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${credential}` },
    });
    const payload = await resp.json();
    if (!resp.ok || payload?.error) {
      const classified = classifyGraphError(payload, resp.status);
      logger.error(
        { request_id, operation: "meta_ads_status", graph_kind: classified.kind, fb_error_code: classified.code },
        "[MetaAds] /me/adaccounts refused",
      );
      return NextResponse.json({ ok: false, checks, graph_error: classified }, { status: classified.status });
    }
    visible = Array.isArray(payload?.data) ? payload.data : [];
  } catch (e) {
    logger.error({ err: e, request_id, operation: "meta_ads_status" }, "[MetaAds] /me/adaccounts unreachable");
    return NextResponse.json({ ok: false, checks, error: "graph_unreachable" }, { status: 502 });
  }

  const wanted = normaliseAccountId(AD_ACCOUNT_ID || "");
  checks.visible_ad_accounts = visible.map((a) => ({
    account_id: a.account_id ?? null,
    name: a.name ?? null,
    account_status: a.account_status ?? null,
    currency: a.currency ?? null,
  }));
  checks.configured_ad_account_visible = wanted
    ? visible.some((a) => `act_${a.account_id}` === wanted)
    : null;

  // One-day insights probe: the smallest call that proves ads_read works on THIS
  // account. Reads only; nothing is written to ad_spend by this route.
  if (wanted && checks.configured_ad_account_visible) {
    const probeDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    try {
      const url = insightsUrl({ accountId: wanted, since: probeDay, until: probeDay, graphVersion: GRAPH_VERSION });
      const resp = await fetch(url, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${credential}` },
      });
      const payload = await resp.json();
      if (!resp.ok || payload?.error) {
        checks.insights_probe = { day: probeDay, ok: false, graph_error: classifyGraphError(payload, resp.status) };
      } else {
        const mapped = mapInsights(payload?.data);
        checks.insights_probe = {
          day: probeDay,
          ok: true,
          returned: Array.isArray(payload?.data) ? payload.data.length : 0,
          mappable: mapped.rows.length,
          rejected: mapped.rejected.length,
        };
      }
    } catch (e) {
      logger.error({ err: e, request_id, operation: "meta_ads_status" }, "[MetaAds] insights probe failed");
      checks.insights_probe = { day: probeDay, ok: false, error: "probe_failed" };
    }
  }

  const probe = checks.insights_probe as { ok?: boolean } | undefined;
  const ok = Boolean(checks.configured_ad_account_visible) && probe?.ok === true;
  return NextResponse.json({ ok, checks });
}
