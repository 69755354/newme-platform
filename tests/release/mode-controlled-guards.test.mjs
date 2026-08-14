// ============================================================================
// Contract test: the set of mode-controlled guards is derived, not remembered
// ============================================================================
// Round-4 review C4-2: "strict posture verification must check all 7
// mode-controlled guards and the KPI RPCs affected by rollback."
//
// The defect underneath that sentence was not a missing check, it was a
// hand-maintained list that three separate artifacts each copied and none
// re-derived:
//
//   * infra/release/release-manifest.json — the posture predicates for both
//     phases, which are what `db-phase-push.mjs --verify-only` evaluates;
//   * supabase/migrations/recontract_money_direct_write_contract_phase.sql — the
//     `v_guards` array, which is what refuses to declare 'strict' over a database
//     that cannot enforce it;
//   * supabase/replay/30_assert_post_recontract.sql — the post-round-trip gate.
//
// All three named the same four triggers: contracts, payments, quotations and
// contract transition. That list was wrong in BOTH directions at once.
// trg_guard_contract_transition does not read the release mode (it refuses an
// impossible status change in either mode, which is why it can never fail a
// mode check), and trg_guard_installment_plans_write,
// trg_guard_contract_approvals_write and trg_guard_payment_allocations_write have
// read the mode since 20260814000000 rewrote them to stand down during the
// compatibility window. Because one counted name could not fail, `count(*) = 4`
// was still reached with three real guards dropped — measured on PG 17.10:
// `--verify-only --phase deferred_contract` exited 0 with three of three posture
// predicates OK.
//
// A fourth copy of the same list would fix nothing. So this file derives the set
// from the migrations — every trigger still bound to a function whose shipped body
// consults public.money_direct_write_is_blocked() — and requires the three
// artifacts to name exactly that. A future migration that gates a new table fails
// here until all three are updated, and one that stops gating a table fails here
// until all three drop it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const CLI_MIGRATION = /^[0-9]{14}_.*\.sql$/;

const GATE = "money_direct_write_is_blocked";
/** The gate function itself: it reads the mode, it is not a guard. */
const GATE_FUNCTION = "money_direct_write_is_blocked";
/** Not mode-gated, and checked separately by every artifact. See the header. */
const TRANSITION_GUARD = ["trg_guard_contract_transition", "contracts"];

const read = (...parts) => readFileSync(path.join(ROOT, ...parts), "utf8");
const pair = ([tgname, relname]) => `${tgname} on public.${relname}`;
const sorted = (pairs) => [...pairs].map(pair).sort();

// ---------------------------------------------------------------------------
// Deriving the truth: the migrations, in the order Postgres applies them.
// ---------------------------------------------------------------------------

/**
 * Every `create [or replace] function public.NAME(...) ... $tag$ body $tag$`, in
 * source order, as {name, body}. The dollar-quote tag is read from the file
 * rather than assumed, because the tree uses `$$`, `$fn$` and `$do$`.
 */
function functionDefinitions(sql) {
  const found = [];
  const header = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
  let match;
  while ((match = header.exec(sql)) !== null) {
    const opener = /\$([a-z0-9_]*)\$/i.exec(sql.slice(match.index));
    if (!opener) continue;
    const openAt = match.index + opener.index + opener[0].length;
    const closeAt = sql.indexOf(opener[0], openAt);
    if (closeAt === -1) continue;
    found.push({ name: match[1].toLowerCase(), body: sql.slice(openAt, closeAt) });
    header.lastIndex = closeAt;
  }
  return found;
}

/** `create trigger NAME ... on public.TABLE ... execute function public.FN()`. */
const CREATE_TRIGGER =
  /create\s+trigger\s+([a-z0-9_]+)\b[\s\S]{0,400}?\bon\s+(?:public\.)?([a-z0-9_]+)\b[\s\S]{0,400}?\bexecute\s+(?:function|procedure)\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
/** `drop trigger [if exists] NAME on public.TABLE`. */
const DROP_TRIGGER = /drop\s+trigger\s+(?:if\s+exists\s+)?([a-z0-9_]+)\s+on\s+(?:public\.)?([a-z0-9_]+)/gi;

