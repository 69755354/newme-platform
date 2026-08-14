// ============================================================================
// Contract test: a conversion retry writes what a conversion writes — round R4
// ============================================================================
// convert_quotation_to_contract() has two paths that must reach the same state:
// the first conversion, and the already-converted branch a re-POST lands in.
// 20260817130000 (B5) made that branch REFUSE everything that is not a retry of
// this conversion. What it never did was make the accepted case equal: the branch
// left quotations.status, leads.final_status and contracts.customer_id untouched
// and returned no project_id, while answering `success: true`. Measured on
// PG 17.10 against the release with 20260817170000 withheld: the retry returned
// quotation_status 'accepted', project_id null, finalized [], and all three rows
// read back unrepaired.
//
// 20260817170000 closes it, and supabase/replay/10_assert_release_contracts.sql
// proves the behaviour against a real database. This file exists for the OTHER
// failure — the one a green replay cannot see: a later migration that adds a write
// to the first-conversion path and forgets the retry branch, which is precisely how
// the three missing writes came to exist. So the two paths are compared here, in
// the file that defines them, and almost nothing is asserted about what the writes
// are: the sets are derived from the last definition, and any asymmetry has to be
// declared below with a reason.
//
// The comparison is run against the PREVIOUS definition too, which is still in the
// tree and is the defect itself. That is what keeps this file from being a shape
// match that would pass either way.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { sqlWithoutComments } from "./sql-text.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");

// Line endings are normalised: this file matches on indentation-anchored SQL
// structure, and a CRLF checkout on Windows would otherwise false-red every
// `$`-anchored pattern below.
const migration = (file) => readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").replace(/\r\n/g, "\n");

const DEFINES = /create or replace function public\.convert_quotation_to_contract\b/;

// The LAST definition wins in the database, so it is the only one that can be
// measured against. Derived from the directory rather than named, so a new
// migration that redefines the routine is compared instead of ignored.
const definers = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^[0-9]{14}_.*\.sql$/.test(name))
  .sort()
  .filter((name) => DEFINES.test(migration(name)));

const LAST_DEFINER = definers.at(-1);

// The negative control, pinned by name rather than by position: it has to stay the
// definition that carried the defect, and `definers.at(-2)` stops being that as
// soon as anything else redefines the routine.
const DEFECTIVE_DEFINER = "20260817130000_b5_conversion_retry_idempotence.sql";

/** The routine's plpgsql body, from its `as $tag$` to the matching close. */
function routineBody(text) {
  const at = text.search(DEFINES);
  assert.notEqual(at, -1, "no migration defines convert_quotation_to_contract");
  const opener = /\breturns jsonb[\s\S]*?\bas (\$[A-Za-z_]+\$|\$\$)/.exec(text.slice(at));
  assert.ok(opener, "the routine's body is not dollar-quoted");
  const start = at + opener.index + opener[0].length;
  const end = text.indexOf(opener[1], start);
  assert.notEqual(end, -1, "the routine's body is never closed");
  const body = text.slice(start, end);
  assert.ok(body.length > 2000, `the extracted body is ${body.length} characters, which is not this routine`);
  return body;
}

// The two paths, split on the branch's own structure rather than on a comment: the
// retry branch is `if v_quote.contract_id is not null then` up to the `end if;` at
// the routine's own indentation, and the first conversion is everything after it.
function paths(text) {
  const body = routineBody(text);
  const open = body.indexOf("if v_quote.contract_id is not null then");
  assert.notEqual(open, -1, "the already-converted branch is no longer entered on the link");
  const close = /^ {2}end if;$/m.exec(body.slice(open));
  assert.ok(close, "the already-converted branch has no close at the routine's indentation");
  return {
    retry: sqlWithoutComments(body.slice(open, open + close.index)),
    first: sqlWithoutComments(body.slice(open + close.index + close[0].length)),
  };
}

