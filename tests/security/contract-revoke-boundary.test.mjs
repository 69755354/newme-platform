/**
 * The contracts-list Revoke button, from the click to the routine.
 *
 * Round-4 finding B1. Two revoke entry points existed and they did different
 * things: the contract DETAIL page posted to /api/contracts/[id]/revoke, which
 * calls revoke_contract(); the contracts LIST page called a `revokeContract`
 * server action that read the caller's role out of profiles and then issued
 * `update contracts set status = 'revoking'` through the caller's own client.
 *
 * Reproduced on an isolated PG17 with the committed migrations applied, the floor
 * schema and 05_seed_behaviour_fixtures.sql, acting as `authenticated` with the
 * claim shape GoTrue issues:
 *
 *   direct UPDATE as boss   compat: 00000, status -> revoking   strict: 42501, unchanged
 *   direct UPDATE as sales  compat: 00000, status -> revoking   strict: 42501, unchanged
 *   revoke_contract as boss  both modes: 00000, previous_status active -> revoking
 *   revoke_contract as sales both modes: 42501, unchanged
 *
 * So the action was broken in both directions at once. In compat it worked, and
 * that was the problem: a sales session's identical statement also worked, because
 * the admin/boss rule lived in the action's separate SELECT and never in the
 * database, and the write skipped revoke_contract()'s transition check and its
 * `for update`. In strict, trg_guard_contracts_write refuses it and the button
 * could not revoke at all. Both are the same root cause — a money write that did
 * not go through the routine that owns it.
 *
 * tests/security/money-route-rpc-coupling.test.mjs holds the same rule for the API
 * routes. This file covers the surfaces that file does not scan — server actions
 * and dashboard pages — and pins the list page's wiring, because "the route is
 * correct" says nothing about which code the button reaches.
 *
 * Scope note: this is about the contract STATUS. Ownership reassignment
 * (`contracts.sales_id`, written by src/app/actions/team.ts through the service
 * role) is a separate open finding and is deliberately not in this rule — a test
 * that quietly widened would fail for a reason it was not written to catch.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

const LIST_PAGE = "src/app/(dashboard)/contracts/page.tsx";
const DETAIL_PAGE = "src/app/(dashboard)/contracts/[id]/page.tsx";
const REVOKE_ROUTE = "src/app/api/contracts/[id]/revoke/route.ts";
const ACTIONS = "src/app/actions/contracts.ts";
const ROUND3 = "supabase/migrations/20260814000000_l0_round3_authorization_and_integrity.sql";

/**
 * Source with its comments removed, because these rules are about what the code
 * DOES. The file that used to hold the direct write now carries a comment naming
 * revokeContract and quoting the statement, and a scan that could not tell prose
 * from code would force that explanation to be deleted — which is the opposite of
 * what a reader needs. Crude by design (a `//` inside a string literal is stripped
 * too); it is only ever used to answer "does this file still do X".
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * Every `.from("contracts") ... .update({...})` in `src` whose payload sets
 * `status`, as {index, snippet}. Written as a function and exercised against
 * fixtures below rather than inlined into an assertion, so the rule itself is
 * testable — a detector that only ever runs over clean files cannot be
 * distinguished from one that matches nothing.
 */
