/**
 * Direct money reads detected in API route modules are held to one cache and cash-state posture.
 *
 * Round-4 finding R5. Two defects with one shape — a second, looser copy of a rule
 * the database owns:
 *
 *   the cache    five money-reading routes held their responses in
 *                src/lib/api-cache.mjs for 30 seconds. Its public API exposes no
 *                targeted invalidation, and `revalidatePath()` cannot reach module state,
 *                so after a payment was confirmed, voided or re-allocated the
 *                dashboard totals, the pipeline actuals, the analytics revenue and
 *                the contracts list's first-payment badges kept serving pre-write
 *                figures for the rest of the TTL — while /api/payments/list, which is
 *                force-dynamic, served the new ones. Two pages, two answers, one
 *                ledger. The contracts-list badge drives the Remind button, so a
 *                stale "unpaid" invites a dunning message about money already banked.
 *   the predicate the database's relevant derived totals count
 *                `confirmed = true and voided_at is null`. Seven routes counted
 *                `confirmed` alone, and dashboard/payment-tracker did not even SELECT
 *                voided_at, so its `collected`, `outstanding` and each rep's
 *                `collection_rate` counted reversed money as cash — reversing a
 *                payment raised a salesperson's collection rate.
 *
 * The gate derives a bounded static set instead of claiming to recognize every
 * possible program that can read money. It recognizes the literal query forms used
 * in this route tree: `.from("table")`, embedded `table(columns)`, and the two
 * money-bearing contract columns. A wrapper or dynamically computed table name is
 * outside that classifier and therefore outside the claim made by these tests.
 *
 * Source reading can prove "this route consults no cache" and "this route declares
 * force-dynamic" — those ARE textual facts about the module. It cannot prove the
 * staleness window is real, so the cache's own behaviour is EXECUTED below against
 * the module the routes import.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { MAX_CACHE_ENTRIES, cacheSize, getCached, setCache } from "../../src/lib/api-cache.mjs";
import { countsAsCash } from "../../src/lib/payment-state.mjs";

const API_DIR = "src/app/api";
const CACHE_MODULE = "src/lib/api-cache.mjs";
const HELPER_MODULE = "src/lib/request-auth-context.ts";

/**
 * The tables whose contents are money, or are recomputed from it.
 *
 * contracts is NOT in this list: a contract number and a party name are not money,
 * and half the application reads them. `first_payment_status` and `contract_amount`
 * are the two columns on that table that are, and they are matched by name below.
 */
const MONEY_TABLES = ["payments", "payment_allocations", "installment_plans", "kpi_targets"];
const MONEY_COLUMNS = ["first_payment_status", "contract_amount"];

const read = (file) => fs.readFileSync(file, "utf8");

/**
 * Comments stripped.
 *
 * Several files in this finding document the defect they fix by quoting it — the
 * routes name `api-cache`, `p.confirmed` and `NO_STORE` in their headers. A check
 * that read the whole file would match its own explanation and report a fixed route
 * as broken; the first draft of the R5 census did exactly that and named five
 * compliant routes.
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every route module under src/app/api, as repo-relative POSIX paths. */
function routeFiles(dir = API_DIR, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(child, found);
    else if (entry.name === "route.ts") found.push(child);
  }
  return found.sort();
}

/**
 * Which money tables a route reads, direct and embedded.
 *
 * `from("payments")` is the obvious form. `payments(id, amount, …)` inside a select
 * string is the one that hid dashboard/payment-tracker, and it is not a weaker
 * signal: an embed returns the same rows through the same policies.
 */
function moneyReads(src) {
  const hits = new Set();
  for (const table of MONEY_TABLES) {
    if (new RegExp(`from\\(\\s*["'\`]${table}["'\`]\\s*\\)`).test(src)) hits.add(table);
    // An embed is a table name immediately followed by its column list, inside a
    // select argument. Requiring the paren rules out prose and identifiers.
    if (new RegExp(`[\\s,\`"'(]${table}\\s*\\(`).test(src)) hits.add(table);
  }
  for (const column of MONEY_COLUMNS) {
    if (src.includes(column)) hits.add(column);
  }
  return [...hits];
}

/** The HTTP methods a route module exports. */
function methods(src) {
  return [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE|HEAD)\b/g)].map((m) => m[1]);
}

const ROUTES = routeFiles().map((file) => {
  const source = code(read(file));
  return { file, source, tables: moneyReads(source), methods: methods(source) };
});
const MONEY_ROUTES = ROUTES.filter((route) => route.tables.length > 0);

/**
 * The money routes a cache can actually hold.
 *
 * A cache — the browser's, a proxy's, or Next's — stores responses to safe methods.
 * `export const dynamic` decides prerendering, which only a GET is subject to. So the
 * POST-only money routes (the settlement writers, the reminder, the notifier) are
 * held to the no-module-cache and one-predicate rules below but not to the response
 * posture: requiring a no-store header on a POST response would be a rule that
 * cannot be violated, and a gate whose assertions cannot fail is a gate that reports
 * green for the wrong reason.
 */
