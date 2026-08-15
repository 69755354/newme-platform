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
import { allowedSetContractStatuses } from "../../src/lib/contract-status-capabilities.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = "supabase/migrations/20260812000000_money_actor_identity_and_atomicity.sql";
// 20260814000000 REPLACES set_contract_status(), revoke_contract(), create_contract(),
// convert_quotation_to_contract(), confirm_payment() and allocate_payment(), and adds
// the class-28 session boundary. Anything that reads only the older file is reading a
// body the database no longer has, which is exactly the false-green this file exists
// to prevent — so the effective definition is always the LAST one to define a routine.
const ROUND3 = "supabase/migrations/20260814000000_l0_round3_authorization_and_integrity.sql";
const CONTRACT_PAGE = "src/app/(dashboard)/contracts/[id]/page.tsx";

const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

/** The migrations that define money routines, in application order. */
const MONEY_MIGRATIONS = [MIGRATION, ROUND3];

/** Concatenated in application order, for "is this raised anywhere" questions. */
async function moneySql() {
  const parts = await Promise.all(MONEY_MIGRATIONS.map(read));
  return parts.join("\n");
}

/* ─── the mapper, executed ────────────────────────────────────────────── */

test("money_rpc: each SQLSTATE the routines raise maps to the HTTP status it means", () => {
  assert.equal(moneyRpcStatus({ code: "42501" }), 403, "not permitted → 403");
  assert.equal(moneyRpcStatus({ code: "22023" }), 400, "not a permitted transition / bad input → 400");
  assert.equal(moneyRpcStatus({ code: "23505" }), 409, "already exists → 409");
  assert.equal(moneyRpcStatus({ code: "P0002" }), 404, "row not found → 404");
});

test("money_rpc: every class-28 SQLSTATE is 401, enumerated or not", () => {
  // assert_current_session() raises 28001..28006, and 28000 for a verdict it does
  // not recognise. All of them mean "re-authenticate", not "you may not do this",
  // and none of them may degrade to a retryable 500.
  for (const code of ["28000", "28001", "28002", "28003", "28004", "28005", "28006"]) {
    assert.equal(moneyRpcStatus({ code }), 401, `${code} must be 401`);
  }
  // Fail closed on the class: a class-28 code nobody enumerated is still a refusal.
  assert.equal(moneyRpcStatus({ code: "28P01" }), 401, "an unlisted class-28 code must still be 401");
  // And the boundary of the rule: 28 must be the CLASS, not a prefix match.
  assert.equal(moneyRpcStatus({ code: "2800" }), 500, "a short code is not a SQLSTATE");
  assert.equal(moneyRpcStatus({ code: "28000 " }), 500, "a padded code is not a SQLSTATE");
});