/**
 * Replays the migrations far enough to answer one question: which (trigger,
 * table) pairs exist at the end, and what function does each call. Creates and
 * drops are interleaved in source order within a file and across files in name
 * order, which is the order the CLI and scripts/db-phase-push.mjs both apply.
 */
function deriveGuards() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => CLI_MIGRATION.test(f)).sort();
  const gated = new Set();
  /** function name -> the exact final body stored as pg_proc.prosrc */
  const functionBodies = new Map();
  /** key `tgname|relname` → function name */
  const triggers = new Map();

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

    // A function's LAST definition wins, in both directions: one that starts
    // consulting the gate joins the set, one that stops leaves it.
    for (const { name, body } of functionDefinitions(sql)) {
      functionBodies.set(name, body);
      if (name === GATE_FUNCTION) continue;
      if (body.includes(GATE)) gated.add(name);
      else gated.delete(name);
    }

    const events = [];
    for (const m of sql.matchAll(CREATE_TRIGGER)) {
      events.push({ at: m.index, kind: "create", key: `${m[1].toLowerCase()}|${m[2].toLowerCase()}`, fn: m[3].toLowerCase() });
    }
    for (const m of sql.matchAll(DROP_TRIGGER)) {
      events.push({ at: m.index, kind: "drop", key: `${m[1].toLowerCase()}|${m[2].toLowerCase()}` });
    }
    events.sort((a, b) => a.at - b.at);
    for (const event of events) {
      if (event.kind === "drop") triggers.delete(event.key);
      else triggers.set(event.key, event.fn);
    }
  }

  const guards = [];
  for (const [key, fn] of triggers) {
    if (!gated.has(fn)) continue;
    const [tgname, relname] = key.split("|");
    guards.push([tgname, relname]);
  }
  return { functionBodies, guards, gated, triggers };
}

const derived = deriveGuards();

// ---------------------------------------------------------------------------
// Reading the three artifacts.
// ---------------------------------------------------------------------------

