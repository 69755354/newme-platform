/**
 * Recording a payment is idempotent, and there is one boundary that decides it.
 *
 * Round-4 finding B3. The payments dashboard called a `createPayment` server
 * action that inserted into `payments` directly with no idempotency key, so the
 * same form submitted twice recorded two payments. Reproduced on an isolated
 * PostgreSQL 17 against this branch's migrations, acting as the sales identity
 * that owns the fixture contract:
 *
 *   compat  the insert with no request_key            sqlstate=00000 rows=1
 *   compat  the same form submitted twice             sqlstate=00000 rows=2   <- two payments, one intent
 *   strict  the insert with no request_key            sqlstate=22023 rows=0   "a payment must carry request_key"
 *   both    the same payload twice under ONE key      23505 idx_payments_request_key, rows=1
 *   both    a DIFFERENT amount under that same key    23505 idx_payments_request_key, stored amount unchanged
 *
 * The last two lines are why this file exists in the shape it does. The unique
 * index raises one sqlstate for both an honest retry and a key reused for a
 * different payment, so the distinction is drawn in application code — and code
 * that draws it wrongly still spells every keyword a source-reading test would
 * look for. So the deciding functions are executed here, not grepped, and only
 * the wiring around them is asserted from source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  PAYMENT_METHODS,
  PAYMENT_PAGE_ROLES,
  PAYMENT_RECORDING_ROLES,
  PAYMENT_UI_METHODS,
  canRecordPayment,
  isRequestKeyConflict,
  paymentAmountMinorUnits,
  paymentIntentsMatch,
  readIdempotencyKey,
  recordPaymentWithKey,
  resolveSpentKey,
  validatePaymentRecordInput,
} from "../../src/lib/payment-idempotency.mjs";

const ROUTE = "src/app/api/payments/route.ts";
const LIST_ROUTE = "src/app/api/payments/list/route.ts";
const PAGE = "src/app/(dashboard)/payments/page.tsx";
const ACTIONS = "src/app/actions/payments.ts";
const WRITER = "src/lib/payment-idempotency.mjs";
const MIGRATION = "supabase/migrations/20260813100000_payment_request_key_idempotency.sql";
const PAYMENT_SCHEMA = "supabase/migrations/20260605000000_newme_crm_v22_complete.sql";

const read = (file) => fs.readFileSync(file, "utf8");

/**
 * Comments stripped, so an explanatory comment quoting the removed insert cannot
 * satisfy — or trip — a check about the code. The B1 boundary test learned this
 * the hard way: its own comment quoting the deleted call failed the assertion
 * that the call was gone.
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The body of a named function declaration, by brace matching. */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/**
 * The detector: every place a `payments` row is inserted through the Supabase
 * client. Takes the window after each `.from("payments")` and reports the ones
 * that reach an `.insert(`.
 */
