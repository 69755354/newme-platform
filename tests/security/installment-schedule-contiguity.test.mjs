/**
 * An installment schedule has to be numbered 1..N.
 *
 * Round-4 finding B4, residual half. 20260817000000_l0_round4_money_and_business_integrity.sql
 * §7 added public.assert_installment_schedule() and closed most of the finding:
 * the schedule must be a non-empty array, every amount positive, every seq
 * positive and used at most once, a supplied due_date a real date, and the
 * amounts must total the subject exactly. What it did not establish is that the
 * positions run from 1 to N. Unique and positive is a weaker property, and the
 * difference is a whole missing installment.
 *
 * Reproduced on an isolated PG17 (00_platform_bootstrap + 01_floor_schema + the
 * 14 branch migrations + 05_seed_behaviour_fixtures), acting as `authenticated`
 * with the claim shape GoTrue issues, in both release modes — create_contract()
 * is SECURITY DEFINER, so money_release_mode changes nothing here:
 *
 *   installments [{seq:1,60},{seq:3,40}]    compat 00000 / strict 00000
 *                                           → 1 contract 100.00, 2 plans, seqs {1,3}
 *   installments [{seq:2,100}]              compat 00000 / strict 00000
 *                                           → 1 contract 100.00, 1 plan,  seqs {2}
 *   installments [{seq:1,50},{seq:9999,50}] compat 00000 / strict 00000
 *                                           → 1 contract 100.00, 2 plans, seqs {1,9999}
 *
 * Each of those totals correctly and each was accepted. The browser form cannot
 * produce one — src/app/(dashboard)/contracts/new/page.tsx always emits
 * `seq: i + 1` — but `seq` reaches the routine straight from the POST body, so the
 * form is not the only client of this route.
 *
 * The closure is in the database, in the routine that owns the write:
 * assert_installment_schedule() is called by create_contract() and by
 * convert_quotation_to_contract() before either writes anything. This file guards
 * what a database cannot see for itself: that the newest definition of that
 * validator still carries the assertion, that it is still called before the first
 * write, and that the route which mirrors it for message quality mirrors this part
 * too.
 *
 * Scope note. src/app/api/quotations/[id]/convert/route.ts also pre-validates a
 * schedule and also refuses a duplicate position without checking contiguity. It
 * is deliberately not in this rule. The invariant itself is closed for that path
 * by the shared validator; what differs is only which side names the offending
 * field first, and that route belongs to findings B5/B10. A test that quietly
 * widened would fail for a reason it was not written to catch.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

const CONTRACTS_ROUTE = "src/app/api/contracts/route.ts";
const NEW_CONTRACT_PAGE = "src/app/(dashboard)/contracts/new/page.tsx";
const MIGRATIONS = "supabase/migrations";
const VALIDATOR_SIGNATURE = "create or replace function public.assert_installment_schedule(";

/**
 * TypeScript with its comments removed, because these rules are about what the
 * code DOES. The route explains in prose which shapes it refuses, and a scan that
 * could not tell prose from code would be satisfied by the explanation. Crude by
 * design (a `//` inside a string literal is stripped too); only ever used to
 * answer "does this file still do X".
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * The same, for SQL. The migration that introduced the validator quotes the
 * reproduction in its header, including the schedules it now refuses, so a scan
 * of the whole file would match the record of the fix rather than the fix.
 */
function sqlCode(src) {
  return src.replace(/--[^\n]*/g, " ");
}

/* ─── the detector ───────────────────────────────────────────────────────── */