/** `('trg_x','table',...)` — the shape a SQL `values` list uses. */
const SQL_PAIR = /\(\s*'(trg_[a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'(?:\s*,\s*'[^']+'){0,2}\s*\)/gi;
/** `['trg_x', 'table', ...]` — the shape the plpgsql `text[][]` literal uses. */
const PLPGSQL_PAIR = /\[\s*'(trg_[a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'(?:\s*,\s*'[^']+'){0,2}\s*\]/gi;
/** Either artifact's `(trigger, table, function[, digest])` declaration. */
const GUARD_TRIPLE = /[\[(]\s*'(trg_[a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*,\s*'(?:public\.)?([a-z0-9_]+)(?:\(\))?'(?:\s*,\s*'[0-9a-f]{64}')?\s*[\])]/gi;
/** The production declaration, including the exact pg_proc.prosrc SHA-256. */
const GUARD_QUAD = /[\[(]\s*'(trg_[a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*,\s*'(?:public\.)?([a-z0-9_]+)(?:\(\))?'\s*,\s*'([0-9a-f]{64})'\s*[\])]/gi;

const pairsIn = (text, re) => [...text.matchAll(re)].map((m) => [m[1].toLowerCase(), m[2].toLowerCase()]);
const unique = (pairs) => [...new Map(pairs.map((p) => [pair(p), p])).values()];
const triplesIn = (text) => [...text.matchAll(GUARD_TRIPLE)]
  .map((m) => [m[1].toLowerCase(), m[2].toLowerCase(), m[3].toLowerCase()]);
const sortedTriples = (triples) => [...triples]
  .map(([trigger, table, fn]) => `${trigger} on public.${table} -> public.${fn}()`)
  .sort();
const quadsIn = (text) => [...text.matchAll(GUARD_QUAD)]
  .map((m) => [m[1].toLowerCase(), m[2].toLowerCase(), m[3].toLowerCase(), m[4].toLowerCase()]);
const sortedQuads = (quads) => [...quads]
  .map(([trigger, table, fn, digest]) => `${trigger} on public.${table} -> public.${fn}() sha256:${digest}`)
  .sort();
const sha256 = (body) => createHash("sha256").update(body, "utf8").digest("hex");

const manifest = JSON.parse(read("infra", "release", "release-manifest.json"));
const predicate = (phase, name) => {
  const found = manifest.posture?.[phase]?.predicates?.find((p) => p.name === name);
  assert.ok(found, `manifest posture.${phase} has no predicate named ${name}`);
  return found;
};

const RECONTRACT = read("supabase", "migrations", "recontract_money_direct_write_contract_phase.sql");
const POST_RECONTRACT = read("supabase", "replay", "30_assert_post_recontract.sql");
const POST_ROLLBACK = read("supabase", "replay", "20_assert_post_rollback.sql");

const DECLARATIONS = [
  {
    what: "the required_for_app posture predicate",
    pairs: pairsIn(predicate("required_for_app", "mode-controlled-guards-match-the-declaration").sql, SQL_PAIR),
  },
  {
    what: "the deferred_contract posture predicate",
    pairs: pairsIn(predicate("deferred_contract", "strict-mode-controlled-guards-match-the-declaration").sql, SQL_PAIR),
  },
  {
    what: "the recontract companion's v_guards",
    pairs: pairsIn(RECONTRACT.slice(RECONTRACT.indexOf("v_guards")), PLPGSQL_PAIR),
  },
  {
    // Two `values` lists, one per direction; `unique` collapses them, and the
    // "both directions agree" test below proves they were identical.
    what: "30_assert_post_recontract.sql",
    pairs: unique(pairsIn(POST_RECONTRACT, SQL_PAIR)),
  },
];

const FUNCTION_DECLARATIONS = [
  {
    what: "the required_for_app posture predicate",
    triples: triplesIn(predicate("required_for_app", "mode-controlled-guards-match-the-declaration").sql),
  },
  {
    what: "the deferred_contract posture predicate",
    triples: triplesIn(predicate("deferred_contract", "strict-mode-controlled-guards-match-the-declaration").sql),
  },
  {
    what: "the recontract companion's v_guards",
    triples: triplesIn(RECONTRACT.slice(RECONTRACT.indexOf("v_guards"))),
  },
  {
    what: "30_assert_post_recontract.sql",
    triples: [...new Map(
      triplesIn(POST_RECONTRACT).map((triple) => [`${triple[0]}|${triple[1]}`, triple]),
    ).values()],
  },
];

const BODY_DECLARATIONS = [
  {
    what: "the required_for_app posture predicate",
    quads: quadsIn(predicate("required_for_app", "mode-controlled-guards-match-the-declaration").sql),
  },
  {
    what: "the deferred_contract posture predicate",
    quads: quadsIn(predicate("deferred_contract", "strict-mode-controlled-guards-match-the-declaration").sql),
  },
  {
    what: "the recontract companion's v_guards",
    quads: quadsIn(RECONTRACT.slice(RECONTRACT.indexOf("v_guards"))),
  },
  {
    what: "30_assert_post_recontract.sql",
    quads: [...new Map(
      quadsIn(POST_RECONTRACT).map((quad) => [`${quad[0]}|${quad[1]}`, quad]),
    ).values()],
  },
];

// ---------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------

test("the migrations gate exactly six (trigger, table) pairs on the release mode", () => {
  // Stated as well as derived. If a migration legitimately changes this, the
  // number here is the one line that has to be edited on purpose, and the review
  // question it forces is "which table just started or stopped being gated".
  assert.deepEqual(sorted(derived.guards), [
    "trg_guard_contract_approvals_write on public.contract_approvals",
    "trg_guard_contracts_write on public.contracts",
    "trg_guard_installment_plans_write on public.installment_plans",
    "trg_guard_payment_allocations_write on public.payment_allocations",
    "trg_guard_payments_write on public.payments",
    "trg_guard_quotations_write on public.quotations",
  ]);

  // Five functions, six triggers: guard_definer_only_write() backs two of them
  // under two different names, which is the whole reason the artifacts declare
  // (trigger, table) pairs instead of trigger names.
  const backing = new Set(derived.guards.map(([tgname, relname]) => derived.triggers.get(`${tgname}|${relname}`)));
  assert.equal(backing.size, 5);
  assert.ok(backing.has("guard_definer_only_write"), [...backing].join(", "));
});

test("the transition guard is not mode-gated, and is not in the derived set", () => {
  // The specific mistake this file exists to prevent from recurring: counting a
  // trigger that cannot fail a mode check makes the count pass while real guards
  // are missing.
  assert.ok(!sorted(derived.guards).includes(pair(TRANSITION_GUARD)));
  assert.ok(derived.triggers.has(TRANSITION_GUARD.join("|")), "the transition guard should still exist");
  assert.ok(!derived.gated.has(derived.triggers.get(TRANSITION_GUARD.join("|"))));
});

for (const { what, pairs } of DECLARATIONS) {
  test(`${what} names exactly the derived set`, () => {
    assert.deepEqual(sorted(pairs), sorted(derived.guards));
  });

  test(`${what} does not count the transition guard among the mode-gated set`, () => {
    assert.ok(!sorted(pairs).includes(pair(TRANSITION_GUARD)), what);
  });
}

const derivedTriples = derived.guards.map(([trigger, table]) => [
  trigger,
  table,
  derived.triggers.get(`${trigger}|${table}`),
]);

const derivedQuads = derivedTriples.map(([trigger, table, fn]) => {
  const body = derived.functionBodies.get(fn);
  assert.equal(typeof body, "string", `no final migration body found for public.${fn}()`);
  return [trigger, table, fn, sha256(body)];
});

for (const { what, triples } of FUNCTION_DECLARATIONS) {
  test(`${what} binds every guard to the derived trigger function`, () => {
    assert.deepEqual(sortedTriples(triples), sortedTriples(derivedTriples));
  });
}

for (const { what, quads } of BODY_DECLARATIONS) {
  test(`${what} pins every guard to the exact shipped function body`, () => {
    assert.deepEqual(sortedQuads(quads), sortedQuads(derivedQuads));
  });
}

test("every artifact still checks the transition guard, separately and by name", () => {
  // Not counted is not the same as not checked. It is part of what makes a money
  // write safe; it just is not evidence about the release mode.
  for (const [what, text] of [
    ["the required_for_app posture predicate", predicate("required_for_app", "transition-guard-is-installed").sql],
    ["the deferred_contract posture predicate", predicate("deferred_contract", "strict-transition-guard-is-installed").sql],
    ["the recontract companion", RECONTRACT],
    ["30_assert_post_recontract.sql", POST_RECONTRACT],
  ]) {
    assert.ok(text.includes(TRANSITION_GUARD[0]), `${what} no longer checks ${TRANSITION_GUARD[0]}`);
  }
});

test("30_assert_post_recontract.sql checks the set in both directions", () => {
  // One `values` list asserts the six are present; the other asserts no
  // undeclared mode-gated trigger exists. Without the second, a new gated table
  // is silently unverified — which is half of how the old four-name list survived.
  const lists = [...POST_RECONTRACT.matchAll(/values\s*\(\s*'trg_/gi)];
  assert.equal(lists.length, 2, "expected one values list per direction");
  assert.match(POST_RECONTRACT, /'recontract-the-six-mode-gated-guards-are-still-enabled'/);
  assert.match(POST_RECONTRACT, /'recontract-no-undeclared-mode-gated-guard-exists'/);
  assert.match(POST_RECONTRACT, /pg_catalog\.sha256\(pg_catalog\.convert_to\(p\.prosrc,\s*'UTF8'\)\)/);
  assert.match(POST_RECONTRACT, /=\s*d\.prosrc_sha256/);
});

test("the posture predicates check the set in both directions too", () => {
  // A `full join` with `count(*) = count(d.tgname) and count(*) = count(live.tgname)`
  // is set equality: an undeclared live guard leaves d.tgname null and a declared
  // guard that is gone leaves live.tgname null. A lookup that only counts matches
  // cannot see the first case, and that is the shape the defect had.
  for (const [phase, name] of [
    ["required_for_app", "mode-controlled-guards-match-the-declaration"],
    ["deferred_contract", "strict-mode-controlled-guards-match-the-declaration"],
  ]) {
    const { sql, expect } = predicate(phase, name);
    assert.equal(expect, true);
    assert.match(sql, /full\s+join/i, `${phase}: not a set comparison`);
    assert.match(sql, /count\(\*\)\s*=\s*count\(d\.tgname\)/i, `${phase}: a dropped guard would not fail`);
    assert.match(sql, /count\(\*\)\s*=\s*count\(live\.tgname\)/i, `${phase}: an undeclared guard would not fail`);
    assert.match(sql, /count\(\*\)\s*>\s*0/i, `${phase}: zero rows must not read as agreement`);
    assert.match(sql, /tgenabled\s*=\s*'O'/i, `${phase}: a disabled guard refuses nothing`);
    assert.match(sql, /p\.prokind\s*=\s*'f'/i, `${phase}: pg_get_functiondef throws for aggregates`);
    assert.match(sql, /not\s+p\.prosecdef/i, `${phase}: a definer guard would run under the wrong identity`);
    assert.match(sql, /live\.proname\s*=\s*d\.proname/i, `${phase}: a rebound trigger would still pass`);
    assert.match(sql, /live\.prosrc_sha256\s*=\s*d\.prosrc_sha256/i, `${phase}: a drifted function body would still pass`);
    assert.match(sql, /pg_catalog\.sha256\(pg_catalog\.convert_to\(p\.prosrc,\s*'UTF8'\)\)/i, `${phase}: body digest is not computed from pg_proc.prosrc`);
  }
});

test("the re-contract companion validates guard function identity before writing strict", () => {
  const write = RECONTRACT.indexOf("insert into public.money_release_mode");
  const checks = RECONTRACT.slice(RECONTRACT.indexOf("for i in 1 .. array_length(v_guards, 1) loop"), write);
  assert.ok(write !== -1, "the companion no longer writes the release mode");
  assert.match(checks, /g\.tgfoid\s*=\s*to_regprocedure\(v_guards\[i\]\[3\]\)/i);
  assert.match(checks, /pg_catalog\.sha256\(pg_catalog\.convert_to\(p\.prosrc,\s*'UTF8'\)\)/i);
  assert.match(checks, /=\s*v_guards\[i\]\[4\]/i);
  assert.match(checks, /not\s+p\.prosecdef/i);
});

test("both phases verify the KPI routines the rollback path can remove", () => {
  // rollback_l0_20260811.sql reverts 20260811100500 by dropping
  // public.replace_kpi_targets(text, jsonb, uuid). Nothing in the forward
  // direction puts it back — a recorded migration is never applied again, and the
  // re-contract companion touches one row in one table by charter — so the mode
  // being 'strict' is not evidence that the KPI save path exists. It is verified
  // in BOTH phases for that reason.
  for (const [phase, prefix] of [["required_for_app", ""], ["deferred_contract", "strict-"]]) {
    for (const suffix of ["kpi-write-routines-are-installed", "kpi-write-routines-are-server-only", "kpi-routines-share-the-period-lock"]) {
      const { sql, expect } = predicate(phase, `${prefix}${suffix}`);
      assert.equal(expect, true);
      assert.match(sql, /replace_kpi_targets\(text, jsonb, uuid\)/, `${phase}/${suffix}`);
      assert.match(sql, /clear_kpi_targets\(text, uuid\)/, `${phase}/${suffix}`);
      // count(*) = 2 over to_regprocedure() is the presence test: an absent
      // routine yields NULL, which matches no row, so the aggregate answers false
      // instead of returning no row at all.
      assert.match(sql, /count\(\*\)\s*=\s*2/i, `${phase}/${suffix}: not fail-closed on an absent routine`);
    }
  }
});

test("both phases derive the KPI period-lock check from bodies, not from a list of names", () => {
  // R3. The defect this closes is a writer nobody added to the list:
  // confirm_payment() and void_payment() move money into and out of
  // kpi_targets.actual_amount and took no lock, while the two routines that edit
  // the targets held one on the same key. A predicate that named four routines
  // would have been just as true of the broken database as of the fixed one — the
  // named routines were never the problem. So this predicate starts from the
  // bodies: every function in `public` whose body writes public.kpi_targets, and
  // all of them must take the period lock. A fifth writer added later without it
  // fails the phase verification without anyone remembering to extend a list.
  const WRITER_PATTERN =
    /'\(update\|delete\[\[:space:\]\]\+from\|insert\[\[:space:\]\]\+into\)\[\[:space:\]\]\+public\[\.\]kpi_targets'/;
  const LOCK_MIGRATION = read("supabase", "migrations", "20260817160000_kpi_period_lock_covers_money_writers.sql");

  for (const [phase, prefix] of [["required_for_app", ""], ["deferred_contract", "strict-"]]) {
    const { sql, expect } = predicate(phase, `${prefix}kpi-actuals-writers-take-the-period-lock`);
    assert.equal(expect, true);
    assert.match(sql, WRITER_PATTERN, `${phase}: the writer set is not derived from bodies`);
    // >= 4 rather than = 4: the four known writers must all be there, and a fifth
    // is welcome as long as it locks. Zero rows would make bool_and() null, so the
    // count is what keeps an empty result from reading as agreement.
    assert.match(sql, /count\(\*\)\s*>=\s*4/i, `${phase}: fewer than four writers would still pass`);
    assert.match(sql, /like\s+'%pg_advisory_xact_lock\(%'/i, `${phase}: does not require a lock at all`);
    // The key, not just any advisory lock: a routine locking some other key would
    // otherwise satisfy this.
    assert.match(sql, /hashtextextended\(''public\.kpi_targets:''/, `${phase}: any advisory key would pass`);
    assert.match(sql, /p\.prokind\s*=\s*'f'/i, `${phase}: pg_get_functiondef throws for aggregates`);
    assert.match(sql, /n\.nspname\s*=\s*'public'/i, `${phase}: unscoped, so an extension function could fail it`);
    // Derived means derived. Naming a routine here would put the list back.
    for (const name of ["confirm_payment", "void_payment", "replace_kpi_targets", "clear_kpi_targets"]) {
      assert.ok(!sql.includes(name), `${phase}: names ${name} instead of deriving the set`);
    }
  }

  // The migration asserts the same sentence at apply time, in the same transaction
  // as the two replacements. Both copies must be the same pattern, or one of them
  // is checking a different set than the other claims to.
  assert.match(LOCK_MIGRATION, WRITER_PATTERN, "the migration's self-check pattern has drifted from the posture predicate");
  assert.match(LOCK_MIGRATION, /if v_writers < 4 then/);
  assert.match(LOCK_MIGRATION, /write public\.kpi_targets without taking the period lock/);
});

test("the re-contract companion refuses to declare strict without the KPI routines", () => {
  const body = RECONTRACT.slice(RECONTRACT.indexOf("v_routines"));
  assert.match(body, /'public\.replace_kpi_targets\(text, jsonb, uuid\)'/);
  assert.match(body, /'public\.clear_kpi_targets\(text, uuid\)'/);
  assert.match(body, /to_regprocedure\(v_routine\) is null/);
  assert.match(body, /has_function_privilege\('service_role', p\.oid, 'execute'\)/);
  assert.match(body, /not has_function_privilege\('authenticated', p\.oid, 'execute'\)/);
  assert.match(body, /not has_function_privilege\('anon', p\.oid, 'execute'\)/);
  // The refusal, not a notice: a companion that warned and continued would still
  // leave a database claiming a posture it cannot enforce.
  assert.match(RECONTRACT, /raise exception 'refusing to declare the strict posture/);
});

test("the rollback companion no longer drops the round-4 KPI definition", () => {
  const KPI_ROLLBACK = read("supabase", "migrations", "rollback_l0_20260811.sql");
  // No top-level drop — every one of this file's own statements is written at
  // column 0, so an indented one is inside the `do` block by construction.
  assert.ok(
    !/^drop\s+function/im.test(KPI_ROLLBACK),
    "the unconditional drop is back at the top level",
  );
  // Exactly one drop, and it is downstream of the discriminator and of the
  // early `return` that fires when the discriminator matches. The discriminator
  // is the round-4 session boundary rather than the migration ledger, because
  // supabase_migrations is not initialised on a replay database the phase tool
  // did not build.
  const drops = [...KPI_ROLLBACK.matchAll(/drop\s+function[^;]*replace_kpi_targets/gi)];
  assert.equal(drops.length, 1, "expected exactly one drop of replace_kpi_targets");
  const discriminator = KPI_ROLLBACK.indexOf("like '%assert_current_session_at_entry%'");
  assert.ok(discriminator !== -1, "the round-4 discriminator is gone");
  assert.ok(discriminator < drops[0].index, "the drop is not guarded by the discriminator");
  assert.match(KPI_ROLLBACK.slice(discriminator, drops[0].index), /\breturn;/, "the guard falls through to the drop");
  assert.match(KPI_ROLLBACK, /NOT dropping it/);

  // And the post-rollback gate measures the inverted expectation, so this cannot
  // silently revert: the old witness required the function to be ABSENT.
  assert.match(
    POST_ROLLBACK,
    /to_regprocedure\('public\.replace_kpi_targets\(text, jsonb, uuid\)'\) is not null, 'kpi-post-rollback-round4-replace-kpi-targets-survives'/,
  );
  assert.ok(
    !POST_ROLLBACK.includes("rollback-actually-executed-kpi-function-dropped"),
    "the post-rollback file still expects the function to be dropped",
  );
  // Which means the "did the rollback run at all" witness has to be something
  // else, or the file could be measuring the forward state.
  assert.match(POST_ROLLBACK, /public\.money_direct_write_mode\(\) = 'compat', 'rollback-actually-executed-release-mode-is-compat'/);
});

test("each assertion file's ASSERT_TOTAL equals the assertions it makes", () => {
  // The two replay files self-check this at runtime, and scripts/replay-migrations.sh
  // cross-checks the observed ASSERT_OK count against the declared total. Doing it
  // statically as well means a stale count after an edit like this one fails
  // `npm test` rather than only MODE=branch, which needs Docker and a database.
  //
  // These two files call exactly one helper, pg_temp.assert, once per assertion and
  // never inside a loop, so the call sites minus its own definition ARE the total.
  // A conditionally-executed assertion would also break the equality; that one is
  // left to the runtime self-check, which counts what actually ran.
  // 10_assert_release_contracts.sql is deliberately not checked this way: it has a
  // second helper (pg_temp.assert_eval) that asserts through the first, so its
  // call-site count and its total are legitimately different numbers.
  for (const [file, text] of [
    ["supabase/replay/20_assert_post_rollback.sql", POST_ROLLBACK],
    ["supabase/replay/30_assert_post_recontract.sql", POST_RECONTRACT],
  ]) {
    const declared = /^-- ASSERT_TOTAL: ([0-9]+)$/m.exec(text);
    assert.ok(declared, `${file} does not declare ASSERT_TOTAL`);
    assert.match(text, new RegExp(`total <> ${declared[1]}\\b`), `${file}: the runtime self-check disagrees with ASSERT_TOTAL`);
    assert.equal(text.match(/create or replace function pg_temp\.assert\(/g)?.length, 1, `${file}: one helper definition expected`);
    for (const [body] of text.matchAll(/\bloop\b[\s\S]*?\bend\s+loop\b/gi)) {
      assert.ok(!body.includes("pg_temp.assert("), `${file}: a looped assertion would break this count`);
    }
    const callSites = (text.match(/pg_temp\.assert\(/g) ?? []).length - 1;
    assert.equal(
      callSites,
      Number(declared[1]),
      `${file}: ${callSites} assertion call sites but ASSERT_TOTAL says ${declared[1]}`,
    );
  }
});
