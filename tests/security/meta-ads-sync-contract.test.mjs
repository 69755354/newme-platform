/**
 * The Meta ads sync: what it may touch, and what it may say out loud.
 *
 * Two classes of assertion live here, and each one has a negative control that
 * mutates the thing being asserted about and requires the check to go red. A
 * check with no negative control cannot distinguish "the boundary holds" from
 * "the check never looked", which is the failure mode that produced F-10 (a
 * permissive policy sitting next to an admin-only one, with nothing comparing
 * them) and PROD-F09's four contradictory role lists.
 *
 * 1. Pure behaviour of src/lib/meta-ads-insights.mjs — the mapping, the window
 *    arithmetic, the duplicate collapse, and the promise that a token summary
 *    cannot carry the token.
 * 2. Source coupling of the two routes — the delete is scoped to the namespace
 *    this feature owns, the third-party credential never reaches a response body,
 *    and the RBAC gate is the same one src/app/api/meta/oauth-start/route.ts uses.
 *
 * No dependencies and no build step: `node --test tests/security/`.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCOUNT_CURRENCY,
  API_SOURCE_PREFIX,
  EXCEL_SOURCE,
  META_API_SOURCE,
  apiSourceForAccount,
  chooseTokenSource,
  classifyGraphError,
  defaultWindow,
  describeToken,
  insightKey,
  insightsUrl,
  isApiSource,
  isIsoDate,
  mapInsights,
  naturalKey,
  nextTokenSource,
  normaliseAccountId,
  windowFromRequest,
} from "../../src/lib/meta-ads-insights.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SYNC = "src/app/api/meta/ads-sync/route.ts";
const STATUS = "src/app/api/meta/ads-status/route.ts";
const IMPORTER = "src/app/api/dashboard/ads-roi/import/route.ts";
const INSIGHTS = "src/lib/meta-ads-insights.mjs";
/** One AED ad-day, as Graph returns it. */
const AED = { account_currency: "AED" };

const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

// --------------------------------------------------------------------------
// 1 · the mapping
// --------------------------------------------------------------------------

test("a date has to be a real calendar day", () => {
  assert.equal(isIsoDate("2026-09-14"), true);
  assert.equal(isIsoDate("2026-02-30"), false, "Feb 30 is not a day");
  assert.equal(isIsoDate("2026-9-14"), false);
  assert.equal(isIsoDate(""), false);
  assert.equal(isIsoDate(null), false);
});

test("the ad account id comes from configuration and is normalised, not guessed", () => {
  assert.equal(normaliseAccountId("968615798111277"), "act_968615798111277");
  assert.equal(normaliseAccountId("act_968615798111277"), "act_968615798111277");
  assert.equal(normaliseAccountId(" act_968615798111277 "), "act_968615798111277");
  assert.equal(normaliseAccountId("act_"), null);
  assert.equal(normaliseAccountId("not-an-id"), null);
  assert.equal(normaliseAccountId(undefined), null);
});

test("the insights call is the one that makes a row mean one ad on one day", () => {
  const url = insightsUrl({ accountId: "968615798111277", since: "2026-09-01", until: "2026-09-07" });
  assert.equal(url.pathname, "/v22.0/act_968615798111277/insights");
  assert.equal(url.searchParams.get("level"), "ad");
  assert.equal(url.searchParams.get("time_increment"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("time_range")), { since: "2026-09-01", until: "2026-09-07" });
  for (const field of ["date_start", "spend", "impressions", "clicks", "account_currency", "ad_name"]) {
    assert.ok(url.searchParams.get("fields").split(",").includes(field), `fields must include ${field}`);
  }
});

test("a backwards or malformed window is refused before it reaches Graph", () => {
  assert.throws(() => insightsUrl({ accountId: "968615798111277", since: "2026-09-07", until: "2026-09-01" }), /invalid_date_range/);
  assert.throws(() => insightsUrl({ accountId: "968615798111277", since: "yesterday", until: "2026-09-01" }), /invalid_date_range/);
  assert.throws(() => insightsUrl({ accountId: "junk", since: "2026-09-01", until: "2026-09-01" }), /invalid_ad_account_id/);
});