export function contractStatusWrites(src) {
  const hits = [];
  const from = /\.from\(\s*["'`]contracts["'`]\s*\)/g;
  let match;
  while ((match = from.exec(src)) !== null) {
    // The chained call, up to whatever terminates the statement. Supabase
    // builders are chained across lines, so this is a window, not a line.
    const window = src.slice(match.index, match.index + 400);
    const update = window.match(/\.update\(\s*(\{[\s\S]*?\})\s*\)/);
    if (!update) continue;
    if (!/\bstatus\s*:/.test(update[1])) continue;
    hits.push({ index: match.index, snippet: window.slice(0, update.index + update[0].length) });
  }
  return hits;
}

/* ─── the detector, against fixtures ─────────────────────────────────────── */

test("the detector flags the exact shape this finding removed", () => {
  // Verbatim from the deleted revokeContract(), reindented. If a later edit makes
  // the detector stop seeing this, every "no direct status write" assertion below
  // becomes a tautology, and the finding comes back silently.
  const removed = `
  const { error: updateErr } = await supabase
    .from('contracts')
    .update({
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contractId)
`;
  assert.equal(contractStatusWrites(removed).length, 1, "the detector no longer recognises the removed write");
});

test("the detector does not flag the writes that are not this finding", () => {
  // Each of these is a shape the codebase legitimately contains. A detector that
  // flagged them would be turned off by the next person who hit it.
  const clean = [
    // reading contracts
    `const { data } = await supabase.from("contracts").select("id, status").eq("id", id).single()`,
    // a status write on a table that has no money guard
    `await supabase.from("leads").update({ status: "won" }).eq("id", leadId)`,
    // contracts, updated, but not the status — ownership reassignment, out of scope
    `await supabaseAdmin.from("contracts").update({ sales_id: reassignTo }).eq("sales_id", userId)`,
    // the supported path
    `const { data } = await supabase.rpc("revoke_contract", { p_contract_id: id, p_reason: reason })`,
    // a status field on some other payload near a contracts read
    `const { data: c } = await supabase.from("contracts").select("*"); await log({ status: c.status })`,
  ];
  for (const src of clean) {
    assert.deepEqual(contractStatusWrites(src), [], `false positive on: ${src.slice(0, 60)}`);
  }
});

/* ─── the surfaces ───────────────────────────────────────────────────────── */

async function tsSources(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const abs = path.join(entry.parentPath ?? entry.path, entry.name);
    out.push(path.relative(ROOT, abs).split(path.sep).join("/"));
  }
  return out;
}

test("no server action writes a contract's status", async () => {
  const files = await tsSources("src/app/actions");
  assert.ok(files.length >= 5, `scanned ${files.length} server actions — the walker has drifted`);
  for (const file of files) {
    const hits = contractStatusWrites(code(await read(file)));
    assert.deepEqual(
      hits.map((h) => h.snippet.slice(0, 70)),
      [],
      `${file} writes contracts.status directly; trg_guard_contracts_write answers 42501 in strict mode, and in compat it authorizes the write in application code only`,
    );
  }
});

test("no dashboard page writes a contract's status", async () => {
  const files = await tsSources("src/app/(dashboard)");
  assert.ok(files.length >= 10, `scanned ${files.length} dashboard sources — the walker has drifted`);
  for (const file of files) {
    assert.deepEqual(contractStatusWrites(code(await read(file))), [], `${file} writes contracts.status from the client`);
  }
});

test("revokeContract is gone, not merely unused", async () => {
  const actions = code(await read(ACTIONS));
  assert.doesNotMatch(
    actions,
    /export\s+async\s+function\s+revokeContract\b/,
    "the direct-write server action is still exported; an unused export is one import away from being used again",
  );
  // And nothing in the tree imports it, which is the other half — an export can be
  // removed while a stale import keeps the build red, or vice versa.
  for (const dir of ["src/app/actions", "src/app/(dashboard)", "src/app/api", "src/components"]) {
    for (const file of await tsSources(dir)) {
      assert.doesNotMatch(
        code(await read(file)),
        /\brevokeContract\b/,
        `${file} still references revokeContract`,
      );
    }
  }
});

/* ─── the wiring: click → route → routine ────────────────────────────────── */

test("the contracts list revokes through the canonical route", async () => {
  const page = await read(LIST_PAGE);
  const call = page.match(
    /fetch\(\s*`\/api\/contracts\/\$\{[A-Za-z0-9_]+\}\/revoke`\s*,\s*\{[\s\S]{0,400}?\}\s*\)/,
  );
  assert.ok(call, `${LIST_PAGE} does not POST to /api/contracts/[id]/revoke`);
  assert.match(call[0], /method:\s*"POST"/, "the revoke call must be a POST");
  assert.match(call[0], /reason/, "revoke_contract() raises 22023 without a reason, so the body must carry one");
  // The button must not fire without one, or the user gets a 400 for a form the UI
  // could have validated.
  assert.match(
    page,
    /revokeReason\.trim\(\)[\s\S]{0,120}return/,
    "the list page must refuse to submit a blank revocation reason",
  );
});

test("both revoke entry points reach the same routine", async () => {
  const [list, detail, route] = await Promise.all([read(LIST_PAGE), read(DETAIL_PAGE), read(REVOKE_ROUTE)]);
  for (const [name, src] of [["list", list], ["detail", detail]]) {
    assert.match(
      src,
      /\/api\/contracts\/\$\{[A-Za-z0-9_]+\}\/revoke/,
      `the ${name} page does not target the revoke route`,
    );
  }
  assert.match(route, /export async function POST\(/, "the revoke route exports no POST; the button would be a 405");
  assert.match(route, /\.rpc\(\s*\n?\s*["']revoke_contract["']/, "the revoke route no longer calls revoke_contract()");
  assert.match(
    route,
    /moneyRpcFailure\(rpcErr,/,
    "the route must map the routine's SQLSTATE, or a 403 reaches the button as a 500",
  );
});

test("the list page surfaces the route's own refusal text", async () => {
  const page = await read(LIST_PAGE);
  // A server action threw and the page showed err.message. A fetch does not throw
  // on 403, so a page that only catches would report success for a refusal.
  assert.match(page, /if \(!res\.ok\)/, "the revoke handler must branch on res.ok");
  assert.match(page, /err\.error \|\| t\("contracts\.revokeFailed"\)/, "the refusal reason must reach the toast");
});

/* ─── the reason the fix is load-bearing ─────────────────────────────────── */

test("the database really does own this rule — the guard and the routine, from the migration", async () => {
  const sql = await read(ROUND3);

  // The refusal the reproduction hit in strict mode.
  const guard = sql.slice(sql.indexOf("create or replace function public.guard_contracts_write()"));
  const guardBody = guard.slice(0, guard.indexOf("$$;"));
  assert.match(
    guardBody,
    /new\.status\s+is distinct from old\.status/,
    "guard_contracts_write() no longer refuses a direct status change; the fix would be cosmetic",
  );

  // The three things the deleted action did not do, all inside one transaction.
  const routine = sql.slice(sql.indexOf("create or replace function public.revoke_contract("));
  const body = routine.slice(0, routine.indexOf("$$;"));
  assert.match(
    body,
    /money_actor\(\s*null\s*,\s*array\['admin',\s*'boss'\]\s*\)/,
    "revoke_contract() must resolve the actor from the token and require admin/boss",
  );
  assert.match(body, /from public\.contracts where id = p_contract_id for update/, "the row must be taken FOR UPDATE");
  assert.match(
    body,
    /contract_transition_is_allowed\(v_contract\.status, v_new_status\)/,
    "revoke_contract() must check the transition against the graph, not against two hard-coded statuses",
  );
  assert.match(body, /'previous_status',\s*v_contract\.status/, "the caller needs the status it moved from");
});