const MONEY_READS = MONEY_ROUTES.filter(
  (route) => route.methods.includes("GET") || route.methods.includes("HEAD"),
);

// ── The set itself ────────────────────────────────────────────────────────────

test("the static classifier recognizes each documented literal query form in the current route tree", () => {
  // Four anchors, one per detection form, so a regex that silently stops matching is
  // a failure here rather than a shrinking set nobody notices.
  const byFile = new Map(MONEY_ROUTES.map((route) => [route.file, route]));
  assert.ok(byFile.has("src/app/api/payments/list/route.ts"), 'from("payments") is no longer detected');
  assert.ok(
    byFile.get("src/app/api/dashboard/payment-tracker/route.ts")?.tables.includes("payments"),
    "the embedded `payments(...)` form is no longer detected — this is the route that hid behind it",
  );
  assert.ok(byFile.has("src/app/api/kpi/targets/route.ts"), "kpi_targets is no longer detected");
  assert.ok(
    byFile.get("src/app/api/contracts/list/route.ts")?.tables.includes("first_payment_status"),
    "the first_payment_status column is no longer detected",
  );
  assert.ok(
    byFile.get("src/app/api/dashboard/summary/route.ts")?.tables.includes("contract_amount"),
    "the contract_amount column is no longer detected",
  );
});

test("the classifier boundary is explicit rather than a claim over arbitrary wrappers", () => {
  assert.deepEqual(moneyReads('client.from("payments").select("id")'), ["payments"]);
  assert.deepEqual(moneyReads('client.from("contracts").select("payments(id, amount)")'), ["payments"]);
  assert.deepEqual(moneyReads('client.from("contracts").select("id, contract_amount")'), ["contract_amount"]);
  assert.deepEqual(moneyReads("moneyRepository.readCurrentLedger()"), []);
});

// ── No money read is cached, at any layer ─────────────────────────────────────

