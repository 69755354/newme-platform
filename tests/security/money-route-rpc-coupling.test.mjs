/**
 * The money routes and the definer routines they now call.
 *
 * 20260812000000 moves every contract / payment-schedule / approval write into a
 * SECURITY DEFINER routine and installs trg_guard_* triggers that raise 42501 for
 * the same write arriving as the `authenticated` role. Two things can silently
 * undo that:
 *
 *   1. a route that still writes a guarded table with the CALLER'S client — after
 *      the migration is applied that route returns 42501 at runtime, which is a
 *      money-path outage, not a security win;
 *   2. a route that calls the routine but maps its refusal to HTTP 200 or 500, so
 *      a client cannot tell "you may not do this" from "we broke".
 *
 * The database side of this is proved by execution in
 * supabase/replay/10_assert_release_contracts.sql (the money-* assertions, run in
 * the migration-replay job against a replayed schema). This file proves the parts
 * that live in the application: the SQLSTATE→HTTP mapper's own behaviour, run as
 * code — the very module the routes import — and the coupling between the routes,
 * the routine signatures, and the status grid the UI offers.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MONEY_RPC_STATUS, moneyRpcFailure, moneyRpcStatus } from "../../src/lib/money-rpc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = "supabase/migrations/20260812000000_money_actor_identity_and_atomicity.sql";
const CONTRACT_PAGE = "src/app/(dashboard)/contracts/[id]/page.tsx";

const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

/* ─── the mapper, executed ────────────────────────────────────────────── */

test("money_rpc: each SQLSTATE the routines raise maps to the HTTP status it means", () => {
  assert.equal(moneyRpcStatus({ code: "42501" }), 403, "not permitted → 403");
  assert.equal(moneyRpcStatus({ code: "22023" }), 400, "not a permitted transition / bad input → 400");
  assert.equal(moneyRpcStatus({ code: "23505" }), 409, "already exists → 409");
  assert.equal(moneyRpcStatus({ code: "P0002" }), 404, "row not found → 404");
});

test("money_rpc: an unrecognised failure is 500 and never quotes the database message", () => {
  // Negative case: the mapped messages are authored in the migration and safe to
  // relay. An arbitrary Postgres error is not — a unique-violation detail or a
  // check-constraint message can carry row values.
  for (const code of ["23503", "40001", "XX000", "", "42501 "]) {
    const failure = moneyRpcFailure({ code, message: "row (1234, 'Acme Holdings', 990000) violates ..." }, "Failed to create contract");
    assert.equal(failure.status, 500, `code ${JSON.stringify(code)} must not be treated as a decision`);
    assert.deepEqual(failure.body, { error: "Failed to create contract" });
  }
});

test("money_rpc: a malformed error object still yields 500, not a crash", () => {
  for (const err of [null, undefined, {}, { code: 42501 }, { code: null }, "42501"]) {
    assert.equal(moneyRpcStatus(err), 500, `${JSON.stringify(err)} must not map to a decision status`);
    assert.deepEqual(moneyRpcFailure(err, "fallback"), { status: 500, body: { error: "fallback" } });
  }
});

test("money_rpc: a mapped refusal relays the routine's own message and its code", () => {
  const failure = moneyRpcFailure(
    { code: "22023", message: "  approved is not a permitted transition from draft  " },
    "Failed to update contract status",
  );
  assert.equal(failure.status, 400);
  assert.equal(failure.body.error, "approved is not a permitted transition from draft");
  assert.equal(failure.body.code, "22023");
});

test("money_rpc: a mapped refusal with an empty message falls back rather than returning a blank error", () => {
  const failure = moneyRpcFailure({ code: "42501", message: "   " }, "Approval failed");
  assert.equal(failure.status, 403);
  assert.equal(failure.body.error, "Approval failed");
  assert.equal(failure.body.code, "42501");
});

test("money_rpc: the mapper is not vacuous — the migration raises every code it maps", async () => {
  const sql = await read(MIGRATION);
  for (const code of Object.keys(MONEY_RPC_STATUS)) {
    assert.ok(
      new RegExp(`errcode\\s*=\\s*'${code}'`, "i").test(sql),
      `${MIGRATION} raises no ${code}, so mapping it is dead code`,
    );
  }
});

/* ─── the routes ──────────────────────────────────────────────────────── */

