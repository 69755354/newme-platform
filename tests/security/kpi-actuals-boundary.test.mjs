/**
 * KPI actuals: every write to kpi_targets goes through the routine that owns it.
 *
 * Round-4 finding B7. The review's first two claims are already closed on disk and
 * this file pins them so they cannot silently reopen; the third claim was not the
 * hole, and the hole that is left is a fourth thing the review did not name.
 *
 * Measured on an isolated PG17 with 00_platform_bootstrap.sql, 01_floor_schema.sql,
 * the branch migrations in filename order and 05_seed_behaviour_fixtures.sql, acting
 * as `authenticated` with the claim shape GoTrue issues (sub + role + iat), and with
 * the production kpi_targets policies from
 * 20260701000000_non_core_tables_rls_fix.sql:202-229 installed, because the replay
 * floor creates kpi_targets with RLS enabled and NO policies — every "authenticated
 * cannot" assertion is vacuous without them.
 *
 *   replace_kpi_targets, pairs kept     compat 00000  actual sum 700.00 -> 700.00
 *                                       strict 00000  actual sum 700.00 -> 700.00
 *   replace_kpi_targets, pair dropped   compat 22023  actual sum 700.00 -> 700.00
 *                                       strict 22023  actual sum 700.00 -> 700.00
 *   confirm then reassign then void     both modes: credited_to pinned to the
 *                                       crediting salesperson; the void debited
 *                                       owner_C 100.00 -> 0.00 and left the new
 *                                       owner_E at 0.00 -> 0.00
 *
 * So "replacing period targets resets actuals" and "void subtracts from the current
 * rather than the credited salesperson" are both REFUTED against this tree:
 * 20260817000000_l0_round4_money_and_business_integrity.sql carries actual_amount
 * forward under the period lock, refuses a payload that drops a pair still holding
 * collected money, persists payments.credited_to on confirm and debits that column
 * on void. The two tests at the bottom of this file exist so a later edit cannot
 * take those back without turning red.
 *
 * What was still open is the DELETE verb. src/app/api/kpi/targets/route.ts ran, on
 * the service-role client,
 *
 *     await supabaseAdmin.from("kpi_targets").delete().eq("period", period);
 *
 * reaching the table without reaching the routine. Same harness, both modes:
 *
 *   service_role  DELETE where period = P   00000  deleted 2  actual sum 700.00 -> 0
 *   authenticated DELETE as sales           00000  deleted 0  (RLS filtered)
 *   authenticated DELETE as operator        00000  deleted 0  (RLS filtered)
 *   authenticated DELETE as boss            00000  deleted 1
 *
 * Three consequences from the one statement. It destroyed collected amounts that the
 * save path refuses (22023) to drop, by a different verb. It took none of the period
 * advisory lock replace_kpi_targets() serializes on: with an uncommitted service-role
 * DELETE in flight, a second connection counted 0 granted advisory locks on that
 * period's key and pg_try_advisory_xact_lock returned TRUE, in both modes; with
 * clear_kpi_targets() in flight the same probe counted 1 and returned FALSE. And it
 * bypassed RLS, so the route's own role list was the entire authorization — that list
 * was admin/boss/operator while the database's DELETE policy is admin/boss, so an
 * operator's identical statement is refused by the database and was accepted by the
 * route.
 *
 * tests/security/money-route-rpc-coupling.test.mjs holds the "routes call routines"
 * rule for the money tables. This file is the same rule for kpi_targets and adds the
 * things that rule cannot see: which role list the route enforces, and whether the
 * routine it calls still contains the guard the reproduction measured.
 *
 * Scope note: the DELETE verb is what this finding is about. A raw
 * `delete from public.kpi_targets` is still expressible in SQL by anything holding
 * the service role, because that is a table grant and not a routine — removing it is
 * a separate change with a different blast radius. The boundary that keeps it out of
 * the product is this scan.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

const KPI_ROUTE = "src/app/api/kpi/targets/route.ts";
const KPI_UI = "src/app/(dashboard)/settings/kpi-management.tsx";
const ROUND4 = "supabase/migrations/20260817000000_l0_round4_money_and_business_integrity.sql";
const CLEAR_MIGRATION = "supabase/migrations/20260817150000_kpi_period_clear_owns_the_delete.sql";
const MIGRATIONS = "supabase/migrations";
const CLI_MIGRATION = /^[0-9]{14}_.*\.sql$/;

/**
 * The LAST `create or replace function public.NAME(` in the release, by filename
 * order — which is apply order, and therefore the definition the database ends up
 * with. Pinning a named file instead was how a body could be re-emitted later and
 * lose a guard while the test that guarded it stayed green: R3's
 * 20260817160000_kpi_period_lock_covers_money_writers.sql re-emits confirm_payment
 * and void_payment in full, so every assertion below about their bodies has to
 * read that file now, and whatever re-emits them next without anyone editing this
 * one.
 */
