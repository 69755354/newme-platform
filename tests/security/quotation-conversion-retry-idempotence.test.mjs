// ============================================================================
// Source gate: a quotation-conversion retry is a retry, not a second conversion
// ============================================================================
// B5. Two defects, both in the idempotent branch of
// convert_quotation_to_contract() and its lead-won finalizer, both reproduced on
// PostgreSQL 17.10 against a database carrying this release, in both release
// modes:
//
//   1. finalize_lead_won() added the contract amount to
//      customers.total_contract_amount on every call. The conversion's
//      already-converted branch calls it again on every retry, so one conversion
//      of an 80000.00 quotation plus two identical retries left 240000.00 there
//      while the routine answered already_converted: true, finalized: [].
//   2. The same branch validates the stored state thoroughly and never looks at
//      p_payload, so a retry asking for a different installment schedule was
//      answered success: true and wrote nothing.
//
// The behaviour proof lives in the replay harness, which runs the routines. This
// file is the cheap gate that runs on every push: it reads the NEWEST definition
// of each routine across supabase/migrations/ — the one a fresh replay ends up
// with — and refuses the two shapes above. A shape gate is not a behaviour proof,
// so it is written the only way a shape gate is worth anything: it is first shown
// to flag the exact text that was broken, then shown not to flag five legitimate
// neighbours, and only then pointed at the tree.
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const CLI_MIGRATION = /^[0-9]{14}_.*\.sql$/;