test("no route in the statically detected money set imports the module cache", () => {
  // Import-shaped, not a bare substring: the routes explain in their headers WHY they
  // no longer use api-cache, and a substring match reads that explanation as a use.
  const importsCache = /^\s*import\b[^\n]*from\s+["'][^"']*\bapi-cache(\.mjs)?["']/m;
  for (const route of MONEY_ROUTES) {
    assert.doesNotMatch(
      route.source,
      importsCache,
      `${route.file} reads ${route.tables.join(", ")} and imports ${CACHE_MODULE}, which has no eviction path`,
    );
    // The import is the reachable path, but a route could also be handed the
    // functions; neither call belongs in a money read.
    assert.doesNotMatch(route.source, /\bgetCached\s*\(/, `${route.file} consults the module cache`);
    assert.doesNotMatch(route.source, /\bsetCache\s*\(/, `${route.file} writes to the module cache`);
  }
});

test("each detected money GET or HEAD is force-dynamic and declares no revalidation window", () => {
  for (const route of MONEY_READS) {
    assert.match(
      route.source,
      /export const dynamic = "force-dynamic"/,
      `${route.file} reads ${route.tables.join(", ")} without declaring force-dynamic`,
    );
    assert.doesNotMatch(route.source, /force-static/, `${route.file} is a money read declared force-static`);
    // `export const revalidate = 30` is the framework's own version of the same
    // 30-second staleness window this finding removed.
    assert.doesNotMatch(
      route.source,
      /export const revalidate\s*=/,
      `${route.file} is a money read with a revalidation window`,
    );
  }
});

test("each detected money GET or HEAD answers through the one no-store helper", () => {
  const helper = read(HELPER_MODULE);
  // The helper is the thing being relied on, so what it sends is asserted here
  // rather than assumed: no-store for the browser and any proxy, and Vary on the
  // credentials, because these responses are role- and user-scoped.
  assert.match(helper, /Cache-Control["']?\s*,\s*PRIVATE_NO_STORE|PRIVATE_NO_STORE/);
  assert.match(helper, /private, no-store, max-age=0, must-revalidate/);
  assert.match(helper, /Vary["']\s*,\s*["']Cookie, Authorization/);
  assert.match(helper, /export function applyPrivateNoStore/);

  for (const route of MONEY_READS) {
    assert.match(
      route.source,
      /^\s*import\s+\{[^}]*\bapplyPrivateNoStore\b[^}]*\}\s+from\s+["']@\/lib\/request-auth-context["']/m,
      `${route.file} reads ${route.tables.join(", ")} but does not import applyPrivateNoStore`,
    );
    assert.match(route.source, /applyPrivateNoStore\(/, `${route.file} imports the helper and never calls it`);
    // Six of these routes carried their own `const NO_STORE = { … }`, which is how
    // the Vary header came to be missing from role-scoped money responses: each copy
    // was a chance to write a shorter one. There is one spelling now.
    assert.doesNotMatch(
      route.source,
      /const (NO_STORE|PRIVATE_NO_STORE|NOSTORE)\s*[:=]/,
      `${route.file} declares a second, local no-store header instead of using the helper`,
    );
  }
});

// ── One predicate for cash ────────────────────────────────────────────────────

test("each detected literal payment reader avoids a confirmed-only cash decision", () => {
  const readers = MONEY_ROUTES.filter((route) => route.tables.includes("payments"));
  for (const route of readers) {
    const usesModel = /\bcountsAsCash\s*\(/.test(route.source);
    // The SQL pair: the predicate applied where the set is chosen. Both halves, in
    // either order.
    const sqlPair =
      /\.eq\(\s*["']confirmed["']\s*,\s*true\s*\)/.test(route.source) &&
      /\.is\(\s*["']voided_at["']\s*,\s*null\s*\)/.test(route.source);
    // A route may legitimately do neither — the contract detail route returns every
    // payment in all three states, which is the point of a detail view. What it may
    // not do is decide, in JavaScript, that a row is cash by looking at `confirmed`
    // and nothing else.
    const testsConfirmed =
      /\bif\s*\(\s*!?\s*\w+\.confirmed\s*\)/.test(route.source) ||
      /\bfilter\((?:\(\s*)?\w+(?:\s*:\s*any\s*)?\)?\s*=>\s*!?\s*\w+\.confirmed\b/.test(route.source) ||
      /\?\s*\w+\.confirmed\s*[:&|]/.test(route.source);

    // Reading `confirmed` is not itself the defect — the database's own routines read
    // it, and so must the settlement prechecks, which have to distinguish "already
    // confirmed" from "not yet confirmed" after they have ruled the reversal out. The
    // defect is reading it as the WHOLE state, with no column that can see a reversal.
    // So the rule is: a route that decides anything from `confirmed` must also consult
    // the reversal through the shared model. Which of the two it must test first is a
    // separate assertion, below, because ordering is what decides the answer a
    // contradictory row gets.
    const testsReversal = /\bisVoided\s*\(|\bcountsAsCash\s*\(|\bpaymentState\s*\(/.test(route.source);

    assert.ok(
      !testsConfirmed || testsReversal,
      `${route.file} decides a payment's state from \`confirmed\` alone; void_payment() clears that flag, so ` +
        "a reversed payment written by a compat-mode direct write counts here and not in the ledger",
    );
    if (testsReversal) {
      assert.match(
        route.source,
        /from ["']@\/lib\/payment-state\.mjs["']/,
        `${route.file} spells the reversal test itself instead of importing the shared model`,
      );
    }

    // And a route that DOES aggregate has to say which rule it used.
    const aggregates = /\breduce\(|\+=\s*\w+\.amount|collected\s*\+=/.test(route.source);
    if (aggregates) {
      assert.ok(
        usesModel || sqlPair,
        `${route.file} totals payment amounts without either countsAsCash() or the SQL pair ` +
          '`.eq("confirmed", true).is("voided_at", null)`',
      );
    }
  }
});

test("a detected route that filters payments in JavaScript must have selected the void column", () => {
  // dashboard/payment-tracker's embed was `payments(id, amount, confirmed,
  // payment_date)`. No JavaScript could have been right: the column that records the
  // reversal never left the database.
  for (const route of MONEY_ROUTES.filter((r) => r.tables.includes("payments"))) {
    if (!/\bcountsAsCash\s*\(/.test(route.source)) continue;
    assert.match(
      route.source,
      /voided_at/,
      `${route.file} calls countsAsCash() on rows selected without voided_at, so the predicate always says "not voided"`,
    );
  }
});

test("the settlement prechecks name the reversal instead of asking for a confirmation", () => {
  // The route and the server action both pre-check the row before calling the
  // routine, and both selected `confirmed` alone. For a voided payment that produced
  // "Payment must be confirmed before allocation" — literally true, because
  // void_payment() clears the flag, and a loop with no exit: confirm_payment()
  // answers the confirmation with 'a voided payment cannot be confirmed'.
  const prechecks = [
    ["src/app/api/payments/[id]/confirm/route.ts", "a voided payment cannot be confirmed"],
    ["src/app/api/payments/[id]/allocate/route.ts", "a voided payment cannot be allocated"],
  ];
  for (const [file, message] of prechecks) {
    const src = code(read(file));
    assert.match(src, /\.select\(["'][^"']*voided_at[^"']*["']\)/, `${file} cannot see a reversal`);
    assert.match(src, /isVoided\(payment\)/, `${file} does not use the shared model`);
    assert.ok(src.includes(message), `${file} does not report the reversal as "${message}"`);
    // Voided is tested first: a row carrying both voided_at and confirmed = true is
    // reversed money, not confirmed money.
    assert.ok(
      src.indexOf("isVoided(payment)") < src.indexOf("payment.confirmed"),
      `${file} tests \`confirmed\` before the reversal, so a contradictory row reports the wrong state`,
    );
  }

  const actions = code(read("src/app/actions/payments.ts"));
  assert.match(actions, /from '@\/lib\/payment-state\.mjs'/);
  for (const message of ["a voided payment cannot be confirmed", "a voided payment cannot be allocated"]) {
    assert.ok(actions.includes(message), `src/app/actions/payments.ts does not report "${message}"`);
  }
  assert.match(actions, /\.select\('id, confirmed, voided_at'\)/);
  assert.match(actions, /\.select\('id, confirmed, voided_at, contract_id'\)/);
});

// ── The cache's own behaviour, executed ───────────────────────────────────────

test("a cached value survives the write that should have invalidated it", () => {
  // The staleness window, measured rather than asserted from the module header. This
  // is what a money route consulting this Map does to a confirmed payment.
  const key = "test:api-cache-money-boundary:stale";
  setCache(key, { collected: 1000 }, 30);
  // The write happens in the system of record; this in-memory entry does not observe it.
  const afterWrite = { collected: 1700 };
  assert.deepEqual(
    getCached(key),
    { collected: 1000 },
    "the cache returned the new figure, so this test no longer measures the window it exists to measure",
  );
  assert.notDeepEqual(getCached(key), afterWrite);
});

test("the public cache API exposes no targeted invalidation operation", async () => {
  const cacheModule = await import("../../src/lib/api-cache.mjs");
  assert.deepEqual(
    Object.keys(cacheModule).sort(),
    ["MAX_CACHE_ENTRIES", "cacheSize", "getCached", "setCache"],
    "the export surface changed; an eviction export would change what the money routes may do",
  );
  for (const name of ["evict", "invalidate", "clear", "del", "delete", "flush", "purge", "reset"]) {
    assert.equal(cacheModule[name], undefined, `api-cache exports ${name}()`);
  }
  // And no route reaches around the exports.
  const source = read(CACHE_MODULE);
  assert.match(source, /const store = new Map\(\)/);
  assert.doesNotMatch(source, /export (const|let|var) store\b/, "the Map itself is exported, so a route could evict");
});

test("an expired entry is gone on the next read, and the count is observable", () => {
  const key = "test:api-cache-money-boundary:expiry";
  const before = cacheSize();
  // A negative TTL is an entry already past its expiry: the getter's own branch, not
  // a timer this test has to wait for.
  setCache(key, { stale: true }, -1);
  assert.equal(cacheSize(), before + 1, "cacheSize() no longer counts what setCache() stored");
  assert.equal(getCached(key), null, "an expired entry was served");
  assert.equal(cacheSize(), before, "reading an expired entry did not drop it");
});

test("the observed insertion sequence evicts its oldest key at the fixed capacity", () => {
  const oldest = "test:api-cache-cap:oldest";
  setCache(oldest, { value: 0 }, 60);
  for (let i = 1; i <= MAX_CACHE_ENTRIES; i += 1) {
    setCache(`test:api-cache-cap:${i}`, { value: i }, 60);
  }
  assert.equal(cacheSize(), MAX_CACHE_ENTRIES);
  assert.equal(getCached(oldest), null, "the oldest entry survived capacity eviction");
  assert.deepEqual(getCached(`test:api-cache-cap:${MAX_CACHE_ENTRIES}`), { value: MAX_CACHE_ENTRIES });
});

test("the shared cash predicate is void-aware when callers include the void column", () => {
  // The shared function used by the detected JavaScript-side money totals, executed here
  // so the assertions above about *which* rule a route uses are anchored to a rule
  // that is actually right.
  assert.equal(countsAsCash({ confirmed: true, voided_at: null }), true);
  assert.equal(countsAsCash({ confirmed: false, voided_at: null }), false);
  assert.equal(countsAsCash({ confirmed: false, voided_at: "2026-08-13T00:00:00Z" }), false);
  // The compat-mode row: `update payments set confirmed = true` on a voided payment
  // is still a permitted direct write while the release is in compat mode.
  assert.equal(
    countsAsCash({ confirmed: true, voided_at: "2026-08-13T00:00:00Z" }),
    false,
    "a voided-then-confirmed row counts as cash, which is the divergence from the ledger this finding is about",
  );
  // And the column has to be present: an absent voided_at is not proof of no reversal.
  assert.equal(countsAsCash({ confirmed: true }), true, "the model's contract is that the caller selected voided_at");
});