async function lastDefinition(name) {
  const files = (await readdir(path.join(ROOT, MIGRATIONS))).filter((file) => CLI_MIGRATION.test(file)).sort();
  let found = null;
  for (const file of files) {
    const sql = await read(`${MIGRATIONS}/${file}`);
    const at = sql.lastIndexOf(`create or replace function public.${name}(`);
    if (at === -1) continue;
    const rest = sql.slice(at);
    found = { file, body: rest.slice(0, rest.indexOf("$$;")) };
  }
  assert.ok(found, `no migration defines public.${name}`);
  return found;
}

/**
 * Source with its comments removed, because these rules are about what the code
 * DOES. The route now carries a comment quoting the removed statement verbatim, and
 * a scan that could not tell prose from code would force that explanation to be
 * deleted — which is the opposite of what a reader needs. Crude by design (a `//`
 * inside a string literal is stripped too); it is only ever used to answer "does
 * this file still do X".
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * Every PostgREST builder chain in `src` that starts at kpi_targets and reaches a
 * write verb, as {index, verb, snippet}. Written as a function and exercised against
 * fixtures below rather than inlined into an assertion, so the rule itself is
 * testable — a detector that only ever runs over clean files cannot be distinguished
 * from one that matches nothing.
 *
 * All four write verbs, not just delete: the period is replaced by
 * replace_kpi_targets() and cleared by clear_kpi_targets(), and an insert or an
 * upsert issued next to them would carry the same defect as the delete did — a write
 * to actual_amount's table that never meets the rule attached to actual_amount.
 */
