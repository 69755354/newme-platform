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
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  META_API_SOURCE,
  chooseTokenSource,
  classifyGraphError,
  defaultWindow,
  describeToken,
  insightsUrl,
  isIsoDate,
  mapInsights,
  naturalKey,
  normaliseAccountId,
  windowFromRequest,
} from "../../src/lib/meta-ads-insights.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SYNC = "src/app/api/meta/ads-sync/route.ts";
const STATUS = "src/app/api/meta/ads-status/route.ts";

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
  const { rows } = mapInsights([
    { date_start: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Ad1", spend: "12.34", impressions: "1000", clicks: "7", account_currency: "AED" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, META_API_SOURCE);
  assert.equal(rows[0].amount, 12.34);
  assert.equal(rows[0].impressions, 1000);
  assert.equal(rows[0].clicks, 7);
  assert.equal(rows[0].currency, "AED");
  assert.equal(rows[0].spend_date, "2026-09-01");
});

test("a repeated ad-day is collapsed, never summed", () => {
  const { rows, duplicates } = mapInsights([
    { date_start: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Ad1", spend: "10" },
    { date_start: "2026-09-01", campaign_name: "C", adset_name: "A", ad_name: "Ad1", spend: "11" },
  ]);
  assert.equal(rows.length, 1, "one ad on one day is one row");
  assert.equal(duplicates, 1);
  assert.equal(rows[0].amount, 11, "last page wins; 21 would be invented spend");
});

test("an unmappable row is reported, not dropped quietly", () => {
  const { rows, rejected } = mapInsights([
    { date_start: "2026-09-01", ad_name: "good", spend: "5" },
    { date_start: "not-a-date", ad_name: "bad date", spend: "5" },
    { date_start: "2026-09-02", ad_name: "no spend" },
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
    { date_start: "2026-09-01", campaign_name: "A B", adset_name: "C", ad_name: "Ad1", spend: "10" },
    { date_start: "2026-09-01", campaign_name: "A", adset_name: "B C", ad_name: "Ad1", spend: "20" },
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
    /\.eq\("source",\s*META_API_SOURCE\)/.test(tail) &&
    /\.gte\("spend_date",\s*since\)/.test(tail) &&
    /\.lte\("spend_date",\s*until\)/.test(tail)
  );
}

test("the sync only ever clears rows it wrote itself", async () => {
  const source = await read(SYNC);
  assert.ok(deleteIsFenced(source), "delete must be scoped to source='meta_api' and to the window");

  // Negative control: drop the namespace fence and the check must go red, or it
  // was never looking. Without this fence the sync would delete the manually
  // imported Excel spend (source='meta') for the same dates.
  const unfenced = source.replace(/\.eq\("source",\s*META_API_SOURCE\)\s*\n/, "\n");
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
  /^\s*const credential = /, // choosing between the two sources
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