/** Tables this text writes, and the routines it calls for their side effects. */
function effects(sql) {
  const tables = new Set();
  for (const match of sql.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+public\.([a-z_]+)/g)) {
    tables.add(match[1]);
  }
  const calls = new Set();
  for (const match of sql.matchAll(/\bpublic\.(finalize_lead_won|revoke_contract|allocate_payment)\s*\(/g)) {
    calls.add(match[1]);
  }
  return { tables, calls };
}

/**
 * The keys of the `jsonb_build_object` this path returns. Read positionally — the
 * odd arguments are values, and one of them is the literal 'contract_created',
 * which a `'([a-z_]+)',` sweep would report as a key the other path is missing.
 */
function returnedKeys(sql) {
  const open = sql.lastIndexOf("return jsonb_build_object(");
  assert.notEqual(open, -1, "this path does not return a jsonb object");
  let i = sql.indexOf("(", open) + 1;
  let depth = 1;
  const args = [];
  let current = "";
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      const close = sql.indexOf("'", i + 1);
      assert.notEqual(close, -1, "an unterminated literal in the return value");
      current += sql.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0) break;
    if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
    i += 1;
  }
  assert.equal(depth, 0, "the return value's argument list is never closed");
  args.push(current.trim());
  assert.equal(args.length % 2, 0, `jsonb_build_object() got ${args.length} arguments`);
  return new Set(args.filter((_, index) => index % 2 === 0).map((key) => {
    assert.match(key, /^'[a-z_]+'$/, `${key} is not a literal key`);
    return key.slice(1, -1);
  }));
}

/** Tables the first conversion writes and the retry branch does not. */
function unrepairedTables({ retry, first }) {
  const written = effects(retry).tables;
  return [...effects(first).tables]
    .filter((table) => !written.has(table))
    .sort();
}

/** Keys the first conversion returns and the retry branch does not. */
function unreportedKeys({ retry, first }) {
  const reported = returnedKeys(retry);
  return [...returnedKeys(first)].filter((key) => !reported.has(key)).sort();
}

// Asymmetries that are deliberate. Anything not listed here is a defect, and the
// reason is part of the declaration so that removing the reason removes the
// exemption.
const WRITE_EXCEPTIONS = new Map([
  [
    "installment_plans",
    "the retry compares the existing schedule against the quotation and refuses a "
      + "difference (B5/B10) instead of writing one; writing here would let a retry "
      + "rewrite a schedule money has already been allocated against",
  ],
]);

const RETURN_EXCEPTIONS = new Map();

test("the routine is defined once as the last word, and the file that defines it is in the release", () => {
  assert.ok(LAST_DEFINER, "no migration defines convert_quotation_to_contract");
  assert.ok(definers.includes(DEFECTIVE_DEFINER), `${DEFECTIVE_DEFINER} no longer defines the routine`);
  assert.notEqual(LAST_DEFINER, DEFECTIVE_DEFINER, "the defective definition is again the last word");
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "infra", "release", "release-manifest.json"), "utf8"));
  const declared = [...manifest.required_for_app, ...manifest.deferred_contract].map((entry) => entry.file);
  const baseline = readFileSync(path.join(ROOT, "supabase", "migration-history-baseline.sha256"), "utf8");
  assert.ok(
    declared.includes(LAST_DEFINER) || baseline.includes(LAST_DEFINER),
    `${LAST_DEFINER} redefines the routine but is neither a release phase nor applied history`,
  );
});

test("every table the first conversion writes is written by the retry branch too", () => {
  const missing = unrepairedTables(paths(migration(LAST_DEFINER))).filter((table) => {
    const reason = WRITE_EXCEPTIONS.get(table);
    return !(reason && reason.length > 40);
  });
  assert.deepEqual(
    missing,
    [],
    `the first conversion writes public.${missing.join(", public.")} and the retry does not; either `
      + "write it on the retry path or declare it in WRITE_EXCEPTIONS with the reason",
  );
});