// Every guarded write, and the routine that owns it. `forbidden` is what the
// route must NOT do any more: the same write through the caller's client, which
// trg_guard_* now refuses with 42501.
const ROUTES = [
  {
    file: "src/app/api/contracts/route.ts",
    rpc: "create_contract",
    forbidden: [
      /\.from\(\s*["']contracts["']\s*\)\s*\n?\s*\.insert\(/,
      /\.from\(\s*["']installment_plans["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/,
      /\.from\(\s*["']contract_approvals["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/,
    ],
  },
  {
    file: "src/app/api/contracts/[id]/route.ts",
    rpc: "set_contract_status",
    forbidden: [/\.from\(\s*["']contracts["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/],
  },
  {
    file: "src/app/api/contracts/[id]/approve/route.ts",
    rpc: "approve_contract",
    forbidden: [
      /\.from\(\s*["']contracts["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/,
      /\.from\(\s*["']contract_approvals["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/,
    ],
  },
  {
    file: "src/app/api/contracts/[id]/revoke/route.ts",
    rpc: "revoke_contract",
    forbidden: [/\.from\(\s*["']contracts["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/],
  },
  {
    file: "src/app/api/quotations/[id]/convert/route.ts",
    rpc: "convert_quotation_to_contract",
    forbidden: [
      /\.from\(\s*["']contracts["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/,
      /\.from\(\s*["']installment_plans["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/,
      /\.from\(\s*["']contract_approvals["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/,
      /\.from\(\s*["']quotations["']\s*\)\s*\n?\s*\.(insert|update|delete)\(/,
    ],
  },
];

for (const route of ROUTES) {
  test(`${route.file} routes its money write through ${route.rpc}()`, async () => {
    const src = await read(route.file);
    assert.ok(
      new RegExp(`\\.rpc\\(\\s*\\n?\\s*["']${route.rpc}["']`).test(src),
      `${route.file} does not call ${route.rpc}()`,
    );
    // Positive: refusals are translated. Without this the route falls through to
    // its catch and answers 500 for a 403.
    assert.match(
      src,
      /import \{ moneyRpcFailure \} from "@\/lib\/money-rpc\.mjs";/,
      `${route.file} must map SQLSTATEs with the same module this test executes`,
    );
    assert.match(src, /moneyRpcFailure\(rpcErr,/, `${route.file} does not use the mapper on the RPC error`);
  });

  test(`${route.file} no longer writes a guarded table with the caller's client`, async () => {
    const src = await read(route.file);
    for (const pattern of route.forbidden) {
      assert.doesNotMatch(
        src,
        pattern,
        `${route.file} still performs a direct guarded write (${pattern}); trg_guard_* answers 42501 once 20260812000000 is applied`,
      );
    }
  });
}

/**
 * name → { params: [...], required: [...] } parsed out of the CREATE FUNCTION
 * headers. A route that names an argument the routine does not have gets
 * PGRST202 ("function not found") from PostgREST, which the mapper reports as a
 * 500 — the failure mode a static check catches and a passing typecheck does not,
 * because the hand-declared Database types are written by the same hand.
 */
function routineSignatures(sql) {
  const signatures = new Map();
  const header = /create or replace function public\.([a-z_]+)\(([^)]*)\)/g;
  let match;
  while ((match = header.exec(sql)) !== null) {
    const [, name, args] = match;
    const params = args
      .split(",")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith("p_"))
      .map((chunk) => ({ name: chunk.split(/\s+/)[0], optional: /\bdefault\b/i.test(chunk) }));
    signatures.set(name, params);
  }
  return signatures;
}

test("every money route passes exactly the arguments its routine declares", async () => {
  const sql = await read(MIGRATION);
  const signatures = routineSignatures(sql);

  for (const route of ROUTES) {
    const params = signatures.get(route.rpc);
    assert.ok(params, `${route.rpc}() is not defined in ${MIGRATION}`);

    const src = await read(route.file);
    const call = src.slice(src.search(new RegExp(`\\.rpc\\(\\s*\\n?\\s*["']${route.rpc}["']`)));
    const payload = call.slice(call.indexOf("{"), call.indexOf("});"));
    const supplied = new Set([...payload.matchAll(/^\s{2,}(p_[a-z_]+):/gm)].map((m) => m[1]));

    for (const key of supplied) {
      assert.ok(
        params.some((p) => p.name === key),
        `${route.file} passes ${key} to ${route.rpc}(), which has no such parameter — PostgREST answers PGRST202`,
      );
    }
    for (const param of params.filter((p) => !p.optional)) {
      assert.ok(
        supplied.has(param.name),
        `${route.file} omits ${route.rpc}()'s required ${param.name}`,
      );
    }
  }
});

test("the hand-declared Database types cover every routine the routes call", async () => {
  const types = await read("src/types/database.ts");
  for (const route of ROUTES) {
    assert.match(
      types,
      new RegExp(`^\\s*${route.rpc}:`, "m"),
      `src/types/database.ts has no Functions entry for ${route.rpc}(); supabase.rpc() would not typecheck`,
    );
  }
});

test("PATCH /api/contracts/[id] exists — the contract page has been PATCHing it all along", async () => {
  const src = await read("src/app/api/contracts/[id]/route.ts");
  assert.match(src, /export async function PATCH\(/, "no PATCH export: every status button is a 405");
  const page = await read(CONTRACT_PAGE);
  assert.match(page, /method: "PATCH"/);
  assert.match(page, /fetch\(`\/api\/contracts\/\$\{[^}]+\}`/, "the page must target the route that now exports PATCH");
});

test("PATCH does not write the status itself — the routine decides the transition", async () => {
  const src = await read("src/app/api/contracts/[id]/route.ts");
  // Negative: a handler that wrote body.status onto the row would turn the page's
  // grid into an approval-chain bypass.
  assert.ok(
    !/(?<![_\w])status:\s*(?:body\.)?status\b/.test(src),
    "PATCH must not assign the requested status to a row update",
  );
  assert.match(src, /p_status:\s*status/, "PATCH must pass the requested status to set_contract_status()");
});

/* ─── the UI grid vs the routine's transition table ───────────────────── */

/** from-status → sorted allowed target statuses, parsed out of set_contract_status(). */
function transitionsFromMigration(sql) {
  const body = sql.slice(
    sql.indexOf("create or replace function public.set_contract_status("),
    sql.indexOf("create or replace function public.revoke_contract("),
  );
  assert.ok(body.length > 0, "set_contract_status() not found in the migration");
  const table = new Map();
  const branch = /(?:if|elsif) p_status = '([a-z_]+)' and v_contract\.status (?:= '([a-z_]+)'|in \(([^)]*)\))/g;
  let match;
  while ((match = branch.exec(body)) !== null) {
    const [, target, single, list] = match;
    const froms = single
      ? [single]
      : list.split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
    for (const from of froms) {
      if (!table.has(from)) table.set(from, new Set());
      table.get(from).add(target);
    }
  }
  return table;
}

function transitionsFromPage(tsx) {
  const start = tsx.indexOf("const STATUS_TRANSITIONS");
  assert.ok(start >= 0, "STATUS_TRANSITIONS not found on the contract page");
  const literal = tsx.slice(tsx.indexOf("{", start), tsx.indexOf("};", start));
  const table = new Map();
  const entry = /([a-z_]+):\s*\[([^\]]*)\]/g;
  let match;
  while ((match = entry.exec(literal)) !== null) {
    const targets = match[2].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    table.set(match[1], new Set(targets));
  }
  return table;
}

test("the contract page offers exactly the transitions set_contract_status() accepts", async () => {
  const [sql, page] = await Promise.all([read(MIGRATION), read(CONTRACT_PAGE)]);
  const routine = transitionsFromMigration(sql);
  const ui = transitionsFromPage(page);

  assert.ok(routine.size > 0, "parsed no transitions out of the routine — the parser has drifted");

  for (const [from, targets] of ui) {
    assert.ok(routine.has(from), `the page offers buttons from '${from}', which the routine has no branch for`);
    for (const target of targets) {
      assert.ok(
        routine.get(from).has(target),
        `the page offers ${from} → ${target}; set_contract_status() answers 22023 for it`,
      );
    }
  }
  // And the other direction: a transition the routine allows but the page hides
  // is an unreachable feature, so the two tables must be equal.
  for (const [from, targets] of routine) {
    assert.ok(ui.has(from), `set_contract_status() allows transitions from '${from}' that the page never offers`);
    for (const target of targets) {
      assert.ok(ui.get(from).has(target), `set_contract_status() allows ${from} → ${target}; the page never offers it`);
    }
  }
});

test("the approval-chain statuses are not in the page's grid", async () => {
  const page = await read(CONTRACT_PAGE);
  const ui = transitionsFromPage(page);
  // approved / pending_ceo / rejected belong to approve_contract(). They were in
  // the nine-button grid this replaces.
  for (const [from, targets] of ui) {
    for (const forbidden of ["approved", "pending_ceo", "rejected", "superseded", "revoking"]) {
      assert.ok(
        !targets.has(forbidden),
        `the page offers ${from} → ${forbidden}, which only approve_contract()/revoke_contract() may set`,
      );
    }
  }
});

test("the page requires a reason for exactly the transitions the routine requires one for", async () => {
  const [sql, page] = await Promise.all([read(MIGRATION), read(CONTRACT_PAGE)]);
  const required = new Set(
    [...page.matchAll(/const STATUS_REASON_REQUIRED = new Set\(\[([^\]]*)\]\)/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")))
      .filter(Boolean),
  );
  assert.deepEqual([...required], ["terminated"]);
  // Proof the requirement is real and not just UI decoration.
  assert.match(
    sql,
    /a reason is required to terminate a contract' using errcode = '22023'/,
    "set_contract_status() no longer demands a termination reason; the UI gate is then the only one",
  );
  // Negative: the client must block on it, otherwise the user gets a 400.
  assert.match(
    page,
    /STATUS_REASON_REQUIRED\.has\((?:newStatus|pendingStatus)\)[\s\S]{0,80}(?:=== ""|\.trim\(\) === "")/,
    "the page must refuse to submit a required-reason transition with a blank reason",
  );
});