export function paymentInserts(src) {
  const hits = [];
  const from = /\.from\(\s*['"]payments['"]\s*\)/g;
  let match;
  while ((match = from.exec(src)) !== null) {
    const window = src.slice(match.index, match.index + 400);
    if (/\.insert\(/.test(window)) hits.push(window.slice(0, 80));
  }
  return hits;
}

function sourceFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(full));
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// ── The detector, against the shape that was removed ─────────────────────────

test("the detector flags the exact insert the removed server action performed", () => {
  const removed = `
    const { data: payment, error: insertErr } = await supabase
      .from('payments')
      .insert({
        contract_id: data.contract_id,
        created_by: user.id,
        amount: data.amount,
        payment_date: data.payment_date,
        payment_method: data.payment_method,
        reference_no: data.reference_no || null,
        confirmed: false,
        notes: data.notes || null,
      })
      .select('id, amount')
      .single()
  `;
  assert.equal(paymentInserts(removed).length, 1);
});

test("the detector does not flag legitimate neighbours", () => {
  const neighbours = [
    `await supabase.from("payments").select("id, amount").eq("id", paymentId).single();`,
    `await supabase.from("payments").update({ notes }).eq("id", paymentId);`,
    `await supabase.from("installment_plans").insert({ contract_id, seq: 1, amount });`,
    `await supabase.rpc("confirm_payment", { p_payment_id: id, p_confirmer_id: user.id });`,
    `const rows = await supabase.from("payments").select("*").order("created_at");`,
  ];
  for (const src of neighbours) {
    assert.deepEqual(paymentInserts(src), [], `false positive on: ${src}`);
  }
});

// ── Who inserts payments ─────────────────────────────────────────────────────

test("the route delegates to the only payment insert implementation under src/", () => {
  const offenders = sourceFilesUnder("src")
    .filter((file) => file !== WRITER)
    .filter((file) => paymentInserts(code(read(file))).length > 0);
  assert.deepEqual(offenders, [], `payments inserted outside ${WRITER}`);
  assert.equal(paymentInserts(code(read(WRITER))).length, 1);
  assert.match(code(read(ROUTE)), /recordPaymentWithKey\(\{/);
});

test("createPayment is gone, not merely unused", () => {
  for (const file of [ACTIONS, PAGE]) {
    assert.doesNotMatch(code(read(file)), /\bcreatePayment\b/, `${file} still references createPayment`);
  }
  const actions = code(read(ACTIONS));
  assert.match(actions, /export async function confirmPayment/);
  assert.match(actions, /export async function allocatePayment/);
});

// ── The real UI caller ───────────────────────────────────────────────────────

test("the dashboard mints one key per intent, when the dialog opens", () => {
  const page = code(read(PAGE));
  assert.match(functionBody(page, "openRecordDialog"), /setRecRequestKey\(crypto\.randomUUID\(\)\)/);
});

test("the dashboard does not mint a key per attempt", () => {
  const submit = functionBody(code(read(PAGE)), "handleRecordPayment");
  assert.doesNotMatch(
    submit,
    /randomUUID/,
    "a key minted per submit is a new key on every retry, which records a second payment",
  );
  assert.match(submit, /idempotencyKey: recRequestKey/);
});

test("the dashboard posts to the canonical route and surfaces its refusal", () => {
  const submit = functionBody(code(read(PAGE)), "handleRecordPayment");
  assert.match(submit, /fetch\("\/api\/payments",\s*\{/);
  assert.match(submit, /method: "POST"/);
  assert.match(submit, /if \(!res\.ok\)/);
  assert.match(submit, /err\.error \|\| t\("payments\.recordFailed"\)/);
});

// ── Validation, executed ─────────────────────────────────────────────────────

const KEY = "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1";

test("a key is read from the body or the header, and nothing else is accepted", () => {
  assert.equal(readIdempotencyKey({ body: { idempotencyKey: KEY } }), KEY);
  assert.equal(readIdempotencyKey({ body: {}, headerValue: KEY }), KEY);
  assert.equal(readIdempotencyKey({ body: { idempotencyKey: ` ${KEY} ` } }), KEY);
  assert.equal(
    readIdempotencyKey({ body: { idempotencyKey: KEY.toUpperCase() }, headerValue: KEY }),
    KEY,
  );
  assert.equal(
    readIdempotencyKey({
      body: { idempotencyKey: KEY },
      headerValue: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }),
    null,
  );

  for (const bad of [
    { body: {} },
    { body: null, headerValue: null },
    { body: { idempotencyKey: "" } },
    { body: { idempotencyKey: "   " } },
    { body: { idempotencyKey: "not-a-uuid" } },
    { body: { idempotencyKey: KEY.slice(0, -1) } },
    { body: { idempotencyKey: 12345 } },
    { body: { idempotencyKey: { toString: () => KEY } } },
    { headerValue: "00000000-0000-0000-0000-000000000000" },
  ]) {
    assert.equal(readIdempotencyKey(bad), null, `accepted: ${JSON.stringify(bad)}`);
  }
});

// ── Exact retry versus reused key, executed ──────────────────────────────────

const STORED = {
  contract_id: "c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3",
  amount: 4321,
  payment_date: "2026-08-13",
  payment_method: "bank_transfer",
  reference_no: null,
  notes: null,
};

test("an exact retry is recognised as the payment already recorded", () => {
  assert.equal(paymentIntentsMatch(STORED, { ...STORED }), true);
  // The database returns a timestamped date and numeric amounts; neither is a
  // difference in what the caller asked for.
  assert.equal(paymentIntentsMatch({ ...STORED, payment_date: "2026-08-13T00:00:00" }, STORED), true);
  assert.equal(paymentIntentsMatch({ ...STORED, amount: "4321.00" }, STORED), true);
  // The route stores `reference_no || null`, so an empty string and null are the
  // same request. Comparing them as different would refuse honest retries.
  assert.equal(paymentIntentsMatch({ ...STORED, reference_no: "" }, STORED), true);
  assert.equal(paymentIntentsMatch({ ...STORED, notes: undefined }, STORED), true);
});

test("any change to what is being recorded is not the same payment", () => {
  const changes = [
    { amount: 99999 },
    { amount: 4321.01 },
    { contract_id: "c9c9c9c9-c9c9-c9c9-c9c9-c9c9c9c9c9c9" },
    { payment_date: "2026-08-14" },
    { payment_method: "cash" },
    { reference_no: "TT-2026-0001" },
    { notes: "second tranche" },
  ];
  for (const change of changes) {
    assert.equal(
      paymentIntentsMatch({ ...STORED, ...change }, STORED),
      false,
      `treated as the same payment: ${JSON.stringify(change)}`,
    );
  }
});

test("an amount that is not a finite number never compares equal", () => {
  for (const amount of [null, undefined, "", "abc", NaN, Infinity]) {
    assert.equal(paymentIntentsMatch({ ...STORED, amount }, STORED), false);
    assert.equal(paymentIntentsMatch(STORED, { ...STORED, amount }), false);
  }
});

test("amounts use an exact two-decimal contract before PostgreSQL can round them", () => {
  assert.equal(paymentAmountMinorUnits("4321.00"), 432100);
  assert.equal(paymentAmountMinorUnits(0.3), 30);
  assert.equal(paymentAmountMinorUnits(0.1 + 0.2), 30);
  assert.equal(paymentIntentsMatch({ ...STORED, amount: "4321.00" }, STORED), true);
  assert.equal(paymentIntentsMatch({ ...STORED, amount: 0.3 }, { ...STORED, amount: 0.31 }), false);
  for (const invalid of [1.005, "1.005", 0, -1, "10000000000.00"]) {
    assert.equal(paymentAmountMinorUnits(invalid), null, `accepted ${invalid}`);
  }
});

test("request validation rejects database rounding and unsupported payment methods", () => {
  const base = {
    contract_id: STORED.contract_id,
    amount: 1.01,
    payment_date: STORED.payment_date,
    payment_method: "bank_transfer",
  };
  assert.deepEqual(validatePaymentRecordInput(base), {
    ok: true,
    intent: { ...base, reference_no: null, notes: null },
  });
  for (const amount of [1.005, "1.005", 0, -1]) {
    assert.equal(validatePaymentRecordInput({ ...base, amount }).ok, false);
  }
  for (const payment_method of ["check", "online", "wire", ""]) {
    assert.equal(validatePaymentRecordInput({ ...base, payment_method }).ok, false);
  }
  for (const invalid of [
    { payment_date: "2026-02-30" },
    { reference_no: 123 },
    { notes: { text: "not text" } },
  ]) {
    assert.equal(validatePaymentRecordInput({ ...base, ...invalid }).ok, false);
  }
});

test("every method offered by the UI is a value the API and database accept", () => {
  const schema = read(PAYMENT_SCHEMA);
  const check = /payment_method\s+text\s+check\s*\(payment_method\s+in\s*\(([^)]*)\)\)/i.exec(schema);
  assert.ok(check, "payments_payment_method_check is missing from the schema migration");
  const databaseMethods = [...check[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(PAYMENT_METHODS, databaseMethods);
  assert.deepEqual(PAYMENT_UI_METHODS, PAYMENT_METHODS);
  assert.equal(PAYMENT_UI_METHODS.every((method) => PAYMENT_METHODS.includes(method)), true);
  const page = code(read(PAGE));
  assert.match(page, /PAYMENT_UI_METHODS\.map\(/);
  assert.doesNotMatch(page, /value=["'](?:check|online)["']/);
});

test("a spent key returns the stored payment, refuses a different one, and stays quiet about one it cannot read", () => {
  assert.deepEqual(resolveSpentKey({ stored: STORED, requested: { ...STORED } }), {
    outcome: "replay",
    status: 200,
    code: null,
  });
  assert.deepEqual(resolveSpentKey({ stored: STORED, requested: { ...STORED, amount: 99999 } }), {
    outcome: "mismatch",
    status: 409,
    code: "IDEMPOTENCY_KEY_REUSED",
  });
  assert.deepEqual(resolveSpentKey({ stored: null, requested: { ...STORED } }), {
    outcome: "opaque",
    status: 409,
    code: "DUPLICATE_REQUEST",
  });
});

test("only the request-key conflict is treated as a spent key", () => {
  assert.equal(
    isRequestKeyConflict({
      code: "23505",
      message: 'duplicate key value violates unique constraint "idx_payments_request_key"',
    }),
    true,
  );
  assert.equal(isRequestKeyConflict({ code: "23505", constraint: "idx_payments_request_key" }), true);
  // A different unique conflict is a real error. Answering it with "already
  // recorded, here is your payment" would hand back an unrelated row.
  assert.equal(
    isRequestKeyConflict({
      code: "23505",
      message: 'duplicate key value violates unique constraint "payments_reference_no_key"',
    }),
    false,
  );
  assert.equal(isRequestKeyConflict({ code: "22023", message: "a payment must carry request_key" }), false);
  assert.equal(isRequestKeyConflict(null), false);
});

// ── Authorized and denied, executed ──────────────────────────────────────────

test("the recording roles may record against any contract", () => {
  for (const role of PAYMENT_RECORDING_ROLES) {
    assert.equal(
      canRecordPayment({ role, contractSalesId: "someone-else", userId: "me" }),
      true,
      `${role} refused`,
    );
  }
});

test("everyone else may record only against a contract they own", () => {
  assert.equal(canRecordPayment({ role: "sales", contractSalesId: "me", userId: "me" }), true);
  assert.equal(canRecordPayment({ role: "sales", contractSalesId: "someone-else", userId: "me" }), false);
});

test("no role is no recording", () => {
  for (const role of [null, undefined, ""]) {
    assert.equal(canRecordPayment({ role, contractSalesId: "me", userId: "me" }), false);
  }
  // A null contract owner must not match a null session identity into a pass.
  assert.equal(canRecordPayment({ role: "sales", contractSalesId: null, userId: null }), false);
});

test("recording is not settling", () => {
  // confirm_payment() and allocate_payment() are admin/boss/finance; operator
  // records but does not settle. Round-3 finding P1-9 was these two lists drifting.
  assert.equal(canRecordPayment({ role: "operator", contractSalesId: "x", userId: "me" }), true);
  assert.doesNotMatch(code(read(ACTIONS)), /allowedRoles = \[[^\]]*operator/);
});

test("the dashboard admits every recording role plus sales, while settlement stays narrower", () => {
  assert.deepEqual(PAYMENT_PAGE_ROLES, ["admin", "boss", "finance", "operator", "sales"]);
  const page = code(read(PAGE));
  assert.match(page, /useRequireRole\(\[\.\.\.PAYMENT_PAGE_ROLES\]\)/);
  assert.match(page, /const SETTLEMENT_ROLES = \["admin", "boss", "finance"\]/);
});

// ── The route is wired to the functions that were just exercised ─────────────

test("the route executes validation and the tested insert/read-back protocol", () => {
  const route = code(read(ROUTE));
  const writer = code(read(WRITER));
  assert.match(route, /validatePaymentRecordInput\(body\)/);
  assert.match(route, /recordPaymentWithKey\(\{/);
  assert.match(route, /canRecordPayment\(\{/);
  assert.match(route, /readIdempotencyKey\(\{/);
  assert.match(writer, /isRequestKeyConflict\(insertError\)/);
  assert.match(writer, /resolveSpentKey\(\{ stored: existing, requested: intent \}\)/);
  const lookup = writer.slice(writer.indexOf("isRequestKeyConflict(insertError)"));
  for (const column of ["contract_id", "payment_date", "payment_method", "reference_no", "notes"]) {
    assert.match(lookup, new RegExp(`select\\("[^"]*${column}`), `read-back omits ${column}`);
  }
  assert.match(writer, /request_key: requestKey/);
});

test("the dashboard list is read-after-write safe because it does not cache money rows", () => {
  const listRoute = code(read(LIST_ROUTE));
  assert.doesNotMatch(listRoute, /getCached|setCache|api-cache/);
});

// ── The schema the route relies on ───────────────────────────────────────────

test("the migration adds the key and the index that makes a resubmission collide", () => {
  const sql = read(MIGRATION);
  assert.match(sql, /add column if not exists request_key uuid/i);
  assert.match(sql, /create unique index idx_payments_request_key\s*\n?\s*on public\.payments \(created_by, request_key\)/i);
  assert.match(sql, /where request_key is not null/i);
  // Scoped to the creator: a key minted by one client must not be able to
  // collide with, or probe for, another user's payment.
  assert.doesNotMatch(sql, /create unique index[^;]*\(request_key\)/i);
  // Re-applied by the replay harness, so it has to converge rather than fail.
  assert.match(sql, /drop index if exists public\.idx_payments_request_key/i);
  // Rollback coverage is declared, which scripts/replay-migrations.sh gates on.
  assert.match(sql, /^--\s*NO_ROLLBACK:\s*\S/m);
});

test("the migration redefines no routine", () => {
  // The round-4 payment guard is not in this file. A `create or replace function`
  // here would be a partial copy of a routine defined elsewhere on this branch and
  // would silently revert whichever half it did not carry.
  assert.doesNotMatch(read(MIGRATION), /create\s+or\s+replace\s+function/i);
  // Nor does it require the column of every writer. `set not null` would fail
  // against any payment already recorded without a key; that tightening belongs
  // with the round-4 guard, which is a separate change. (`is not null` in the
  // index predicate is a different thing and has to stay.)
  assert.doesNotMatch(read(MIGRATION), /alter column[^;]*set\s+not\s+null/i);
  assert.doesNotMatch(read(MIGRATION), /add column[^;]*\bnot\s+null/i);
});