test("every side-effect routine the first conversion calls is called by the retry branch too", () => {
  const { retry, first } = paths(migration(LAST_DEFINER));
  for (const call of effects(first).calls) {
    assert.ok(effects(retry).calls.has(call), `the retry branch does not call public.${call}()`);
  }
  // Not vacuous: finalize_lead_won() is the customer/business-event half of B6, and
  // a retry that stopped calling it would be the B6 defect all over again.
  assert.ok(effects(first).calls.has("finalize_lead_won"), "the first conversion no longer finalizes the lead");
});

test("every key the first conversion returns is returned by the retry branch too", () => {
  const missing = unreportedKeys(paths(migration(LAST_DEFINER))).filter((key) => !RETURN_EXCEPTIONS.has(key));
  assert.deepEqual(missing, [], `the retry's return value is missing ${missing.join(", ")}`);
  // The three the defect was about, named so that a rename cannot quietly satisfy
  // the set comparison above.
  const retryKeys = returnedKeys(paths(migration(LAST_DEFINER)).retry);
  for (const key of ["quotation_status", "project_id", "customer_id"]) {
    assert.ok(retryKeys.has(key), `the retry no longer returns ${key}`);
  }
  assert.ok(retryKeys.has("finalized"), "the retry no longer reports what it repaired");
});

test("the retry repairs the three rows the way the first conversion writes them", () => {
  const { retry, first } = paths(migration(LAST_DEFINER));

  // quotations.status converges, and the returned status is the converged value
  // rather than the one read before the write.
  assert.match(retry, /update public\.quotations\s+set status = 'contract_created'/);
  assert.match(retry, /'quotation_status',\s+v_status/);
  assert.doesNotMatch(retry, /'quotation_status',\s+v_quote\.status/);

  // leads.final_status is repaired only from NULL, and any other terminal value is
  // refused with the same shape as B5's refusals — not overruled.
  assert.match(retry, /update public\.leads set final_status = 'won'/);
  assert.match(retry, /rather than won/);
  assert.match(retry, /using errcode = '22023'/);

  // contracts.customer_id carries the first conversion's own `is null` guard on
  // both paths, so a repair can never overwrite somebody else's customer.
  for (const [name, sql] of [["retry", retry], ["first conversion", first]]) {
    const stmt = /update public\.contracts set customer_id = v_customer_id[^;]*;/.exec(sql);
    assert.ok(stmt, `the ${name} does not set contracts.customer_id`);
    assert.match(stmt[0], /customer_id is null/, `the ${name} would overwrite an existing customer`);
  }
});

test("the lead row is locked before either path writes it", () => {
  // The retry branch writes leads, which it did not before, so both paths now take
  // quotations → leads → contracts. Without `for update` on the read, two
  // concurrent retries could interleave the read and the repair.
  assert.match(
    sqlWithoutComments(routineBody(migration(LAST_DEFINER))),
    /select \* into v_lead from public\.leads where id = v_quote\.lead_id for update;/,
  );
});

test("the same comparison reports the defect in the definition this release replaced", () => {
  // The control. Run over 20260817130000, whose retry branch is the finding: three
  // rows it never repaired and a project_id it never reported. If this ever comes
  // back empty, the checks above are matching a shape both definitions satisfy and
  // they are no longer measuring anything.
  const defective = paths(migration(DEFECTIVE_DEFINER));
  assert.deepEqual(unreportedKeys(defective), ["project_id"]);
  assert.deepEqual(
    unrepairedTables(defective).filter((table) => table !== "installment_plans"),
    ["contracts", "leads", "quotations"],
  );
  // And the repair assertions fail against it for the reasons the header records.
  assert.doesNotMatch(defective.retry, /update public\.quotations\s+set status = 'contract_created'/);
  assert.doesNotMatch(defective.retry, /update public\.leads set final_status = 'won'/);
  assert.doesNotMatch(defective.retry, /update public\.contracts set customer_id = v_customer_id/);
});