test("money_rpc: a session refusal relays the boundary's own reason", () => {
  const failure = moneyRpcFailure(
    { code: "28005", message: "session boundary: this access token predates the last credential change" },
    "Failed to confirm payment",
  );
  assert.equal(failure.status, 401);
  assert.equal(failure.body.code, "28005");
  assert.match(failure.body.error, /predates the last credential change/);
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

test("money_rpc: the mapper is not vacuous — a migration raises every code it maps", async () => {
  const sql = await moneySql();
  for (const code of Object.keys(MONEY_RPC_STATUS)) {
    assert.ok(
      new RegExp(`errcode\\s*=\\s*'${code}'`, "i").test(sql),
      `no money migration raises ${code}, so mapping it is dead code`,
    );
  }
});

/**
 * The SQL with its migration-time `do $tag$ ... $tag$;` blocks removed.
 *
 * Those blocks raise too — the catalog-driven installer of
 * trg_require_current_session raises 22000 if it matches no tables — but they run
 * once, at migration time, in front of an operator. Only the routines a route can
 * call have to have an HTTP status.
 */
function withoutDoBlocks(sql) {
  return sql.replace(/\bdo \$([a-z_]*)\$[\s\S]*?\$\1\$\s*;/g, "");
}

test("money_rpc: and the other direction — every code the routines raise is mapped", async () => {
  const sql = withoutDoBlocks(await moneySql());
  const raised = new Set(
    [...sql.matchAll(/errcode\s*=\s*'([0-9A-Z]{5})'/g)].map((m) => m[1]),
  );
  assert.ok(raised.size > 0, "parsed no errcodes out of the money migrations — the parser has drifted");
  for (const code of raised) {
    // 23514 (check violation) and 40001 (serialization failure) are raised BY
    // PostgreSQL, not by the routines; everything a routine raises on purpose is a
    // decision and must have a status, or a refusal reaches the client as a 500.
    assert.ok(
      Object.prototype.hasOwnProperty.call(MONEY_RPC_STATUS, code) || moneyRpcStatus({ code }) !== 500,
      `the money routines raise ${code} on purpose but moneyRpcStatus() answers 500 for it`,
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
  // Concatenated in application order, so a routine redefined by 20260814000000
  // overwrites the 20260812000000 signature — which is what PostgREST will see.
  const signatures = routineSignatures(await moneySql());

  for (const route of ROUTES) {
    const params = signatures.get(route.rpc);
    assert.ok(params, `${route.rpc}() is defined in no money migration`);

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

/* ─── role capabilities, page consumption, and the routine graph ───────── */

/**
 * from-status → allowed target statuses reachable through set_contract_status().
 *
 * Two artifacts, both in 20260814000000: the transition GRAPH, which is the whole
 * lifecycle including the statuses only approve_contract() and revoke_contract()
 * may set, and set_contract_status()'s own whitelist of statuses it will set. The
 * manager capability is the intersection. The role matrix below is explicit, and
 * the page is separately required to consume the capability returned by the API.
 */
function transitionsFromMigration(sql) {
  const graphStart = sql.indexOf("create or replace function public.contract_transition_is_allowed(");
  assert.ok(graphStart >= 0, "contract_transition_is_allowed() not found");
  const graphBody = sql.slice(graphStart, sql.indexOf("$$;", graphStart));
  const pairs = [...graphBody.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\)/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length > 0, "parsed no pairs out of the transition graph — the parser has drifted");

  const setterStart = sql.indexOf("create or replace function public.set_contract_status(");
  assert.ok(setterStart >= 0, "set_contract_status() not found");
  const setterBody = sql.slice(setterStart, sql.indexOf("$$;", setterStart));
  const whitelist = setterBody.match(/p_status not in \(([^)]*)\)/);
  assert.ok(whitelist, "set_contract_status() no longer declares the statuses it may set");
  const settable = new Set(
    whitelist[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean),
  );
  assert.ok(settable.size > 0, "parsed an empty settable-status list");

  const table = new Map();
  for (const [from, to] of pairs) {
    if (!settable.has(to)) continue;
    if (!table.has(from)) table.set(from, new Set());
    table.get(from).add(to);
  }
  return table;
}

const CONTRACT_STATUSES = [
  "draft", "signed", "pending_admin", "pending_ceo", "approved", "active", "completed",
  "terminated", "rejected", "revoking", "superseded", "suspended", "cancelled", "unknown",
];

const MANAGER_TRANSITIONS = {
  draft: ["pending_admin"],
  rejected: ["pending_admin", "draft"],
  approved: ["active", "terminated"],
  active: ["completed", "suspended", "terminated"],
  suspended: ["active", "terminated"],
  revoking: ["terminated"],
};
const OPERATIONS_TRANSITIONS = {
  approved: ["active"],
  active: ["completed"],
  suspended: ["active"],
};
const OWNER_TRANSITIONS = {
  draft: ["pending_admin"],
  rejected: ["pending_admin", "draft"],
};

function expectedTransitions(role, isOwner, status) {
  if (role === "admin" || role === "boss") return MANAGER_TRANSITIONS[status] ?? [];
  if (role === "operator") {
    return [...(OPERATIONS_TRANSITIONS[status] ?? []), ...(OWNER_TRANSITIONS[status] ?? [])];
  }
  if (role === "finance") {
    return [...(OPERATIONS_TRANSITIONS[status] ?? []), ...(isOwner ? OWNER_TRANSITIONS[status] ?? [] : [])];
  }
  if (role === "sales" && isOwner) return OWNER_TRANSITIONS[status] ?? [];
  return [];
}

function transitionsFromCapabilities(role, isOwner) {
  const table = new Map();
  for (const status of CONTRACT_STATUSES) {
    const targets = allowedSetContractStatuses(role, isOwner, status);
    if (targets.length > 0) table.set(status, new Set(targets));
  }
  return table;
}

for (const role of ["admin", "boss", "operator", "finance", "sales", "designer"]) {
  for (const isOwner of [false, true]) {
    test(`contract status capability matrix: ${role}, owner=${isOwner}`, () => {
      for (const status of CONTRACT_STATUSES) {
        assert.deepEqual(
          allowedSetContractStatuses(role, isOwner, status),
          expectedTransitions(role, isOwner, status),
          `${role}, owner=${isOwner}, status=${status}`,
        );
      }
    });
  }
}

test("the contract page consumes server-provided allowedStatusTransitions and defines no local transition grid", async () => {
  const [page, route] = await Promise.all([read(CONTRACT_PAGE), read("src/app/api/contracts/[id]/route.ts")]);

  assert.match(page, /allowedStatusTransitions:\s*string\[\]/);
  assert.match(page, /const \{[^}]*allowedStatusTransitions[^}]*\} = data/);
  assert.match(page, /if \(!allowedStatusTransitions\.includes\(newStatus\)\) return/);
  assert.match(page, /const allowedTransitions = allowedStatusTransitions/);
  assert.doesNotMatch(page, /\b(?:const|let|var)\s+STATUS_TRANSITIONS\b/);

  assert.match(route, /import \{ allowedSetContractStatuses \} from "@\/lib\/contract-status-capabilities\.mjs"/);
  assert.match(route, /allowedStatusTransitions:\s*allowedSetContractStatuses\(/);
});

test("the manager capability includes exactly the transitions set_contract_status() accepts", async () => {
  const sql = await read(ROUND3);
  const routine = transitionsFromMigration(sql);
  const capability = transitionsFromCapabilities("admin", false);

  assert.ok(routine.size > 0, "parsed no transitions out of the routine — the parser has drifted");
  assert.deepEqual(capability, routine);
});

test("no role capability exposes an approval-chain or revocation-only target", () => {
  for (const role of ["admin", "boss", "operator", "finance", "sales", "designer"]) {
    for (const isOwner of [false, true]) {
      for (const from of CONTRACT_STATUSES) {
        const targets = allowedSetContractStatuses(role, isOwner, from);
        for (const forbidden of ["approved", "pending_ceo", "rejected", "superseded", "revoking"]) {
          assert.ok(!targets.includes(forbidden), `${role}, owner=${isOwner} exposes ${from} → ${forbidden}`);
        }
      }
    }
  }
});

test("the page requires a reason for exactly the transitions the routine requires one for", async () => {
  const [sql, page] = await Promise.all([read(ROUND3), read(CONTRACT_PAGE)]);
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
