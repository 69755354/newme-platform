/**
 * `contracts.first_payment_status` names the first installment of the schedule.
 *
 * Round-4 finding B2, second half. The forgery half is closed:
 * 20260817000000 §4 added the column to trg_guard_contracts_write's protected set
 * and src/app/api/contracts/route.ts answers 409 DERIVED_FIELD instead of writing
 * it. The staleness half was closed only for schedules that happen to number their
 * first installment 1.
 *
 * `contract_first_payment_status()` identified the first installment with
 * `where contract_id = p_contract_id and seq = 1`. assert_installment_schedule()
 * requires installment seqs to be positive and unique and does NOT require that 1
 * is among them, and src/app/api/contracts/route.ts validates exactly the same
 * three properties before it calls create_contract() — so a schedule numbered
 * 2, 3 is accepted end to end and has no `seq = 1` row for the derivation to
 * measure.
 *
 * Reproduced on an isolated PG17 with the floor schema, the fourteen branch
 * migrations and 05_seed_behaviour_fixtures.sql, acting as `authenticated` with
 * the claim shape GoTrue issues, in BOTH release modes:
 *
 *   create_contract(installments seq 2 = 40000.00, seq 3 = 60000.00)
 *                              -> 00000, installments_count 2
 *   confirm_payment + allocate_payment(seq-2 plan, 40000.00) as boss
 *                              -> 00000, plan status 'paid', allocated 40000.00
 *                                 of 40000.00, contracts.first_payment_status
 *                                 'unpaid', allocate_payment's own return
 *                                 first_payment_status 'unpaid'
 *   the same money on a seq 1, 2 schedule
 *                              -> 'paid'
 *
 * The stored column and the derivation agreed — on 'unpaid' — which is why the
 * release's own invariant assertion (b2-every-contract-agrees-with-the-derivation)
 * reported zero disagreeing contracts while the contract was reading a value the
 * ledger had already contradicted, permanently: no later confirmation, allocation
 * or void can move a column whose derivation matches no installment row, and the
 * guard now refuses the manual correction that used to be possible.
 *
 * The fix is one predicate in one function: the first installment is the lowest
 * seq present, ordered, not the literal 1. This file pins that, because the
 * function is `create or replace`d by a migration and a later carry-forward that
 * pasted the old body back would restore the finding silently.
 *
 * Scope note: whether a schedule SHOULD be allowed to start at seq 2 is finding
 * B4's question about assert_installment_schedule(), and is deliberately not
 * asserted here — this rule is about the derivation being right for the schedules
 * the system actually accepts.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

const MIGRATIONS = "supabase/migrations";
const FLOOR = "supabase/replay/01_floor_schema.sql";
const CONTRACTS_ROUTE = "src/app/api/contracts/route.ts";
const DERIVATION = "contract_first_payment_status";

/**
 * Source with its comments removed, because this rule is about what the SQL DOES.
 * The migration's §3 header quotes the broken statement verbatim so a reader can
 * see what was reproduced, and a scan that could not tell prose from code would
 * force that explanation to be deleted. Crude by design; it is only ever used to
 * answer "does this file still do X".
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** SQL line comments, which `code()` above does not touch. */
function sqlCode(src) {
  return code(src).replace(/^\s*--.*$/gm, "");
}

/**
 * Every `create or replace function ... <name> ...` body in a SQL file, as
 * {name, body}. The body is the text between the opening `as $$` and its closing
 * `$$`, which is how every routine in this repo is written.
 */
export function routineBodies(src, name) {
  const bodies = [];
  const head = new RegExp(
    String.raw`create\s+or\s+replace\s+function\s+(?:public\.)?(${name})\s*\(`,
    "gi",
  );
  let match;
  while ((match = head.exec(src)) !== null) {
    const open = src.indexOf("$$", match.index);
    if (open === -1) continue;
    const close = src.indexOf("$$", open + 2);
    if (close === -1) continue;
    bodies.push({ name: match[1], body: src.slice(open + 2, close) });
    head.lastIndex = close;
  }
  return bodies;
}

/**
 * Does this routine body pick the contract's first installment by asserting the
 * literal seq 1, rather than by ordering on seq? Returns the offending predicate,
 * or null. Written as a function and exercised against fixtures below rather than
 * inlined into an assertion, so the rule itself is testable — a detector that only
 * ever runs over clean files cannot be distinguished from one that matches
 * nothing.
 */