/** The house comment stripper: block comments and `//` line comments. */
export function code(src){return src.replace(/\/\*[\s\S]*?\*\//g,"").replace(/(^|[^:"'`])\/\/.*$/gm,"$1")}

/**
 * The same for SQL, whose line comment is `--`. Without this the gate could be
 * satisfied — or tripped — by prose: every one of these migrations explains its
 * own defect in a comment directly above the code, in the words the detector
 * looks for. Proven by the "the shape only in a comment" case below.
 */
export function sqlCode(src) {
  return code(src).replace(/(^|[^:"'`])--.*$/gm, "$1");
}

/**
 * Every `create or replace function public.x(...)` body in one SQL text, keyed by
 * routine name, last definition in the file winning. Bodies in this repo are
 * dollar-quoted and end with `$$;` at the start of a line.
 */
export function functionBodies(sql) {
  const found = new Map();
  const start = /^create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(/gim;
  for (let match = start.exec(sql); match !== null; match = start.exec(sql)) {
    const end = sql.indexOf("\n$$;", match.index);
    if (end < 0) continue;
    found.set(match[1], sql.slice(match.index, end + 4));
  }
  return found;
}

/**
 * The definition a fresh replay of `files` ends up with, for each routine: files
 * in version order, later definitions replacing earlier ones. This is the reason
 * the gate does not trip on `on_lead_won` as 20260603000001 and 20260812000000
 * wrote it — those bodies add the amount unconditionally and are genuinely gone,
 * replaced by a body that delegates to finalize_lead_won().
 */
export function newestDefinitions(files, read) {
  const newest = new Map();
  for (const file of [...files].sort()) {
    for (const [name, body] of functionBodies(read(file))) newest.set(name, { file, body });
  }
  return newest;
}

/**
 * The detector. Returns one finding per defect, empty when the release is sound.
 *
 * R1 — finalize_lead_won() must add p_amount conditionally. The condition has to
 *      be inside the assignment rather than around the UPDATE: that UPDATE also
 *      refreshes the customer's name, phone, email and last_activity_at, and a
 *      retry (or a later win on the same lead) must keep doing that.
 * R2 — the already-converted branch of convert_quotation_to_contract() must read
 *      p_payload. Everything else it checks is stored state, which is by
 *      construction consistent with the conversion that already happened; only
 *      the payload says what THIS call is asking for.
 *
 * Both rules fail closed: a routine that is missing, or a branch whose anchors
 * have been rewritten, is a finding rather than a silent pass.
 */
export function findConversionRetryDefects(newest) {
  const findings = [];
  const finalize = newest.get("finalize_lead_won");
  const convert = newest.get("convert_quotation_to_contract");

  if (finalize === undefined) {
    findings.push("finalize_lead_won: no definition found in the migrations");
  } else {
    const body = sqlCode(finalize.body);
    const accumulation =
      /set\s+total_contract_amount\s*=\s*coalesce\s*\(\s*total_contract_amount\s*,\s*0\s*\)\s*\+\s*([\s\S]*?),\s*\n/gi;
    let seen = 0;
    for (let m = accumulation.exec(body); m !== null; m = accumulation.exec(body)) {
      seen += 1;
      const addend = m[1].trim();
      if (/\bp_amount\b/.test(addend) && !/\bcase\b[\s\S]*\bwhen\b/i.test(addend)) {
        findings.push(
          `finalize_lead_won (${finalize.file}): customers.total_contract_amount is increased by ` +
            `\`${addend}\` with no condition, so every conversion retry adds the contract again`,
        );
      }
    }
    if (seen === 0) {
      findings.push(
        `finalize_lead_won (${finalize.file}): no customers.total_contract_amount accumulation found; ` +
          "if the lead-won amount moved elsewhere, this gate has to move with it",
      );
    }
  }

  if (convert === undefined) {
    findings.push("convert_quotation_to_contract: no definition found in the migrations");
  } else {
    const body = sqlCode(convert.body);
    const returnsTrue = body.search(/'already_converted'\s*,\s*true/);
    if (returnsTrue >= 0) {
      const anchor = /if\s+v_quote\.contract_id\s+is\s+not\s+null\s+then/gi;
      let branchStart = -1;
      for (let m = anchor.exec(body); m !== null && m.index < returnsTrue; m = anchor.exec(body)) {
        branchStart = m.index;
      }
      if (branchStart < 0) {
        findings.push(
          `convert_quotation_to_contract (${convert.file}): it returns already_converted: true but the ` +
            "branch that does cannot be located, so this gate cannot judge it",
        );
      } else if (!/\bp_payload\b/.test(body.slice(branchStart, returnsTrue))) {
        findings.push(
          `convert_quotation_to_contract (${convert.file}): the already-converted branch never reads ` +
            "p_payload, so a retry asking for a different schedule is answered success: true",
        );
      }
    }
  }
  return findings;
}

// ── the exact broken shape ─────────────────────────────────────────────────
// Not a paraphrase: the two bodies as 20260817000000 wrote them, which is what
// was reproduced. Written as a synthetic "release" of that one file so the case
// keeps working after the fix lands in a later file.
const BROKEN_FINALIZE = `create or replace function public.finalize_lead_won(
  p_lead_id uuid, p_amount numeric, p_actor uuid, p_source text, p_context jsonb)
returns uuid language plpgsql security definer as $$
begin
  perform public.assert_current_session_at_entry();
  if v_customer_id is not null then
    update public.customers
       set total_contract_amount = coalesce(total_contract_amount, 0) + coalesce(p_amount, 0),
           last_activity_at      = now(),
           updated_at = now()
     where id = v_customer_id;
  end if;
  return v_customer_id;
end
$$;
`;

const BROKEN_CONVERT = `create or replace function public.convert_quotation_to_contract(
  p_quotation_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer as $$
begin
  perform public.assert_current_session_at_entry();
  v_actor := public.money_actor(p_payload ->> 'actor_id', array['sales', 'boss']);
  if v_quote.contract_id is not null then
    select * into v_contract from public.contracts where id = v_quote.contract_id;
    if v_contract.id is null then
      raise exception 'dangling link' using errcode = '22023';
    end if;
    v_customer_id := public.finalize_lead_won(v_quote.lead_id,
      coalesce(v_quote.total_amount, 0), v_actor, 'quotation_finalize', '{}'::jsonb);
    return jsonb_build_object(
      'success',            true,
      'already_converted',  true,
      'contract_id',        v_contract.id
    );
  end if;
  return jsonb_build_object('success', true, 'already_converted', false);
end
$$;
`;

const release = (...bodies) => {
  const files = bodies.map((body, index) => `2026081700000${index}_case.sql`);
  const byName = new Map(files.map((file, index) => [file, bodies[index]]));
  return newestDefinitions(files, (file) => byName.get(file));
};

test("it flags the shape that was reproduced", () => {
  const findings = findConversionRetryDefects(release(BROKEN_FINALIZE, BROKEN_CONVERT));
  assert.equal(findings.length, 2);
  assert.match(findings[0], /total_contract_amount is increased by .*with no condition/);
  assert.match(findings[1], /already-converted branch never reads p_payload/);
});

test("it flags each half of it on its own", () => {
  const FIXED_FINALIZE = BROKEN_FINALIZE.replace(
    "+ coalesce(p_amount, 0),",
    "+ case when v_first_won then coalesce(p_amount, 0) else 0 end,",
  );
  const FIXED_CONVERT = BROKEN_CONVERT.replace(
    "    v_customer_id := public.finalize_lead_won(",
    `    if jsonb_typeof(p_payload -> 'installments') = 'array' then
      perform public.assert_installment_schedule(p_payload -> 'installments',
        v_contract.contract_amount, 'quotation');
    end if;
    v_customer_id := public.finalize_lead_won(`,
  );
  assert.equal(findConversionRetryDefects(release(FIXED_FINALIZE, BROKEN_CONVERT)).length, 1);
  assert.equal(findConversionRetryDefects(release(BROKEN_FINALIZE, FIXED_CONVERT)).length, 1);
  assert.deepEqual(findConversionRetryDefects(release(FIXED_FINALIZE, FIXED_CONVERT)), []);
});

test("it does not flag legitimate neighbours", () => {
  // 1 · a differently named marker, and the condition written the other way round
  const otherMarker = BROKEN_FINALIZE.replace(
    "+ coalesce(p_amount, 0),",
    "+ case when v_won_already_recorded then 0 else coalesce(p_amount, 0) end,",
  );
  // 2 · the branch compares the payload itself, with no call to the shared
  //     validator — a different implementation of the same invariant
  const ownComparison = BROKEN_CONVERT.replace(
    "    v_customer_id := public.finalize_lead_won(",
    `    if p_payload -> 'installments' is distinct from v_stored_schedule then
      raise exception 'this retry asks for another schedule' using errcode = '22023';
    end if;
    v_customer_id := public.finalize_lead_won(`,
  );
  // 3 · an unrelated routine that accumulates the same column unconditionally,
  //     which is what a reconciliation job legitimately does
  const reconcile = `create or replace function public.reconcile_customer_total(
  p_customer_id uuid, p_amount numeric)
returns void language plpgsql as $$
begin
  update public.customers
     set total_contract_amount = coalesce(total_contract_amount, 0) + coalesce(p_amount, 0),
         updated_at = now()
   where id = p_customer_id;
end
$$;
`;
  // 4 · a conversion routine with no idempotent branch at all: nothing to check
  const noRetryBranch = `create or replace function public.convert_quotation_to_contract(
  p_quotation_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer as $$
begin
  perform public.assert_current_session_at_entry();
  if v_quote.contract_id is not null then
    raise exception 'quotation % is already converted', v_quote.quote_no using errcode = '22023';
  end if;
  return jsonb_build_object('success', true, 'already_converted', false);
end
$$;
`;
  // 5 · the broken shape present only as prose, in the same words the real
  //     migrations use to describe the defect they fixed
  const commentOnly = `create or replace function public.finalize_lead_won(
  p_lead_id uuid, p_amount numeric, p_actor uuid, p_source text, p_context jsonb)
returns uuid language plpgsql security definer as $$
begin
  perform public.assert_current_session_at_entry();
  -- This used to read:
  --   set total_contract_amount = coalesce(total_contract_amount, 0) + coalesce(p_amount, 0),
  -- and the retry branch of convert_quotation_to_contract() called it again.
  update public.customers
     set total_contract_amount = coalesce(total_contract_amount, 0)
                                 + case when v_first_won then coalesce(p_amount, 0) else 0 end,
         updated_at = now()
   where id = v_customer_id;
  return v_customer_id;
end
$$;
`;
  const fixedConvert = BROKEN_CONVERT.replace(
    "    v_customer_id := public.finalize_lead_won(",
    `    perform public.assert_installment_schedule(p_payload -> 'installments',
      v_contract.contract_amount, 'quotation');
    v_customer_id := public.finalize_lead_won(`,
  );

  assert.deepEqual(findConversionRetryDefects(release(otherMarker, fixedConvert)), []);
  assert.deepEqual(findConversionRetryDefects(release(commentOnly, ownComparison)), []);
  assert.deepEqual(findConversionRetryDefects(release(commentOnly, reconcile, noRetryBranch)), []);

  // 6 · a later migration replacing a sound definition with the broken one is
  //     still caught: it is the newest definition that decides.
  assert.equal(
    findConversionRetryDefects(release(commentOnly, fixedConvert, BROKEN_FINALIZE)).length,
    1,
  );
});

test("the gate cannot be satisfied by a missing routine", () => {
  const empty = findConversionRetryDefects(new Map());
  assert.equal(empty.length, 2);
  const movedAmount = findConversionRetryDefects(
    release(BROKEN_FINALIZE.replace(/set total_contract_amount[\s\S]*?\n/, "set updated_at = now(),\n")),
  );
  assert.equal(movedAmount.length, 2);
  assert.match(movedAmount[0], /no customers\.total_contract_amount accumulation found/);
});

test("this release's newest definitions are sound", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => CLI_MIGRATION.test(file));
  const newest = newestDefinitions(files, (file) =>
    readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").replace(/\r\n/g, "\n"));
  assert.deepEqual(findConversionRetryDefects(newest), []);

  // The definitions this gate judges must be the ones this release ships, not a
  // pre-release body that happens to be the newest because the fix was reverted.
  assert.equal(newest.get("finalize_lead_won").file.slice(0, 8) >= "20260817", true);
  assert.equal(newest.get("convert_quotation_to_contract").file.slice(0, 8) >= "20260817", true);
});