/** A refusal that names a position used twice — the check the finding had. */
const REFUSES_DUPLICATE_SEQ = /appears\s+(?:more\s+than\s+once|twice)/i;
/** A maximum is taken … */
const TAKES_A_MAXIMUM = /\bmax\s*\(/i;
/** … and compared against a count or a length. That pair is the 1..N assertion. */
const COMPARED_TO_A_COUNT = /(?:<>|!==?)\s*[A-Za-z_$][\w$.]*(?:count|length)\b/i;

/**
 * True when `src` validates installment positions well enough to refuse a
 * DUPLICATE one but never establishes that they run 1..N — the exact gap this
 * finding is. Written as an exported function and exercised against fixtures
 * below rather than inlined into an assertion, so the rule itself is testable: a
 * detector that only ever runs over closed files cannot be told apart from one
 * that matches nothing.
 *
 * Deliberately narrow on both sides. It says nothing about sources that do not
 * validate positions at all (a display query ordering by seq, an allocation guard
 * reading plan ownership), and nothing about duplicate-refusals that are not
 * about an installment schedule.
 */
export function refusesDuplicateSeqButNotGaps(src) {
  if (!/installment/i.test(src)) return false;
  if (!REFUSES_DUPLICATE_SEQ.test(src)) return false;
  return !(TAKES_A_MAXIMUM.test(src) && COMPARED_TO_A_COUNT.test(src));
}

test("the detector flags the exact shape that accepted a schedule numbered 1,3", () => {
  // Verbatim from assert_installment_schedule() as 20260817000000 shipped it: the
  // per-item loop, with the duplicate refusal and nothing about contiguity. If a
  // later edit makes the detector stop seeing this, every assertion below becomes
  // a tautology and the finding comes back silently.
  const shipped = `
  for v_item in select value from jsonb_array_elements(p_schedule) loop
    v_count := v_count + 1;
    if nullif(v_item ->> 'amount', '') is null
       or (v_item ->> 'amount')::numeric(12, 2) <= 0 then
      raise exception 'installment % needs a positive amount', v_count using errcode = '22023';
    end if;
    v_total := v_total + (v_item ->> 'amount')::numeric(12, 2);
    v_seq := coalesce(nullif(v_item ->> 'seq', '')::integer, v_count);
    if v_seq <= 0 then
      raise exception 'installment % has a non-positive seq', v_count using errcode = '22023';
    end if;
    if v_seq = any (v_seqs) then
      raise exception 'installment seq % appears more than once', v_seq using errcode = '22023';
    end if;
    v_seqs := array_append(v_seqs, v_seq);
  end loop;
`;
  assert.equal(
    refusesDuplicateSeqButNotGaps(shipped),
    true,
    "the detector no longer recognises the body that accepted a schedule numbered 1,3",
  );

  // And the route's half of the same gap, verbatim from what it shipped.
  const routeShipped = `
    const seen = new Set<number>();
    for (const [index, inst] of schedule.entries()) {
      const position = index + 1;
      if (!Number.isInteger(inst.seq) || inst.seq <= 0) {
        return NextResponse.json({ error: \`Installment \${position} has an invalid position\` }, { status: 400 });
      }
      if (seen.has(inst.seq)) {
        return NextResponse.json({ error: \`Installment position \${inst.seq} appears more than once\` }, { status: 400 });
      }
      seen.add(inst.seq);
    }
`;
  assert.equal(refusesDuplicateSeqButNotGaps(routeShipped), true, "the detector misses the route's half of the gap");
});

test("the detector does not flag the shapes the codebase legitimately contains", () => {
  const clean = [
    // 1 · the closed SQL validator: duplicate refusal AND the 1..N assertion.
    `if v_seq = any (v_seqs) then
       raise exception 'installment seq % appears more than once', v_seq using errcode = '22023';
     end if;
     if (select max(s) from unnest(v_seqs) as s) <> v_count then
       raise exception 'the installment schedule must be numbered 1..% with no gaps', v_count using errcode = '22023';
     end if;`,
    // 2 · the closed route: duplicate refusal AND a max compared to the length.
    `if (seen.has(inst.seq)) { return bad(\`Installment position \${inst.seq} appears more than once\`); }
     const maxSeq = Math.max(...schedule.map((inst) => inst.seq));
     if (maxSeq !== schedule.length) { return bad("The installment schedule must be numbered 1 to N with no gaps"); }`,
    // 3 · the allocation ownership guard: reads installment plans, validates no positions.
    `const { data: plans } = await supabase.from('installment_plans').select('id, contract_id').in('id', planIds)`,
    // 4 · a display query ordering installments by position.
    `const { data } = await supabase.from("installment_plans").select("*").eq("contract_id", id).order("seq", { ascending: true })`,
    // 5 · the schedule build that on_lead_won does: a 1..N loop, no validation.
    `for v_seq in 1 .. v_installment_count loop
       insert into public.installment_plans (contract_id, seq, amount) values (v_contract_id, v_seq, v_amounts[v_seq]);
     end loop;`,
    // 6 · a duplicate refusal that is not about an installment schedule at all.
    `raise exception 'payment request_key % appears more than once', p_request_key using errcode = '23505';`,
  ];
  for (const [index, src] of clean.entries()) {
    assert.equal(
      refusesDuplicateSeqButNotGaps(src),
      false,
      `false positive on legitimate neighbour ${index + 1}: ${src.replace(/\s+/g, " ").slice(0, 72)}`,
    );
  }
});

/* ─── the real files ─────────────────────────────────────────────────────── */

/**
 * Every migration that defines assert_installment_schedule(), in filename order.
 * Only the LAST one describes what a migrated database actually holds, which is
 * why the earlier definition is not scanned — it is history, and history is
 * allowed to be the broken shape.
 */
async function validatorDefinitions() {
  const files = (await readdir(path.join(ROOT, MIGRATIONS)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const out = [];
  for (const name of files) {
    const src = await read(`${MIGRATIONS}/${name}`);
    const at = src.indexOf(VALIDATOR_SIGNATURE);
    if (at === -1) continue;
    const rest = src.slice(at);
    out.push({ name, body: sqlCode(rest.slice(0, rest.indexOf("$$;"))) });
  }
  return out;
}

test("the schedule validator exists, and its newest definition requires 1..N", async () => {
  const definitions = await validatorDefinitions();
  assert.ok(
    definitions.length >= 1,
    "no migration defines assert_installment_schedule(); create_contract() would be validating nothing",
  );
  const newest = definitions[definitions.length - 1];
  assert.equal(
    refusesDuplicateSeqButNotGaps(newest.body),
    false,
    `${MIGRATIONS}/${newest.name} is the last definition of assert_installment_schedule() and it refuses a duplicate position without requiring 1..N; a schedule numbered 1,3 is accepted and the contract is missing its second installment`,
  );
  // Named separately from the detector so a body that dropped the duplicate
  // refusal — which would make the detector return false for the wrong reason —
  // still fails.
  assert.match(
    newest.body,
    REFUSES_DUPLICATE_SEQ,
    `${newest.name} no longer refuses a repeated installment position`,
  );
  assert.match(
    newest.body,
    /jsonb_typeof\(p_schedule\)[\s\S]{0,80}<>\s*'array'/,
    `${newest.name} no longer refuses a non-array schedule`,
  );
  assert.match(
    newest.body,
    /round\(v_total,\s*2\)\s*<>\s*round\(p_total,\s*2\)/,
    `${newest.name} no longer requires the schedule to total the contract exactly`,
  );
});

test("the newest definition is a full body, not a partial redefinition", async () => {
  // A CREATE OR REPLACE that reproduced only the new check would silently drop the
  // positive-amount, due-date and exact-total refusals the round-4 body carries.
  const definitions = await validatorDefinitions();
  const newest = definitions[definitions.length - 1];
  for (const [what, pattern] of [
    ["the positive-amount refusal", /needs a positive amount/],
    ["the non-positive seq refusal", /non-positive seq/],
    ["the due-date refusal", /invalid due_date/],
    ["the exact-total refusal", /totals % but the % totals %/],
  ]) {
    assert.match(newest.body, pattern, `${newest.name} dropped ${what} while redefining the validator`);
  }
});

test("create_contract validates the schedule before its first write", async () => {
  // Order is the point. A validator called after the INSERT would still refuse the
  // schedule, but only after a contract number had been drawn from the sequence.
  const files = (await readdir(path.join(ROOT, MIGRATIONS))).filter((n) => n.endsWith(".sql")).sort();
  let newest = null;
  for (const name of files) {
    const src = sqlCode(await read(`${MIGRATIONS}/${name}`));
    const at = src.indexOf("create or replace function public.create_contract(");
    if (at === -1) continue;
    const rest = src.slice(at);
    newest = { name, body: rest.slice(0, rest.indexOf("$$;")) };
  }
  assert.ok(newest, "no migration defines create_contract()");
  const validatedAt = newest.body.indexOf("assert_installment_schedule(");
  const insertedAt = newest.body.indexOf("insert into public.contracts");
  assert.ok(
    validatedAt !== -1,
    `${newest.name}'s create_contract() does not call assert_installment_schedule(); it validates the schedule itself or not at all`,
  );
  assert.ok(insertedAt !== -1, `${newest.name}'s create_contract() no longer inserts a contract`);
  assert.ok(
    validatedAt < insertedAt,
    `${newest.name}'s create_contract() validates the schedule after inserting the contract; a refused schedule would consume a contract number`,
  );
});

test("the contracts POST route mirrors the 1..N rule", async () => {
  const route = code(await read(CONTRACTS_ROUTE));
  const post = route.slice(route.indexOf("export async function POST("), route.indexOf("export async function GET("));
  assert.ok(post.length > 500, `${CONTRACTS_ROUTE}: could not isolate the POST handler`);
  assert.equal(
    refusesDuplicateSeqButNotGaps(post),
    false,
    `${CONTRACTS_ROUTE} refuses a duplicate installment position but not a gap; assert_installment_schedule() answers 22023 and the client is told the total, not which position is missing`,
  );
  // The refusal has to happen before the RPC, or the message never reaches the
  // client ahead of the database's own.
  const guardAt = post.search(COMPARED_TO_A_COUNT);
  const rpcAt = post.indexOf('.rpc("create_contract"');
  assert.ok(rpcAt !== -1, `${CONTRACTS_ROUTE} no longer calls create_contract()`);
  assert.ok(guardAt !== -1 && guardAt < rpcAt, `${CONTRACTS_ROUTE} checks the numbering after calling the routine`);
});

test("the browser form emits contiguous positions, so the route's refusal is not a UI regression", async () => {
  const page = code(await read(NEW_CONTRACT_PAGE));
  assert.match(
    page,
    /seq:\s*i\s*\+\s*1/,
    `${NEW_CONTRACT_PAGE} no longer numbers its installments by position; the 1..N rule would start refusing the form itself`,
  );
});

/* ─── the write stays where the validation is ────────────────────────────── */

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

test("nothing outside the routines inserts an installment schedule", async () => {
  // The validation is only a closure while create_contract() and the conversion
  // are the only writers. This is the B1 shape: the routine was correct and the
  // page wrote around it.
  const files = [...(await tsSources("src/app")), ...(await tsSources("src/components"))];
  assert.ok(files.length >= 50, `scanned ${files.length} sources — the walker has drifted`);
  for (const file of files) {
    const src = code(await read(file));
    const from = /\.from\(\s*["'`]installment_plans["'`]\s*\)/g;
    let match;
    while ((match = from.exec(src)) !== null) {
      const window = src.slice(match.index, match.index + 300);
      assert.doesNotMatch(
        window,
        /\.(insert|upsert)\(/,
        `${file} inserts installment_plans directly; create_contract() and convert_quotation_to_contract() are the only writers that validate the schedule`,
      );
    }
  }
});
