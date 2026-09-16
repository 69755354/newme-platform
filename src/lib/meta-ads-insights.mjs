/**
 * Turning Meta Marketing API ad insights into ad_spend rows.
 *
 * Why this file exists: before it, nothing in this repository read
 * public.meta_tokens. src/app/api/meta/oauth-callback/route.ts wrote a token and
 * that was the end of the chain — the only thing that ever populated ad_spend was
 * scripts/parse-ad-spend.py, reading an Excel export from COS. So "connect Meta
 * Ads to the OS" could be fully authorised and still produce zero rows. This is
 * the missing hop, and it is deliberately a plain .mjs module (the same shape as
 * src/lib/money-rpc.mjs, imported from TypeScript as "@/lib/meta-ads-insights.mjs")
 * so the mapping and the idempotence key can be exercised by `node --test` with
 * no build step and no dependencies.
 *
 * Idempotence without a schema change: ad_spend has no unique key at all — its
 * only key is a gen_random_uuid() id, and the Excel importer does a bare insert
 * (src/app/api/dashboard/ads-roi/import/route.ts), so re-importing the same file
 * silently doubles the spend the dashboard reports. Rather than add a unique index
 * over data that already contains duplicates, the sync claims one namespace of the
 * table — source = 'meta_api' — and replaces whole date windows inside it:
 * delete where source='meta_api' and spend_date between since and until, then
 * insert. Rows written by the Excel importer keep source='meta' (the column
 * default) and are never touched. Re-running any window is therefore a no-op, and
 * a renamed ad does not fork into two rows the way an upsert-on-name would.
 */

export const META_API_SOURCE = "meta_api";
export const EXCEL_SOURCE = "meta";

/** level=ad + time_increment=1 is what makes one row mean "one ad on one day". */
export const INSIGHTS_FIELDS = [
  "date_start",
  "campaign_name",
  "adset_name",
  "ad_name",
  "spend",
  "impressions",
  "clicks",
  "account_currency",
];

/** YYYY-MM-DD, rejecting anything else rather than letting it reach the database. */
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * act_<digits>. The account id is configuration (META_AD_ACCOUNT_ID), never a
 * literal in the source: docs/meta-ads-auth-instructions.txt still names
 * 973440948936910 while the portfolio being connected uses 968615798111277, and a
 * hardcoded default would quietly pick a side of that contradiction.
 */
export function normaliseAccountId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const digits = trimmed.startsWith("act_") ? trimmed.slice(4) : trimmed;
  if (!/^\d{6,}$/.test(digits)) return null;
  return `act_${digits}`;
}

/**
 * One page of the window. `after` is the Graph cursor, so it is a string on
 * every call except the first.
 *
 * @param {{ accountId?: string | null, since?: string | null, until?: string | null,
 *           graphVersion?: string, after?: string | null }} input
 * @returns {URL}
 */