export function kpiTargetTableWrites(src) {
  const hits = [];
  const from = /\.from\(\s*["'`]kpi_targets["'`]\s*\)/g;
  let match;
  while ((match = from.exec(src)) !== null) {
    // Supabase builders are chained across lines, so the unit is the statement, not
    // the line. Stop at the first `;` so a later unrelated `.delete(` on another
    // table cannot be attributed to this chain.
    const chain = src.slice(match.index, match.index + 400).split(";")[0];
    const verb = chain.match(/\.(delete|insert|update|upsert)\s*\(/);
    if (!verb) continue;
    hits.push({
      index: match.index,
      verb: verb[1],
      snippet: chain.slice(0, verb.index + verb[0].length),
    });
  }
  return hits;
}

/* ─── the detector, against fixtures ─────────────────────────────────────── */

test("the detector flags the exact shape this finding removed", () => {
  // Verbatim from src/app/api/kpi/targets/route.ts:111 as it stood. If a later edit
  // makes the detector stop seeing this, every scan below becomes a tautology and
  // the finding comes back silently.
  const removed = `  const { error } = await supabaseAdmin.from("kpi_targets").delete().eq("period", period);`;
  const hits = kpiTargetTableWrites(removed);
  assert.equal(hits.length, 1, "the detector no longer recognises the removed write");
  assert.equal(hits[0].verb, "delete");
});

test("the detector flags a write split across lines, which is how the codebase chains", () => {
  const wrapped = `
  const { error } = await supabaseAdmin
    .from("kpi_targets")
    .delete()
    .eq("period", period);
`;
  assert.equal(kpiTargetTableWrites(wrapped).length, 1, "a multi-line chain must still be seen");
});

test("the detector does not flag the writes and reads that are not this finding", () => {
  // Each of these is a shape the codebase legitimately contains — four of them are
  // verbatim from files this suite scans. A detector that flagged them would be
  // turned off by the next person who hit it.
  const clean = [
    // the route's own GET, reading through the caller's RLS client
    `let q = supabase.from("kpi_targets").select("*, profiles!kpi_targets_assigned_to_fkey(full_name)");`,
    // src/app/api/dashboard/summary/route.ts:101
    `const p = supabase.from("kpi_targets").select("*").eq("period", month);`,
    // src/app/api/pipeline/list/route.ts:56
    `supabase.from('kpi_targets').select('*').eq('period', period).eq('assigned_to', userId),`,
    // src/app/api/settings/data/route.ts:42
    `const r = await supabase.from("kpi_targets").select("*, profiles!kpi_targets_assigned_to_fkey(full_name)");`,
    // the supported save path
    `const { data } = await supabaseAdmin.rpc("replace_kpi_targets", { p_period: period, p_rows: rows, p_set_by: user.id });`,
    // the supported clear path — the fix itself must not trip its own rule
    `const { data: removed, error } = await supabaseAdmin.rpc("clear_kpi_targets", { p_period: period, p_actor: user.id });`,
    // a delete on a different table
    `await supabaseAdmin.from("notifications").delete().eq("id", id);`,
    // the word "delete" in a later statement, after a kpi_targets read
    `const { data } = await supabase.from("kpi_targets").select("*"); await audit({ action: "delete" });`,
    // an update on a different table in the same chain window as a kpi read
    `const { data } = await supabase.from("kpi_targets").select("id");\n  await supabaseAdmin.from("profiles").update({ role: "sales" }).eq("id", id);`,
  ];
  for (const src of clean) {
    assert.deepEqual(kpiTargetTableWrites(src), [], `false positive on: ${src.slice(0, 70)}`);
  }
});

test("code() is what makes the route's explanation legal", () => {
  // The route documents the removed statement by quoting it. Raw, that quote reads
  // as the defect; stripped, it does not. This pins the pair, because if code() ever
  // stopped stripping, the fix would look like the bug.
  const commented = `  // B7: this used to be\n  //     await supabaseAdmin.from("kpi_targets").delete().eq("period", period);\n  const x = 1;`;
  assert.equal(kpiTargetTableWrites(commented).length, 1, "the raw comment should still contain the shape");
  assert.deepEqual(kpiTargetTableWrites(code(commented)), [], "code() must strip the quoted statement");
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

test("no API route writes kpi_targets directly", async () => {
  const files = await tsSources("src/app/api");
  assert.ok(files.length >= 20, `scanned ${files.length} API routes — the walker has drifted`);
  for (const file of files) {
    const hits = kpiTargetTableWrites(code(await read(file)));
    assert.deepEqual(
      hits.map((h) => `${h.verb}: ${h.snippet.slice(0, 70)}`),
      [],
      `${file} writes kpi_targets directly. On the service-role client that bypasses RLS and skips both the period advisory lock and the actual_amount guard: measured, a service-role delete of one period answered 00000, removed 2 rows and took recorded actuals of 700.00 to 0. Go through replace_kpi_targets() or clear_kpi_targets().`,
    );
  }
});

test("no server action and no dashboard page writes kpi_targets directly", async () => {
  for (const [dir, floor] of [
    ["src/app/actions", 5],
    ["src/app/(dashboard)", 10],
  ]) {
    const files = await tsSources(dir);
    assert.ok(files.length >= floor, `scanned ${files.length} sources under ${dir} — the walker has drifted`);
    for (const file of files) {
      assert.deepEqual(kpiTargetTableWrites(code(await read(file))), [], `${file} writes kpi_targets directly`);
    }
  }
});

/* ─── the wiring: the period-clear button → the route → the routine ──────── */

test("the KPI route clears a period through clear_kpi_targets", async () => {
  const src = code(await read(KPI_ROUTE));
  const del = src.slice(src.indexOf("export async function DELETE("));
  assert.ok(del.length > 0, `${KPI_ROUTE} exports no DELETE`);
  assert.match(
    del,
    /\.rpc\(\s*\n?\s*["']clear_kpi_targets["']/,
    "the DELETE handler does not call clear_kpi_targets(); a direct table delete takes no period lock and no actuals guard",
  );
  assert.match(
    del,
    /moneyRpcFailure\(/,
    "the routine's 22023 refusal must be mapped to a status, or a refusal reaches the caller as a 500 with no reason",
  );
});

test("the KPI route's DELETE enforces admin/boss, the same list the database's policy allows", async () => {
  const src = code(await read(KPI_ROUTE));
  const del = src.slice(src.indexOf("export async function DELETE("));
  const list = del.match(/\[([^\]]*)\]\s*\.includes\(\s*profile\.role\s*\)/);
  assert.ok(list, "the DELETE handler no longer checks profile.role against a literal list");
  const roles = list[1].match(/["'`]([a-z_]+)["'`]/g).map((r) => r.replace(/["'`]/g, ""));
  assert.deepEqual(
    roles.slice().sort(),
    ["admin", "boss"],
    `the DELETE handler admits ${roles.join("/")}. The write goes out on the service-role client, which bypasses RLS, so this list is the only thing enforcing the rule, and the database's own DELETE policy on kpi_targets (20260701000000_non_core_tables_rls_fix.sql:227) is admin/boss. Measured: an operator's identical delete as authenticated removes 0 rows, and as service_role removes every one.`,
  );
});

test("the KPI settings UI saves through the route and never deletes a period behind it", async () => {
  const ui = code(await read(KPI_UI));
  assert.match(ui, /fetch\(\s*["'`]\/api\/kpi\/targets["'`]/, `${KPI_UI} does not POST to the KPI route`);
  assert.deepEqual(kpiTargetTableWrites(ui), [], `${KPI_UI} writes kpi_targets from the client`);
  assert.doesNotMatch(
    ui,
    /method:\s*["'`]DELETE["'`]/,
    "the save path must not clear the period as a separate request; replace_kpi_targets() does the delete and the insert in one transaction, and two requests can leave the period empty",
  );
});

/* ─── the reason the fix is load-bearing: the routines, from the migrations ─ */

test("clear_kpi_targets takes the same period lock and refuses to drop collected money", async () => {
  const sql = await read(CLEAR_MIGRATION);
  const routine = sql.slice(sql.indexOf("create or replace function public.clear_kpi_targets("));
  assert.ok(routine.length > 0, `${CLEAR_MIGRATION} does not define clear_kpi_targets`);
  const body = routine.slice(0, routine.indexOf("$$;"));

  // Byte-for-byte the pattern 20260816000000_l0_round4_definer_entry_boundary.sql
  // and 10_assert_release_contracts.sql apply to every SECURITY DEFINER routine in
  // public. Asserting it here means a body edit fails in `node --test` rather than
  // only in the PG17 replay, which is the slower of the two by minutes.
  assert.match(
    body,
    /(^|\n)[ \t]*begin[ \t]*\r?\n[ \t]*perform[ \t]+public\.assert_current_session_at_entry\(\);/,
    "the definer entry assertion must be the anchored first statement, or the round-4 catalog check fails",
  );
  assert.match(body, /\bsecurity definer\b/, "clear_kpi_targets() must be SECURITY DEFINER to reach the table under RLS");
  assert.match(
    body,
    /set search_path = pg_catalog, public, pg_temp/,
    "a definer routine without a pinned search_path is hijackable by a caller-created schema",
  );
  assert.match(
    body,
    /pg_advisory_xact_lock\(\s*v_lock_key\s*\)/,
    "clear_kpi_targets() must take the period advisory lock, which is the whole point of routing the delete",
  );
  assert.match(
    body,
    /hashtextextended\(\s*'public\.kpi_targets:'\s*\|\|\s*p_period\s*,\s*0\s*\)/,
    "the lock key must be the same expression replace_kpi_targets() uses, or the two paths do not serialize against each other",
  );
  assert.match(
    body,
    /coalesce\(actual_amount,\s*0\)\s*<>\s*0/,
    "clear_kpi_targets() must count rows holding collected money before deleting anything",
  );
  assert.match(
    body,
    /if v_holding > 0 then[\s\S]{0,400}?errcode = '22023'/,
    "a period holding collected money must be refused with 22023, the same code the save path's guard raises",
  );
  // The guard has to read under the lock, not before it, or the count goes stale.
  assert.ok(
    body.indexOf("pg_advisory_xact_lock") < body.indexOf("coalesce(actual_amount, 0) <> 0"),
    "the actuals count must be taken after the lock is held",
  );
  assert.ok(
    body.indexOf("if v_holding > 0 then") < body.indexOf("delete from public.kpi_targets"),
    "the guard must precede the delete",
  );

  // The grants: this is reachable from the service-role client only, exactly like
  // replace_kpi_targets. An execute grant to authenticated would hand the whole
  // capability to any signed-in session.
  assert.match(
    sql,
    /revoke all on function public\.clear_kpi_targets\(text, uuid\) from public, anon, authenticated;/,
    "clear_kpi_targets() must be revoked from public, anon and authenticated",
  );
  assert.match(
    sql,
    /grant execute on function public\.clear_kpi_targets\(text, uuid\) to service_role;/,
    "the route calls this on the service-role client, so service_role needs execute",
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.clear_kpi_targets\([^)]*\) to (authenticated|anon)\b/,
    "clear_kpi_targets() must not be granted to authenticated or anon",
  );
});

test("replace_kpi_targets still carries actuals forward — the claim the review made, pinned", async () => {
  const sql = await read(ROUND4);
  const routine = sql.slice(sql.indexOf("create or replace function public.replace_kpi_targets("));
  assert.ok(routine.length > 0, `${ROUND4} no longer defines replace_kpi_targets`);
  const body = routine.slice(0, routine.indexOf("$$;"));

  // It deletes and reinserts; that is fine, and it is why the carry-forward exists.
  assert.match(body, /delete from public\.kpi_targets\s+where period = p_period/, "the replace still deletes the period");
  assert.match(
    body,
    /coalesce\(prev\.actual_amount,\s*0\)/,
    "the reinsert must carry the previous actual_amount forward, or a target edit resets collected amounts to zero — the reproduction took 700.00 to 700.00 only because of this",
  );
  assert.match(
    body,
    /'target_type'[\s\S]{0,200}?is not distinct from/,
    "the carry-forward must match on (target_type, assigned_to) with NULL-safe equality, because assigned_to is nullable",
  );
  assert.match(
    body,
    /errcode = '22023'/,
    "dropping a pair that still holds collected money must be refused, not silently accepted",
  );
});

test("payment credit is pinned to the crediting salesperson, not the contract's current one", async () => {
  assert.match(
    await read(ROUND4),
    /add column if not exists credited_to uuid references public\.profiles \(id\)/,
    `${ROUND4} no longer adds payments.credited_to; without a persisted credit, a void debits whoever owns the contract at void time`,
  );

  const confirm = await lastDefinition("confirm_payment");
  assert.match(
    confirm.body,
    /credited_to\s*=\s*(coalesce\()?v_contract\.sales_id/,
    `${confirm.file} defines confirm_payment last and it no longer records who the collection was credited to at confirm time`,
  );

  const voided = await lastDefinition("void_payment");
  assert.match(
    voided.body,
    /coalesce\(v_payment\.credited_to,\s*v_contract\.sales_id\)/,
    `${voided.file} defines void_payment last and it no longer debits the recorded credit; falling back to the contract owner is correct only for rows confirmed before credited_to existed`,
  );
  assert.match(
    voided.body,
    /assigned_to = v_credited_to/,
    `${voided.file}: the actual_amount debit must target the credited salesperson's target row; measured, a reassignment then a void moved owner_C 100.00 -> 0.00 and left owner_E at 0.00`,
  );
});

test("every routine that writes actual_amount takes the period lock, in its last definition", async () => {
  // R3. The lock existed and covered the two routines that edit TARGETS; the two
  // that move the money wrote the same rows with no lock, so a confirmation
  // overlapping a target save of its own period was lost. Measured on PG 17.10 in
  // supabase/replay/19_concurrency_kpi_period.sh: without the lock a confirmed
  // 4321.00 left actual_amount at 0.00 against a ledger of 4321.00, and a void left
  // it at 4321.00 against a ledger of 0.00 — both reporting success. That gate is
  // the evidence; this test is what makes a later body edit fail in seconds instead
  // of in the replay, and it reads the LAST definition of each routine for the same
  // reason R3 existed at all.
  const KEY = /hashtextextended\(\s*'public\.kpi_targets:'/;
  for (const name of ["confirm_payment", "void_payment", "replace_kpi_targets", "clear_kpi_targets"]) {
    const { file, body } = await lastDefinition(name);
    if (!/public\.kpi_targets/.test(body)) continue; // not a writer any more; nothing to lock
    assert.match(
      body,
      /pg_advisory_xact_lock\(/,
      `${file}: ${name}() writes public.kpi_targets and takes no advisory lock`,
    );
    assert.match(body, KEY, `${file}: ${name}() locks some other key than the period's`);
    // Before the write, not after it: a lock taken afterwards serializes nothing.
    assert.ok(
      body.indexOf("pg_advisory_xact_lock") < body.search(/(update|delete from|insert into)\s+public\.kpi_targets/),
      `${file}: ${name}() writes public.kpi_targets before it takes the period lock`,
    );
  }
});