export function firstInstallmentIsHardcodedSeqOne(body) {
  const stripped = sqlCode(body);
  const selects = stripped.match(/select[\s\S]*?;/gi) ?? [];
  for (const statement of selects) {
    if (!/\binstallment_plans\b/.test(statement)) continue;
    // `seq = 1` (or `ip.seq=1`) used as a filter on the installment set.
    const literal = statement.match(/\b(?:\w+\.)?seq\s*=\s*1\b/);
    if (!literal) continue;
    // An ORDER BY on seq is the supported shape; a routine that both orders on seq
    // and mentions seq = 1 is not what this finding was.
    if (/order\s+by[\s\S]*?\bseq\b/i.test(statement)) continue;
    return literal[0];
  }
  return null;
}

/* ─── the detector, against fixtures ─────────────────────────────────────── */

test("the detector flags the exact body this finding replaced", () => {
  // Verbatim from the pre-fix contract_first_payment_status(), reindented.
  const broken = `
  select id, amount into v_plan_id, v_amount
    from public.installment_plans
   where contract_id = p_contract_id and seq = 1
   order by created_at asc, id asc
   limit 1;

  if v_plan_id is null then
    return 'unpaid';
  end if;
`;
  assert.equal(
    firstInstallmentIsHardcodedSeqOne(broken),
    "seq = 1",
    "the detector no longer recognises the body this finding replaced",
  );
});

test("the detector does not flag the shapes that are not this finding", () => {
  // Each of these is a shape this codebase legitimately contains. A detector that
  // flagged them would be turned off by the next person who hit it.
  const clean = [
    // 1. the fix: the first row of the schedule, ordered.
    `
  select id, amount into v_plan_id, v_amount
    from public.installment_plans
   where contract_id = p_contract_id
   order by seq asc, created_at asc, id asc
   limit 1;
`,
    // 2. ordering on seq AND naming seq 1, which is not the same mistake.
    `
  select id into v_plan
    from public.installment_plans
   where contract_id = p_contract_id and seq = 1
   order by seq asc
   limit 1;
`,
    // 3. seq 1 as a label, not as a selection — convert_quotation_to_contract()
    //    writes the first installment's Chinese description this way.
    `
  v_desc := case when v_seq = 1 then '首期款 (签约)' else '尾款' end;
  insert into public.installment_plans (contract_id, seq, amount, description)
  values (v_contract_id, v_seq, v_amount, v_desc);
`,
    // 4. an allocation recomputation, which selects by plan id and never by seq.
    `
  select coalesce(sum(pa.amount_allocated), 0) into v_plan_allocated
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
   where pa.plan_id = v_plan_id and p.confirmed = true and p.voided_at is null;
`,
    // 5. seq = 1 against a table that is not the installment schedule.
    `
  select id into v_step from public.contract_approvals
   where contract_id = p_contract_id and seq = 1;
`,
    // 6. the broken predicate quoted in an explanatory SQL comment, which must
    //    stay quotable verbatim.
    `
  -- Was: where contract_id = p_contract_id and seq = 1
  select id, amount into v_plan_id, v_amount
    from public.installment_plans
   where contract_id = p_contract_id
   order by seq asc, created_at asc, id asc
   limit 1;
`,
  ];
  for (const body of clean) {
    assert.equal(
      firstInstallmentIsHardcodedSeqOne(body),
      null,
      `the detector flagged a legitimate body:\n${body}`,
    );
  }
});

test("the body extractor finds the routine it is pointed at, and only that one", async () => {
  const src = `
create or replace function public.other_thing(p uuid) returns text language plpgsql as $$
begin return 'not this one'; end
$$;

create or replace function public.contract_first_payment_status(p_contract_id uuid)
returns text language plpgsql stable as $$
declare v uuid;
begin
  select id into v from public.installment_plans where contract_id = p_contract_id and seq = 1;
  return 'unpaid';
end
$$;
`;
  const bodies = routineBodies(src, DERIVATION);
  assert.equal(bodies.length, 1);
  assert.equal(firstInstallmentIsHardcodedSeqOne(bodies[0].body), "seq = 1");
});

/* ─── the rule, against the real files ───────────────────────────────────── */

/** Every migration that defines the derivation, in version order. */
async function derivationDefinitions() {
  const names = (await readdir(path.join(ROOT, MIGRATIONS)))
    .filter((name) => /^\d{14}_.*\.sql$/.test(name))
    .sort();
  const found = [];
  for (const name of names) {
    const bodies = routineBodies(await read(`${MIGRATIONS}/${name}`), DERIVATION);
    for (const routine of bodies) found.push({ file: `${MIGRATIONS}/${name}`, ...routine });
  }
  return found;
}