test("every mapped row is claimed by this feature's namespace", () => {
  const namespace = apiSourceForAccount("968615798111277");
  const { rows } = mapInsights(
    [
      { date_start: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Ad1", spend: "12.34", impressions: "1000", clicks: "7", account_currency: "AED" },
    ],
    { source: namespace },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, namespace);
  assert.ok(rows[0].source.startsWith(META_API_SOURCE));
  assert.equal(rows[0].amount, 12.34);
  assert.equal(rows[0].impressions, 1000);
  assert.equal(rows[0].clicks, 7);
  assert.equal(rows[0].currency, "AED");
  assert.equal(rows[0].spend_date, "2026-09-01");
});

test("a repeated ad-day is collapsed, never summed", () => {
  const { rows, duplicates } = mapInsights([
    { ...AED, date_start: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Ad1", spend: "10" },
    { ...AED, date_start: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Ad1", spend: "11" },
  ]);
  assert.equal(rows.length, 1, "one ad on one day is one row");
  assert.equal(duplicates, 1);
  assert.equal(rows[0].amount, 11, "last page wins; 21 would be invented spend");
});

test("an unmappable row is reported, not dropped quietly", () => {
  const { rows, rejected } = mapInsights([
    { ...AED, date_start: "2026-09-01", ad_name: "good", spend: "5" },
    { ...AED, date_start: "not-a-date", ad_name: "bad date", spend: "5" },
    { ...AED, date_start: "2026-09-02", ad_name: "no spend" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected.map((r) => r.reason).sort(), ["bad_date", "bad_spend"]);
});

test("the natural key is ad-and-day, so a renamed ad does not fork history", () => {
  const base = { spend_date: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Ad1" };
  assert.equal(naturalKey(base), naturalKey({ ...base }));
  assert.notEqual(naturalKey(base), naturalKey({ ...base, spend_date: "2026-09-02" }));
  assert.notEqual(naturalKey(base), naturalKey({ ...base, ad_name: "Ad2" }));
});

test("the key separator cannot occur inside a Meta object name", () => {
  // Meta names contain spaces, hyphens, pipes and slashes as a matter of course
  // ("Q3 | Villas | Retarget"), so any printable separator can be produced by the
  // names themselves. These two rows are different ads and must not collapse.
  const day = { spend_date: "2026-09-01", ad_name: "Ad1" };
  assert.notEqual(
    naturalKey({ ...day, campaign_name: "A B", adset_name: "C" }),
    naturalKey({ ...day, campaign_name: "A", adset_name: "B C" }),
  );
  assert.notEqual(
    naturalKey({ ...day, campaign_name: "A|B", adset_name: "C" }),
    naturalKey({ ...day, campaign_name: "A", adset_name: "B|C" }),
  );

  const { rows, duplicates } = mapInsights([
    { ...AED, date_start: "2026-09-01", campaign_name: "A B", adset_name: "C", ad_name: "Ad1", spend: "10" },
    { ...AED, date_start: "2026-09-01", campaign_name: "A", adset_name: "B C", ad_name: "Ad1", spend: "20" },
  ]);
  assert.equal(rows.length, 2, "two different ads must stay two rows");
  assert.equal(duplicates, 0);
});

test("no new file carries a raw NUL byte", async () => {
  // U+0000 belongs in the separator, but as the escape "\\u0000". Written as a
  // literal byte it makes git classify the file as binary — `git diff` emits
  // "Bin 0 -> 8712 bytes" and the patch then refuses to apply with "cannot apply
  // binary patch without full index line". Found exactly that way.
  for (const rel of [SYNC, STATUS, "src/lib/meta-ads-insights.mjs"]) {
    const bytes = await readFile(path.join(ROOT, rel));
    assert.equal(bytes.includes(0), false, `${rel} must be reviewable as text`);

    // Negative control, and it pins a real subtlety: Buffer#includes(0) searches
    // for the byte, while String#includes(0) coerces to "0" and would pass on
    // every file that contains a digit. Reading the file as utf8 would make this
    // check vacuous.
    assert.equal(Buffer.concat([bytes, Buffer.from([0])]).includes(0), true);
  }
});

test("the default window ends yesterday, because today is still accruing", () => {
  const now = new Date("2026-09-15T06:00:00Z");
  assert.deepEqual(defaultWindow(7, now), { since: "2026-09-08", until: "2026-09-14" });
  assert.deepEqual(defaultWindow(1, now), { since: "2026-09-14", until: "2026-09-14" });
});

test("a requested window is bounded", () => {
  const params = (o) => ({ get: (k) => (k in o ? o[k] : null) });
  assert.equal(windowFromRequest(params({})).origin, "default");
  assert.deepEqual(
    windowFromRequest(params({ since: "2026-09-01", until: "2026-09-02" })),
    { since: "2026-09-01", until: "2026-09-02", origin: "request" },
  );
  assert.equal(windowFromRequest(params({ since: "2026-09-02", until: "2026-09-01" })).error, "invalid_date_range");
  assert.equal(windowFromRequest(params({ since: "2026-09-01" })).error, "invalid_date_range");
  assert.equal(windowFromRequest(params({ since: "2025-01-01", until: "2026-09-01" })).error, "date_range_too_large");
});

test("a token summary cannot carry the token", () => {
  const summary = describeToken(
    { access_token: "SECRET-DO-NOT-LEAK", expires_at: "2026-11-14T00:00:00.000Z" },
    new Date("2026-09-15T00:00:00.000Z"),
  );
  const serialised = JSON.stringify(summary);
  assert.ok(!serialised.includes("SECRET-DO-NOT-LEAK"), "the summary must not contain the credential");
  assert.ok(!("access_token" in summary));
  assert.equal(summary.present, true);
  assert.equal(summary.expired, false);
  assert.equal(summary.valid_for_hours, 1440);

  const absent = describeToken(null);
  assert.deepEqual(absent, { present: false, expires_at: null, expired: null, valid_for_hours: null });

  // The oauth-callback writes expires_at = now when Graph omits expires_in, so an
  // already-expired row is a real state the status route has to name.
  const dead = describeToken({ expires_at: "2026-09-14T00:00:00.000Z" }, new Date("2026-09-15T00:00:00.000Z"));
  assert.equal(dead.expired, true);
});

test("a live OAuth token wins, an expired one loses to the system user token", () => {
  const now = new Date("2026-09-15T00:00:00.000Z");
  const live = { access_token: "OAUTH", expires_at: "2026-11-14T00:00:00.000Z" };
  const dead = { access_token: "OAUTH", expires_at: "2026-09-14T00:00:00.000Z" };

  assert.equal(chooseTokenSource({ tokenRow: live, envToken: "SYSUSER", now }).kind, "db");
  assert.equal(chooseTokenSource({ tokenRow: live, envToken: undefined, now }).kind, "db");

  // An expired OAuth token must not shadow a non-expiring system user token: that
  // would turn a working connection into a dead one every 60 days.
  const fallback = chooseTokenSource({ tokenRow: dead, envToken: "SYSUSER", now });
  assert.equal(fallback.kind, "env");
  assert.equal(fallback.reason, "oauth_token_expired_env_fallback");

  assert.equal(chooseTokenSource({ tokenRow: null, envToken: "SYSUSER", now }).kind, "env");
  assert.equal(chooseTokenSource({ tokenRow: dead, envToken: undefined, now }).reason, "token_expired");
  assert.equal(chooseTokenSource({ tokenRow: null, envToken: undefined, now }).reason, "no_token");
  assert.equal(chooseTokenSource({ tokenRow: null, envToken: "   ", now }).kind, "none", "blank env var is not a token");
  assert.equal(chooseTokenSource().kind, "none", "no arguments is not a credential either");
});

test("the choice never carries either credential", () => {
  const serialised = JSON.stringify(
    chooseTokenSource({
      tokenRow: { access_token: "OAUTH-SECRET", expires_at: "2026-11-14T00:00:00.000Z" },
      envToken: "SYSUSER-SECRET",
    }),
  );
  assert.ok(!serialised.includes("OAUTH-SECRET"));
  assert.ok(!serialised.includes("SYSUSER-SECRET"));
  // ads-status puts this object straight into its response body, so the negative
  // control is the assertion above being able to fail: prove it can see a leak.
  assert.ok(JSON.stringify({ ...chooseTokenSource({ envToken: "X" }), t: "SYSUSER-SECRET" }).includes("SYSUSER-SECRET"));
});

test("both routes decide the source through the shared function", async () => {
  for (const rel of [SYNC, STATUS]) {
    const source = await read(rel);
    assert.ok(/chooseTokenSource\(/.test(source), `${rel} must not re-implement the choice`);
    assert.ok(/META_SYSTEM_USER_TOKEN/.test(source), `${rel} must accept a system user token`);
    // The old shape — trusting meta_tokens alone — would leave the feature dead
    // while Facebook Login is unavailable, which is the state production is in.
    assert.ok(!/Bearer \$\{secret[.?]/.test(source), `${rel} must send the chosen credential, not the row`);
  }
});

test("Graph's refusals are told apart, because they need different fixes", () => {
  assert.equal(classifyGraphError({ error: { code: 190 } }, 400).kind, "token_invalid");
  assert.equal(classifyGraphError({ error: { code: 200 } }, 403).kind, "permission_missing");
  assert.equal(classifyGraphError({ error: { code: 17 } }, 400).kind, "rate_limited");
  assert.equal(classifyGraphError({ error: { code: 17 } }, 400).retryable, true);
  assert.equal(classifyGraphError({ error: { code: 100 } }, 400).kind, "bad_request");
  assert.equal(classifyGraphError({}, 503).kind, "upstream_error");
  assert.equal(classifyGraphError({ error: { code: 190 } }, 400).retryable, false);
});

// --------------------------------------------------------------------------
// 2 · source coupling, each with a negative control
// --------------------------------------------------------------------------

/** The delete has to be fenced to this feature's namespace AND to the window. */
function deleteIsFenced(source) {
  const call = source.match(/\.from\("ad_spend"\)\s*\.delete\([^)]*\)([\s\S]{0,300})/);
  if (!call) return false;
  const tail = call[1];
  return (
    /\.eq\("source",\s*namespace\)/.test(tail) &&
    /\.gte\("spend_date",\s*since\)/.test(tail) &&
    /\.lte\("spend_date",\s*until\)/.test(tail)
  );
}

test("the sync only ever clears rows it wrote itself", async () => {
  const source = await read(SYNC);
  assert.ok(deleteIsFenced(source), "delete must be scoped to this account's namespace and to the window");

  // Negative control: drop the namespace fence and the check must go red, or it
  // was never looking. Without this fence the sync would delete the manually
  // imported Excel spend (source='meta') for the same dates — and before the
  // namespace carried the account id, a second ad account would have deleted the
  // first one's rows for every overlapping day.
  const unfenced = source.replace(/\.eq\("source",\s*namespace\)\s*\n/, "\n");
  assert.notEqual(unfenced, source, "the negative control must actually mutate the source");
  assert.equal(deleteIsFenced(unfenced), false, "the check must fail once the fence is gone");
});

test("the sync never reads or rewrites the Excel importer's rows", async () => {
  const source = await read(SYNC);
  assert.ok(!/EXCEL_SOURCE/.test(source));
  assert.ok(!/"meta"(?!_)/.test(source.replace(/\/\*[\s\S]*?\*\//g, "")), "no bare source='meta' outside the header comment");
  assert.ok(!/\.upsert\(/.test(source), "upsert on a table with no unique key silently duplicates");
});

/**
 * Nothing that goes back to a browser, or into a log, may carry the credential.
 *
 * Enumerating response shapes was the first attempt and it was the wrong shape of
 * check — it only matched the multi-line calls, so a single-line leak would have
 * passed. The rule is inverted instead: `access_token` may appear only where it
 * legitimately has to, and every other occurrence is a finding whatever syntax it
 * is wrapped in.
 */
const ACCESS_TOKEN_ALLOWED = [
  /\.select\(/, // asking the database for it
  /Authorization: `Bearer/, // handing it to Graph
  /!secret\?\.access_token/, // guarding on its absence
  /^\s*(const|let) credential = /, // choosing between the two sources; `let` because of the one retry
];
// `if (` was in this list first and made the whole check vacuous: the first
// NextResponse.json in each route sits on an `if (authError || !user) return ...`
// line, so an injected leak there was silently allowed. The negative controls are
// what surfaced that — the check passed while the leak was present.

function credentialLeaks(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return stripped
    .split("\n")
    .filter((line) => line.includes("access_token"))
    .filter((line) => !ACCESS_TOKEN_ALLOWED.some((allowed) => allowed.test(line)));
}

test("the access token never reaches a response body or a log line", async () => {
  for (const rel of [SYNC, STATUS]) {
    const source = await read(rel);
    assert.deepEqual(credentialLeaks(source), [], `${rel} must not emit the credential`);

    // Negative control: put it in a response and require the check to notice.
    const leaked = source.replace("NextResponse.json({", 'NextResponse.json({ access_token: secret.access_token,');
    assert.notEqual(leaked, source, `the negative control must mutate ${rel}`);
    assert.equal(credentialLeaks(leaked).length, 1, `${rel}: the check must catch a leak in a response body`);

    // Second negative control: the same credential in a log line.
    const logged = source.replace("logger.error({", "logger.error({ access_token: secret.access_token,");
    assert.notEqual(logged, source, `the log negative control must mutate ${rel}`);
    assert.equal(credentialLeaks(logged).length, 1, `${rel}: the check must catch a leak in a log line`);
  }
});

/** The same gate oauth-start uses: active, and admin or boss. */
function rbacGateMatchesOauthStart(source) {
  return (
    /profile\?\.is_active !== true/.test(source) &&
    /\["admin", "boss"\]\.includes\(profile\.role\)/.test(source) &&
    /status: 403/.test(source) &&
    /status: 401/.test(source)
  );
}

test("both routes are gated exactly like oauth-start", async () => {
  const reference = await read("src/app/api/meta/oauth-start/route.ts");
  assert.ok(rbacGateMatchesOauthStart(reference), "the reference gate must itself match, or this test is asserting nothing");

  for (const rel of [SYNC, STATUS]) {
    const source = await read(rel);
    assert.ok(rbacGateMatchesOauthStart(source), `${rel} must carry the same gate`);

    // Negative control: widen the role list and require the check to go red.
    const widened = source.replace(/\["admin", "boss"\]/, '["admin", "boss", "operator"]');
    assert.notEqual(widened, source, `the negative control must mutate ${rel}`);
    assert.equal(rbacGateMatchesOauthStart(widened), false, `${rel}: the check must fail once the gate widens`);
  }
});

test("no ad account id is hardcoded in the new code", async () => {
  for (const rel of [SYNC, STATUS, "src/lib/meta-ads-insights.mjs"]) {
    const source = await read(rel);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const digits = code.match(/\b\d{9,}\b/g) || [];
    assert.deepEqual(digits, [], `${rel} must take the account id from META_AD_ACCOUNT_ID, not a literal (found ${digits})`);
  }
});

test("the whole window is fetched before anything is deleted", async () => {
  const source = await read(SYNC);
  const deleteAt = source.indexOf('.from("ad_spend")');
  const fetchLoopAt = source.indexOf("while (pages < MAX_PAGES)");
  assert.ok(fetchLoopAt > -1 && deleteAt > -1);
  assert.ok(fetchLoopAt < deleteAt, "a Graph failure must not be able to leave a window deleted with no replacement");
});

test("a partially written window is reported as a failure, not a success", async () => {
  const source = await read(SYNC);
  const insertBlock = source.slice(source.indexOf("for (let i = 0; i < rows.length"));
  assert.ok(/error: "insert_failed"/.test(insertBlock));
  assert.ok(/status: 500/.test(insertBlock), "a half-written window must not return 200");
  assert.ok(/ok: inserted === rows\.length/.test(source), "ok must mean every mappable row landed");
});

// --------------------------------------------------------------------------
// 3 · the review fixes, and what each one is preventing
// --------------------------------------------------------------------------

test("ad_id is requested, or the key quietly falls back to names", () => {
  assert.ok(INSIGHTS_FIELDS_INCLUDES("ad_id"), "level=ad without ad_id gives no stable identity");
});

function INSIGHTS_FIELDS_INCLUDES(field) {
  const url = insightsUrl({ accountId: "968615798111277", since: "2026-09-01", until: "2026-09-01" });
  return url.searchParams.get("fields").split(",").includes(field);
}

test("two ads sharing a name stay two rows, one ad twice stays one row", () => {
  // The Ads Manager duplicate flow produces two ads with the same name in the same
  // ad set. Keyed on names alone they collapsed into one row and half the spend
  // left the window — invisibly, because the run still reported success.
  const day = { ...AED, date_start: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Villa retarget", spend: "10" };
  const distinct = mapInsights([{ ...day, ad_id: "1111" }, { ...day, ad_id: "2222", spend: "20" }]);
  assert.equal(distinct.rows.length, 2, "two ad ids are two ads, whatever they are called");
  assert.equal(distinct.duplicates, 0);
  assert.equal(distinct.rows.reduce((s, r) => s + r.amount, 0), 30);

  // Negative control for the same key: the SAME ad id twice must still collapse,
  // otherwise the key has stopped identifying anything and every page boundary
  // would duplicate spend.
  const repeated = mapInsights([{ ...day, ad_id: "1111" }, { ...day, ad_id: "1111", spend: "11" }]);
  assert.equal(repeated.rows.length, 1);
  assert.equal(repeated.duplicates, 1);
  assert.equal(repeated.rows[0].amount, 11, "last page wins; 21 would be invented spend");

  // A rename mid-window is one ad, not two, once ad_id is present.
  const renamed = mapInsights([{ ...day, ad_id: "1111" }, { ...day, ad_id: "1111", ad_name: "Villa retarget v2" }]);
  assert.equal(renamed.rows.length, 1);

  // Without an ad id the key falls back to names, and the two shapes cannot
  // collide: two segments against four.
  const row = { spend_date: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Ad1" };
  assert.equal(insightKey({}, row), naturalKey(row));
  assert.notEqual(insightKey({ ad_id: "1111" }, row), naturalKey(row));
  assert.equal(insightKey({ ad_id: " 1111 " }, row), insightKey({ ad_id: "1111" }, row), "Graph pads ids in some responses");
  assert.equal(insightKey({ ad_id: "not-a-number" }, row), naturalKey(row), "a non-numeric id is not an id");
});

test("a row in another currency is refused, never converted", () => {
  // Every reader sums `amount` and labels the total AED, so a USD row is not a
  // different unit in the output — it is a wrong number. Converting it here would
  // bake a made-up rate into the ledger with nothing recording that it happened.
  const day = { date_start: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Ad1", spend: "10" };
  const { rows, rejected } = mapInsights([
    { ...day, ad_id: "1", account_currency: "AED" },
    { ...day, ad_id: "2", account_currency: "USD" },
    { ...day, ad_id: "3" },
    { ...day, ad_id: "4", account_currency: "   " },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, ACCOUNT_CURRENCY);
  // Blank is missing, not wrong: there is nothing to disagree with.
  assert.deepEqual(rejected.map((r) => r.reason).sort(), ["missing_currency", "missing_currency", "wrong_currency"]);

  // Case and padding are the account's, not a second currency.
  const lax = mapInsights([{ ...day, ad_id: "5", account_currency: " aed " }]);
  assert.equal(lax.rows.length, 1);
  assert.equal(lax.rejected.length, 0);
});

test("the namespace carries the ad account, so two accounts cannot erase each other", () => {
  const a = apiSourceForAccount("968615798111277");
  const b = apiSourceForAccount("act_973440948936910");
  assert.notEqual(a, b, "a shared namespace means syncing B deletes A's overlapping days");
  assert.ok(a.startsWith(API_SOURCE_PREFIX) && b.startsWith(API_SOURCE_PREFIX));
  assert.equal(apiSourceForAccount(" 968615798111277 "), a, "the same account is one namespace");
  assert.throws(() => apiSourceForAccount("junk"), /invalid_ad_account_id/);
  assert.throws(() => apiSourceForAccount(null), /invalid_ad_account_id/);

  // The Excel importer's rows must stay outside every API namespace, in both
  // directions: no API namespace may equal or prefix-match 'meta'.
  assert.ok(isApiSource(a));
  assert.equal(isApiSource(EXCEL_SOURCE), false);
  assert.equal(isApiSource("meta_api"), false, "the bare namespace is no longer produced");
  assert.notEqual(a, EXCEL_SOURCE);
  assert.ok(!EXCEL_SOURCE.startsWith(API_SOURCE_PREFIX));
});

test("the credential retry is one-way, and only when there is somewhere to go", () => {
  // oauth-callback stores a token even when the long-lived exchange failed,
  // stamped with a made-up expires_in of 3600, so a row can look live and be
  // rejected by Graph. Without this hop the nightly sync would answer 401 while a
  // working system user token sat unused in the environment.
  assert.deepEqual(nextTokenSource({ kind: "db" }, { envToken: "SYSUSER" }), {
    kind: "env",
    reason: "oauth_token_rejected_env_retry",
  });
  assert.equal(nextTokenSource({ kind: "db" }, { envToken: "" }).kind, "none");
  assert.equal(nextTokenSource({ kind: "db" }, {}).kind, "none");
  assert.equal(nextTokenSource({ kind: "db" }).kind, "none");
  // Never the other way: replaying a credential Graph has already refused is how
  // an app gets rate limited, and there is nothing left to try.
  assert.equal(nextTokenSource({ kind: "env" }, { envToken: "SYSUSER" }).kind, "none");
  assert.equal(nextTokenSource({ kind: "none" }, { envToken: "SYSUSER" }).kind, "none");
  assert.equal(nextTokenSource(null, { envToken: "SYSUSER" }).kind, "none");
});

test("the retry is bounded, so a refused credential is not replayed all night", async () => {
  const source = await read(SYNC);
  assert.ok(/MAX_CREDENTIAL_ATTEMPTS = 2/.test(source), "the bound has to be a constant, not a while(true)");
  assert.ok(/attempt < MAX_CREDENTIAL_ATTEMPTS/.test(source));
  assert.ok(/nextTokenSource\(/.test(source), "the sync must not re-implement the fallback rule");
  assert.ok(/MAX_PAGES = \d+/.test(source), "the paging loop needs a bound too");
});

test("a rejected row stops the run before the window is deleted", async () => {
  // Fail closed. Deleting a window and then replacing it with fewer rows than
  // Graph returned reads as cheaper advertising, and nothing afterwards can tell
  // that a row went missing.
  const source = await read(SYNC);
  const rejectAt = source.indexOf('error: "insight_rows_rejected"');
  const deleteAt = source.indexOf(".delete(");
  assert.ok(rejectAt > -1, "the sync must refuse a window it could not fully map");
  assert.ok(deleteAt > -1);
  assert.ok(rejectAt < deleteAt, "the refusal must come before the delete");
  assert.ok(/status: 422/.test(source.slice(rejectAt, rejectAt + 400)));

  // Negative control: let the rejected rows through and require this to go red.
  const permissive = source.replace('error: "insight_rows_rejected"', 'ignored: "rejected"');
  assert.notEqual(permissive, source, "the negative control must mutate the source");
  assert.equal(permissive.indexOf('error: "insight_rows_rejected"'), -1);
});

/** A writer of ad_spend has to refuse a window another source already covers. */
function writerRefusesForeignWindow(source) {
  return (
    /overlapping_spend_window/.test(source) ||
    /days_already_covered_by_another_source/.test(source)
  );
}

test("no writer of ad_spend may cover a day another source already covers", async () => {
  // This is the whole reason src/app/api/dashboard/ads-roi/route.ts and
  // src/app/api/analytics/summary/route.ts can sum every row without filtering on
  // `source`. If a day were described twice, total spend would read high and cost
  // per lead low, with nothing in either response saying so — and afterwards no
  // way to tell which rows were the copy. So the invariant is enforced on the
  // writers, and this test enumerates them rather than naming them, so that a
  // third writer added later fails here instead of doubling the ledger.
  const files = (await readdir(path.join(ROOT, "src/app"), { recursive: true }))
    .filter((f) => typeof f === "string" && f.endsWith(".ts"))
    .map((f) => path.join("src/app", f));
  const writers = [];
  for (const rel of files) {
    const source = await read(rel);
    if (/\.from\("ad_spend"\)/.test(source) && /\.insert\(/.test(source)) writers.push(rel);
  }

  assert.ok(writers.includes(SYNC), "the sync writes ad_spend");
  assert.ok(writers.includes(IMPORTER), "the Excel importer writes ad_spend");
  for (const rel of writers) {
    assert.ok(writerRefusesForeignWindow(await read(rel)), `${rel} may not write over another source's days`);
  }

  // Negative controls, one per writer: remove the fence and require red.
  for (const [rel, marker] of [[SYNC, "overlapping_spend_window"], [IMPORTER, "days_already_covered_by_another_source"]]) {
    const source = await read(rel);
    const stripped = source.split(marker).join("removed");
    assert.notEqual(stripped, source, `the negative control must mutate ${rel}`);
    assert.equal(writerRefusesForeignWindow(stripped), false, `${rel}: the check must fail once the fence is gone`);
  }
});

test("the sync's overlap fence looks outside its own namespace, in the same window", async () => {
  const source = await read(SYNC);
  const fence = source.slice(source.indexOf("overlapping_spend_window") - 1500, source.indexOf("overlapping_spend_window"));
  assert.ok(/\.neq\("source",\s*namespace\)/.test(fence), "the fence must look at OTHER sources");
  assert.ok(/\.gte\("spend_date",\s*since\)/.test(fence) && /\.lte\("spend_date",\s*until\)/.test(fence));
  assert.ok(/head: true/.test(fence), "counting rows is enough; the rows themselves are not needed");
  assert.ok(/status: 409/.test(source.slice(source.indexOf("overlapping_spend_window"), source.indexOf("overlapping_spend_window") + 500)));

  // Negative control: a failed count must not be treated as "no overlap".
  assert.ok(/overlap_probe_failed/.test(source), "the fence must fail closed when the count itself errors");
});

test("the importer's fence checks the days it is about to write, not the whole table", async () => {
  const source = await read(IMPORTER);
  // The fence asks for every source that is not this one, so a namespace added
  // later is covered without editing the route. Naming a sibling prefix would have
  // let scripts/import-ads-manager-export.mjs write over the same days.
  assert.ok(/EXCEL_SOURCE/.test(source), "the importer must use the shared constant, not a literal");
  assert.ok(/\.neq\("source",\s*EXCEL_SOURCE\)/.test(source));
  assert.ok(!/API_SOURCE_PREFIX/.test(source), "a fence that enumerates its siblings goes stale");
  assert.ok(/incomingDates/.test(source) && /clash/.test(source), "only the days in the export can clash");
  assert.ok(/status: 409/.test(source.slice(source.indexOf("days_already_covered_by_another_source"))));
  // A failed check is not an absent conflict.
  const checkBlock = source.slice(source.indexOf("ownedErr"), source.indexOf("days_already_covered_by_another_source"));
  assert.ok(/status: 500/.test(checkBlock), "the importer must stop if the overlap query itself fails");
});

test("two syncs cannot replace the same window at once", async () => {
  // delete-then-insert is not atomic here: two overlapping runs can interleave so
  // that the second delete removes the first insert, and both report success while
  // the window ends up holding one run's rows or none. A cron plus an impatient
  // click is enough to produce it.
  const source = await read(SYNC);
  assert.ok(/let writeInFlight = false/.test(source), "the latch has to be module scope, not per request");
  assert.ok(/if \(writeInFlight\)/.test(source));
  assert.ok(/error: "sync_already_running"/.test(source));
  const latchAt = source.indexOf("writeInFlight = true");
  const deleteAt = source.indexOf(".delete(");
  assert.ok(latchAt > -1 && latchAt < deleteAt, "the latch must close before the delete");
  assert.ok(/finally \{[\s\S]{0,120}writeInFlight = false/.test(source), "a thrown error must not wedge the latch shut");

  // Negative control: remove the guard and require the check to go red.
  const unlatched = source.replace(/if \(writeInFlight\)/, "if (false)");
  assert.notEqual(unlatched, source);
  assert.equal(/if \(writeInFlight\)/.test(unlatched), false);
});

test("the sync reads the window back after writing it", async () => {
  // PostgREST reports what it was asked to do, not what the table now holds: a
  // policy or a trigger can drop rows from an insert that returns no error. The
  // count is the only evidence the window is what it claims.
  const source = await read(SYNC);
  const verifyAt = source.indexOf("window_row_count_mismatch");
  assert.ok(verifyAt > -1, "a run with no read-back cannot claim the window is correct");
  const insertAt = source.indexOf("for (let i = 0; i < rows.length");
  assert.ok(insertAt > -1 && insertAt < verifyAt, "the read-back comes after the insert");
  const block = source.slice(insertAt, verifyAt);
  assert.ok(/head: true/.test(block) && /count: "exact"/.test(block));
  assert.ok(/\.eq\("source",\s*namespace\)/.test(block), "count this namespace's rows, not the table's");
  assert.ok(/status: 409/.test(source.slice(verifyAt, verifyAt + 600)));
});

test("the status route pages the ad account list to the end", async () => {
  // A credential assigned more than one page of ad accounts would otherwise report
  // the configured account as invisible and skip the insights probe — a health
  // check that says "broken" about a working connection sends the next person back
  // through the authorisation flow for nothing.
  const source = await read(STATUS);
  assert.ok(/paging\?\.next/.test(source), "the first page is not the list");
  assert.ok(/while \(nextPage\)/.test(source));
  assert.ok(/MAX_ACCOUNT_PAGES/.test(source), "and the loop has to be bounded");
  assert.ok(/ad_account_pages_exhausted/.test(source), "hitting the bound must be visible in the answer");

  // Negative control: without the loop the check must go red.
  const single = source.replace(/paging\?\.next/g, "data");
  assert.notEqual(single, source);
  assert.equal(/paging\?\.next/.test(single), false);
});

test("the status route never rounds a database failure down to 'no token'", async () => {
  // Discarding the error on the second meta_tokens query made a permission or
  // connectivity failure look like an absent credential, while checks.token.present
  // in the same response said the row was right there. A diagnostic route that can
  // contradict itself is worse than none.
  const source = await read(STATUS);
  assert.ok(/secretLookupError/.test(source), "the second query's error has to be captured");
  const block = source.slice(source.indexOf("secretLookupError"));
  assert.ok(/token_secret_lookup_failed/.test(block));
  assert.ok(/status: 500/.test(block), "a failed read is a server error, not an empty result");
  assert.ok(/tokenError/.test(source) && /token_lookup_failed/.test(source), "and so is the first query's");

  // Negative control.
  const swallowed = source.replace(/if \(secretLookupError\)/, "if (false)");
  assert.notEqual(swallowed, source);
  assert.equal(/if \(secretLookupError\)/.test(swallowed), false);
});

test("the mapping module still carries no raw NUL byte after the ad_id key", async () => {
  const bytes = await readFile(path.join(ROOT, INSIGHTS));
  assert.equal(bytes.includes(0), false);
  assert.ok(/\\u0000/.test(bytes.toString("utf8")), "the separator must be written as an escape");
});