export function insightsUrl({ accountId, since, until, graphVersion = "v22.0", after = null }) {
  const account = normaliseAccountId(accountId);
  if (!account) throw new Error("invalid_ad_account_id");
  if (!isIsoDate(since) || !isIsoDate(until)) throw new Error("invalid_date_range");
  if (since > until) throw new Error("invalid_date_range");

  const url = new URL(`https://graph.facebook.com/${graphVersion}/${account}/insights`);
  url.searchParams.set("level", "ad");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("fields", INSIGHTS_FIELDS.join(","));
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("limit", "500");
  if (after) url.searchParams.set("after", after);
  return url;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toInteger(value) {
  const n = toNumber(value);
  return n === null ? null : Math.round(n);
}

/**
 * One Graph row → one ad_spend row. Unmappable rows are reported, not dropped
 * silently: a window that returned 40 rows and inserted 31 has to say so, because
 * the dashboard sums amount and a missing row reads as cheaper advertising.
 */
export function toAdSpendRow(insight) {
  const spendDate = insight?.date_start;
  if (!isIsoDate(spendDate)) return { ok: false, reason: "bad_date", insight };
  const amount = toNumber(insight?.spend);
  if (amount === null) return { ok: false, reason: "bad_spend", insight };

  return {
    ok: true,
    row: {
      campaign_name: insight.campaign_name ?? null,
      adset_name: insight.adset_name ?? null,
      ad_name: insight.ad_name ?? null,
      spend_date: spendDate,
      amount,
      currency: insight.account_currency ?? null,
      impressions: toInteger(insight.impressions),
      clicks: toInteger(insight.clicks),
      source: META_API_SOURCE,
    },
  };
}

/**
 * The key a replaced window makes unique: one ad, one day.
 *
 * The separator is U+0000 written as an escape, not as a literal byte. It has to
 * be a character that cannot occur inside a campaign, ad set or ad name, because
 * a space would make ("A B", "C") and ("A", "B C") the same key and collapse two
 * different ads into one row. Written literally it also makes git treat this file
 * as binary: `git diff` reports "Bin 0 -> 8712 bytes" and the resulting patch
 * fails to apply with "cannot apply binary patch without full index line".
 */
export function naturalKey(row) {
  return [row.spend_date, row.campaign_name ?? "", row.adset_name ?? "", row.ad_name ?? ""].join("\u0000");
}

/**
 * @typedef {{ campaign_name: string | null, adset_name: string | null, ad_name: string | null,
 *             spend_date: string, amount: number, currency: string | null,
 *             impressions: number | null, clicks: number | null, source: string }} AdSpendRow
 */

/**
 * @param {unknown} insights
 * @returns {{ rows: AdSpendRow[],
 *             rejected: { reason: string, date_start: string | null, ad_name: string | null }[],
 *             duplicates: number }}
 */
export function mapInsights(insights) {
  const rows = /** @type {AdSpendRow[]} */ ([]);
  const rejected = /** @type {{ reason: string, date_start: string | null, ad_name: string | null }[]} */ ([]);
  const seen = new Map();
  let duplicates = 0;

  for (const insight of Array.isArray(insights) ? insights : []) {
    const mapped = toAdSpendRow(insight);
    if (!mapped.ok) {
      rejected.push({
        reason: mapped.reason,
        date_start: insight?.date_start ?? null,
        ad_name: insight?.ad_name ?? null,
      });
      continue;
    }
    const key = naturalKey(mapped.row);
    const at = seen.get(key);
    if (at !== undefined) {
      // Graph can repeat a key across pages when an ad is edited mid-fetch. Last
      // one wins, and the collision is counted rather than summed — summing would
      // invent spend.
      rows[at] = mapped.row;
      duplicates += 1;
      continue;
    }
    seen.set(key, rows.length);
    rows.push(mapped.row);
  }

  return { rows, rejected, duplicates };
}

/** Inclusive window, defaulting to the last `days` days ending yesterday (UTC). */
export function defaultWindow(days = 7, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { since: iso(start), until: iso(end) };
}

export function windowFromRequest(searchParams, { maxDays = 92 } = {}) {
  const since = searchParams?.get?.("since");
  const until = searchParams?.get?.("until");
  if (!since && !until) return { ...defaultWindow(7), origin: "default" };
  if (!isIsoDate(since) || !isIsoDate(until)) return { error: "invalid_date_range" };
  if (since > until) return { error: "invalid_date_range" };
  const span = (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86400000 + 1;
  if (span > maxDays) return { error: "date_range_too_large" };
  return { since, until, origin: "request" };
}

/**
 * What a token check may say out loud. The access token itself is a third-party
 * credential and never leaves the server: not in a response body, not in a log
 * line. Callers get existence, expiry and a boolean.
 */
export function describeToken(tokenRow, now = new Date()) {
  if (!tokenRow) return { present: false, expires_at: null, expired: null, valid_for_hours: null };
  const expiresAt = tokenRow.expires_at ?? null;
  if (!expiresAt) return { present: true, expires_at: null, expired: null, valid_for_hours: null };
  const ms = Date.parse(expiresAt) - now.getTime();
  return {
    present: true,
    expires_at: expiresAt,
    expired: ms <= 0,
    valid_for_hours: Math.round(ms / 3600000),
  };
}

/**
 * Which credential to use, when there can be two.
 *
 * The Facebook Login flow is not the only way to hold an ads_read credential, and
 * on 2026-09-15 it was the broken one: the OAuth dialog for app 1612447067166445
 * answers "Facebook Login is currently unavailable for this app", and production's
 * runtime env carries no META_APP_ID or META_APP_SECRET at all, so oauth-start
 * could not even reach Meta. Meanwhile a Business system user token was already
 * working in this Business (debug_token: type SYSTEM_USER, expires_at 0, scope
 * read_ads_dataset_quality on the pixel) — proof that the system-user route is
 * live even while Login is not. A system user token granted ads_read on the ad
 * account needs no login dialog, no app review, no browser session and does not
 * expire, which removes three of the six acceptance steps rather than fixing them.
 *
 * So both sources are supported, and this function decides between them. It
 * returns the CHOICE, never the credential: callers hold the string, and the only
 * places it may appear are documented in
 * tests/security/meta-ads-sync-contract.test.mjs.
 *
 * A live database token wins over the environment, because it is the one a human
 * just authorised deliberately; an expired one loses to the environment, because a
 * non-expiring system user token is strictly better than a dead OAuth token.
 *
 * @param {{ tokenRow?: { access_token?: string | null, expires_at?: string | null } | null,
 *           envToken?: string | null, now?: Date }} [input]
 * @returns {{ kind: "db" | "env" | "none", reason: string, env_available: boolean }}
 */
export function chooseTokenSource({ tokenRow, envToken, now = new Date() } = {}) {
  const env = typeof envToken === "string" && envToken.trim() !== "" ? "present" : "absent";
  const dbToken = tokenRow?.access_token;
  const hasDb = typeof dbToken === "string" && dbToken.trim() !== "";
  const expiresAt = tokenRow?.expires_at ?? null;
  const dbExpired = hasDb && expiresAt ? Date.parse(expiresAt) <= now.getTime() : false;

  if (hasDb && !dbExpired) return { kind: "db", reason: "oauth_token_live", env_available: env === "present" };
  if (env === "present") {
    return {
      kind: "env",
      reason: hasDb ? "oauth_token_expired_env_fallback" : "no_oauth_token_env_fallback",
      env_available: true,
    };
  }
  if (hasDb && dbExpired) return { kind: "none", reason: "token_expired", env_available: false };
  return { kind: "none", reason: "no_token", env_available: false };
}

/** Graph's error shapes, reduced to something a route can return without leaking. */
export function classifyGraphError(payload, httpStatus) {
  const error = payload?.error;
  const code = error?.code;
  const subcode = error?.error_subcode;
  if (code === 190) return { kind: "token_invalid", status: 401, retryable: false, code, subcode };
  if (code === 200 || code === 10 || code === 272) {
    return { kind: "permission_missing", status: 403, retryable: false, code, subcode };
  }
  if (code === 17 || code === 80000 || code === 4) {
    return { kind: "rate_limited", status: 429, retryable: true, code, subcode };
  }
  if (code === 100) return { kind: "bad_request", status: 400, retryable: false, code, subcode };
  if (httpStatus >= 500) {
    return { kind: "upstream_error", status: 502, retryable: true, code: code ?? null, subcode: subcode ?? null };
  }
  return { kind: "unknown", status: 502, retryable: false, code: code ?? null, subcode: subcode ?? null };
}