test("the derivation is defined, and no definition of it hardcodes seq 1", async () => {
  const definitions = await derivationDefinitions();
  assert.ok(
    definitions.length >= 1,
    `no migration defines ${DERIVATION}(); the column would have no single derivation`,
  );
  for (const definition of definitions) {
    const hit = firstInstallmentIsHardcodedSeqOne(definition.body);
    assert.equal(
      hit,
      null,
      `${definition.file} picks the first installment with \`${hit}\`: a schedule ` +
        `numbered 2, 3 — which assert_installment_schedule() and ${CONTRACTS_ROUTE} ` +
        `both accept — would have no first installment, and first_payment_status ` +
        `would read 'unpaid' however much of it was confirmed and allocated`,
    );
  }
});

test("the derivation orders the schedule instead of matching a number", async () => {
  const definitions = await derivationDefinitions();
  const latest = definitions.at(-1);
  const body = sqlCode(latest.body);
  assert.match(
    body,
    /order\s+by\s+seq\s+asc/i,
    `${latest.file} must take the first installment as the lowest seq present`,
  );
  assert.match(
    body,
    /limit\s+1/i,
    `${latest.file} must take exactly one installment as the first one`,
  );
  // The tie-breakers, so two rows with the same seq cannot make the answer depend
  // on scan order.
  assert.match(body, /order\s+by\s+seq\s+asc\s*,\s*created_at\s+asc\s*,\s*id\s+asc/i);
});

test("the three writers of the column all write what the derivation returns", async () => {
  const names = (await readdir(path.join(ROOT, MIGRATIONS)))
    .filter((name) => /^\d{14}_.*\.sql$/.test(name))
    .sort();
  // The newest definition of each writer wins, which is what the database ends up
  // holding after `db push`.
  const newest = new Map();
  for (const name of names) {
    const src = await read(`${MIGRATIONS}/${name}`);
    for (const writer of ["confirm_payment", "allocate_payment", "void_payment"]) {
      for (const routine of routineBodies(src, writer)) {
        newest.set(writer, { file: `${MIGRATIONS}/${name}`, body: routine.body });
      }
    }
  }
  for (const writer of ["confirm_payment", "allocate_payment", "void_payment"]) {
    const routine = newest.get(writer);
    assert.ok(routine, `${writer}() is not defined by any migration`);
    const body = sqlCode(routine.body);
    assert.ok(
      /first_payment_status\s*=/.test(body),
      `${routine.file}: ${writer}() no longer writes first_payment_status`,
    );
    assert.ok(
      new RegExp(String.raw`${DERIVATION}\s*\(`).test(body),
      `${routine.file}: ${writer}() writes first_payment_status without calling ` +
        `${DERIVATION}(), so it can write an answer the ledger does not support`,
    );
  }
});

test("the release still refuses the column from a session, and the route still refuses the field", async () => {
  // The forgery half of B2. Asserted here so a change to the derivation cannot be
  // mistaken for the whole finding being closed.
  const guardMigration = (await readdir(path.join(ROOT, MIGRATIONS)))
    .filter((name) => /^\d{14}_.*\.sql$/.test(name))
    .sort()
    .reverse()
    .find(() => true);
  assert.ok(guardMigration, "there are no migrations to read");

  const guards = [];
  for (const name of (await readdir(path.join(ROOT, MIGRATIONS)))
    .filter((name) => /^\d{14}_.*\.sql$/.test(name))
    .sort()) {
    for (const routine of routineBodies(await read(`${MIGRATIONS}/${name}`), "guard_contracts_write")) {
      guards.push({ file: `${MIGRATIONS}/${name}`, body: routine.body });
    }
  }
  const guard = guards.at(-1);
  assert.ok(guard, "guard_contracts_write() is not defined by any migration");
  assert.match(
    sqlCode(guard.body),
    /new\.first_payment_status\s+is\s+distinct\s+from\s+old\.first_payment_status/i,
    `${guard.file}: guard_contracts_write() no longer protects first_payment_status`,
  );

  const route = code(await read(CONTRACTS_ROUTE));
  assert.doesNotMatch(
    route,
    /updates\.first_payment_status\s*=/,
    `${CONTRACTS_ROUTE} writes first_payment_status again`,
  );
  assert.match(
    route,
    /DERIVED_FIELD/,
    `${CONTRACTS_ROUTE} must refuse a first_payment_status body rather than ignore it`,
  );
});

test("the replay floor still carries the un-remediated shape, so the assertions are not vacuous", async () => {
  // The floor is the previous release. It writes first_payment_status from a seq 1
  // lookup of its own and must keep doing so: if the floor were quietly fixed,
  // every B2 assertion in supabase/replay would pass without its migration.
  const floor = await read(FLOOR);
  assert.match(
    sqlCode(floor),
    /seq\s*=\s*1/i,
    `${FLOOR} no longer contains the pre-fix first-installment lookup`,
  );
  assert.equal(
    routineBodies(floor, DERIVATION).length,
    0,
    `${FLOOR} must not define ${DERIVATION}(); it is what the release adds`,
  );
});
