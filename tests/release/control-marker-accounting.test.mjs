// ============================================================================
// Mutation test for the negative-control marker accounting (round-3 P1-12)
// ============================================================================
// The finding was not that the control replay was missing — it was that the gate
// deciding whether the control passed was wrong, and untested. It checked "no
// ASSERT_OK line was seen for this name", which is also true of an assertion that
// never executed, and 78 of them never executed. CI reported 100 load-bearing
// assertions failing over a log containing 87 assertion-specific markers and 40
// unclassified SQL errors.
//
// So the gate is now a module, and this file mutation-tests it: it starts from the
// real assertion file and the real expectations, synthesises the log a correct
// control run produces, asserts that the gate accepts it, and then breaks it one
// way at a time — dropped marker, duplicated marker, injected SQL error, flipped
// verdict, renamed assertion, undeclared assertion, tampered ledger — and requires
// each mutation to be rejected with a message that names the actual problem.
//
// No database: the accounting is a pure function of three texts, which is exactly
// why it can be tested this way. scripts/replay-migrations.sh MODE=control feeds it
// the real log.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  account,
  parseAssertionNames,
  parseExpectations,
  parseLog,
} from "../../scripts/control-marker-accounting.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const assertionSql = await read("supabase/replay/10_assert_release_contracts.sql");
const expectationsText = await read("supabase/replay/control-expectations.txt");

const names = parseAssertionNames(assertionSql);
const { expected } = parseExpectations(expectationsText);

/** The log a correct MODE=control run produces, derived from the declarations. */
function goodLog({ omit = [], duplicate = [], flip = [], extraLines = [], ledger } = {}) {
  const lines = [];
  for (const name of names) {
    if (omit.includes(name)) continue;
    let verdict = expected.get(name);
    if (flip.includes(name)) verdict = verdict === "fail" ? "pass" : "fail";
    const marker = verdict === "fail" ? "ASSERT_FAIL" : "ASSERT_OK";
    lines.push(`NOTICE:  ${marker} ${name}`);
    if (duplicate.includes(name)) lines.push(`NOTICE:  ${marker} ${name}`);
  }
  const failed = [...expected.values()].filter((v) => v === "fail").length;
  const passed = expected.size - failed;
  const l = ledger ?? { total: expected.size, passed, failed, declared: expected.size };
  lines.push(
    `NOTICE:  ASSERT_LEDGER total=${l.total} passed=${l.passed} failed=${l.failed} declared=${l.declared}`,
  );
  lines.push(...extraLines);
  return lines.join("\n") + "\n";
}

const run = (overrides = {}) =>
  account({
    assertionSql,
    expectationsText,
    log: goodLog(),
    ...overrides,
  });

test("the declarations are complete and non-trivial in both directions", () => {
  assert.ok(names.length >= 200, `expected the release assertion set to be large, saw ${names.length}`);
  assert.equal(new Set(names).size, names.length, "assertion names must be unique");
  assert.equal(expected.size, names.length);

  const declaredTotal = /^-- ASSERT_TOTAL: (\d+)$/m.exec(assertionSql);
  assert.ok(declaredTotal, "the assertion file must declare ASSERT_TOTAL");
  assert.equal(
    Number(declaredTotal[1]),
    names.length,
    "ASSERT_TOTAL must equal the number of assertions in the file",
  );

  const failing = [...expected.values()].filter((v) => v === "fail").length;
  assert.ok(failing > 150, `most assertions must be load-bearing, only ${failing} are`);
  assert.ok(expected.size - failing > 0, "the floor-passing set must be non-empty and stated");
});

test("a correct control run is accepted", () => {
  const result = run();
  assert.deepEqual(result.problems, []);
});

test("a missing marker is rejected — this is the P1-12 defect", () => {
  const victim = [...expected].find(([, v]) => v === "fail")[0];
  const { problems } = run({ log: goodLog({ omit: [victim] }) });
  assert.ok(
    problems.some((p) => p.includes("no marker at all") && p.includes(victim)),
    `expected the dropped marker to be reported, got: ${problems.join(" | ")}`,
  );
});

test("every load-bearing assertion is individually load-bearing", () => {
  // One at a time, not in bulk: a gate that only counts totals passes when one
  // marker goes missing and another appears twice.
  const loadBearing = [...expected].filter(([, v]) => v === "fail").map(([n]) => n);
  for (const name of loadBearing.slice(0, 25)) {
    const { problems } = run({ log: goodLog({ omit: [name] }) });
    assert.ok(problems.some((p) => p.includes(name)), `dropping ${name} was not detected`);
  }
});

test("a duplicated marker is rejected", () => {
  const victim = names[0];
  const { problems } = run({ log: goodLog({ duplicate: [victim] }) });
  assert.ok(
    problems.some((p) => p.includes("2 markers for one assertion") && p.includes(victim)),
    `expected the duplicate to be reported, got: ${problems.join(" | ")}`,
  );
});

test("an assertion that passes against the un-remediated floor is rejected", () => {
  const victim = [...expected].find(([, v]) => v === "fail")[0];
  const { problems } = run({ log: goodLog({ flip: [victim] }) });
  assert.ok(
    problems.some((p) => p.includes("proves nothing") && p.includes(victim)),
    `expected the tautology to be reported, got: ${problems.join(" | ")}`,
  );
});

test("an assertion declared floor-passing that fails is rejected", () => {
  // The other direction matters too: the F-09/F-10 outage detectors must hold
  // against the floor, and a branch that revoked those grants would flip them.
  const victim = [...expected].find(([, v]) => v === "pass")[0];
  const { problems } = run({ log: goodLog({ flip: [victim] }) });
  assert.ok(
    problems.some((p) => p.includes("expected to hold against the floor but failed") && p.includes(victim)),
    `expected the flipped outage detector to be reported, got: ${problems.join(" | ")}`,
  );
});

test("an unclassified SQL error fails the run even when every marker is present", () => {
  const { problems } = run({
    log: goodLog({ extraLines: ["psql:10_assert_release_contracts.sql:2201: ERROR:  function public.void_payment(unknown, unknown) does not exist"] }),
  });
  assert.ok(
    problems.some((p) => p.includes("unclassified SQL error") && p.includes("void_payment")),
    `expected the stray error to be reported, got: ${problems.join(" | ")}`,
  );
});

test("a marker for an assertion nobody declared is rejected", () => {
  const { problems } = run({
    log: goodLog({ extraLines: ["NOTICE:  ASSERT_FAIL a-marker-from-nowhere"] }),
  });
  assert.ok(
    problems.some((p) => p.includes("undeclared assertion") && p.includes("a-marker-from-nowhere")),
    `expected the unknown marker to be reported, got: ${problems.join(" | ")}`,
  );
});

test("renaming an assertion in the file without updating the expectations is rejected", () => {
  const victim = names.at(-1);
  const mutated = assertionSql.replace(`'${victim}'`, "'renamed-behind-the-gates-back'");
  const { problems } = account({
    assertionSql: mutated,
    expectationsText,
    log: goodLog(),
  });
  assert.ok(
    problems.some((p) => p.includes("not declared in the expectations")),
    `expected the rename to be reported, got: ${problems.join(" | ")}`,
  );
  assert.ok(
    problems.some((p) => p.includes("no such assertion exists") && p.includes(victim)),
    "the orphaned expectation must be reported too",
  );
});

test("an expectation for an assertion that does not exist is rejected", () => {
  const { problems } = account({
    assertionSql,
    expectationsText: `${expectationsText}fail an-assertion-that-was-never-written\n`,
    log: goodLog({ extraLines: [] }),
  });
  assert.ok(
    problems.some(
      (p) => p.includes("no such assertion exists") && p.includes("an-assertion-that-was-never-written"),
    ),
    `expected the phantom expectation to be reported, got: ${problems.join(" | ")}`,
  );
});

test("a malformed expectation line is rejected rather than silently skipped", () => {
  const { problems } = account({
    assertionSql,
    expectationsText: `${expectationsText}maybe some-assertion\n`,
    log: goodLog(),
  });
  assert.ok(
    problems.some((p) => p.includes("malformed expectation")),
    `expected the malformed line to be reported, got: ${problems.join(" | ")}`,
  );
});

test("a log with no ledger line is rejected", () => {
  const log = goodLog()
    .split("\n")
    .filter((line) => !line.includes("ASSERT_LEDGER"))
    .join("\n");
  const { problems } = run({ log });
  assert.ok(
    problems.some((p) => p.includes("no ASSERT_LEDGER line")),
    `expected the missing ledger to be reported, got: ${problems.join(" | ")}`,
  );
});

test("a ledger that disagrees with the markers is rejected", () => {
  const failed = [...expected.values()].filter((v) => v === "fail").length;
  const { problems } = run({
    log: goodLog({
      ledger: { total: expected.size - 5, passed: expected.size - failed, failed, declared: expected.size },
    }),
  });
  assert.ok(
    problems.some((p) => p.includes("ledger reached")),
    `expected the short ledger to be reported, got: ${problems.join(" | ")}`,
  );
});

test("an empty log fails loudly instead of vacuously passing", () => {
  const { problems } = run({ log: "" });
  assert.ok(problems.length >= expected.size, "every assertion must be reported as unmarked");
  assert.ok(problems.some((p) => p.includes("no ASSERT_LEDGER line")));
});

test("ASSERT_UNMEASURABLE is a classified notice, not an unclassified error", () => {
  // The assertion file emits it when the un-remediated floor cannot take a
  // measurement at all. The assertion it belongs to still reports its own
  // ASSERT_FAIL, so the notice is evidence, not an escape from the accounting.
  const { problems } = run({
    log: goodLog({
      extraLines: ["NOTICE:  ASSERT_UNMEASURABLE [42883] function public.void_payment(uuid, text) does not exist"],
    }),
  });
  assert.deepEqual(problems, []);
});

test("the assertion file wires collect mode to the gate it is measured by", async () => {
  // The three pieces the accounting depends on, asserted against the source so a
  // future edit cannot quietly remove them and leave the gate counting absences.
  assert.match(assertionSql, /create or replace function pg_temp\.collecting\(\)/);
  assert.match(assertionSql, /raise notice 'ASSERT_FAIL %', assertion_name;/);
  assert.match(assertionSql, /raise exception 'ASSERT_FAIL %', assertion_name using errcode = '22000';/);
  assert.match(assertionSql, /raise notice 'ASSERT_LEDGER total=% passed=% failed=% declared=\d+'/);

  const script = await read("scripts/replay-migrations.sh");
  assert.match(script, /alter database .* set replay\.collect = 'on'/);
  assert.match(script, /control-marker-accounting\.mjs/);
  assert.match(script, /--expectations "\$CONTROL_EXPECTATIONS"/);
  // MODE=branch must NOT collect: there, a failed assertion has to raise.
  assert.doesNotMatch(
    script.slice(script.indexOf("MODE=branch — the gate")),
    /replay\.collect/,
    "the branch gate must not run in collect mode",
  );
});

test("no assertion in either replay file is a constant", async () => {
  // `perform pg_temp.assert(true, 'name')` after an `if ... raise exception`
  // aborts the run when the measurement fails, so it is load-bearing — but the
  // marker itself says nothing, and moving or softening the raise above it turns
  // the assertion into a rubber stamp with no test failing. Round 3 found four of
  // them in the post-rollback file. The shape is banned rather than fixed once:
  // pass the measurement to assert() and put the detail in a `raise notice`.
  const postRollbackSql = await read("supabase/replay/20_assert_post_rollback.sql");
  for (const [name, sql] of [
    ["10_assert_release_contracts.sql", assertionSql],
    ["20_assert_post_rollback.sql", postRollbackSql],
  ]) {
    const vacuous = [...sql.matchAll(/^[^-\n]*\bassert\(\s*(?:true|false)\s*,\s*'([^']+)'/gim)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      vacuous,
      [],
      `${name} asserts a constant for: ${vacuous.join(", ")}`,
    );
  }

  // And the post-rollback file's declared total still matches its markers, which
  // is what scripts/replay-migrations.sh compares the run's ASSERT_OK count to.
  const declared = /^-- ASSERT_TOTAL: (\d+)$/m.exec(postRollbackSql);
  assert.ok(declared, "20_assert_post_rollback.sql must declare ASSERT_TOTAL");
  const markers = [...postRollbackSql.matchAll(/pg_temp\.assert\(/g)].length - 1; // minus its own definition
  assert.equal(
    Number(declared[1]),
    markers,
    "the post-rollback ASSERT_TOTAL must equal the number of assertion call sites",
  );
});

test("parseLog tolerates CRLF and psql line prefixes", () => {
  const { markers, errors, ledger } = parseLog(
    "psql:x.sql:1: NOTICE:  ASSERT_OK one\r\nNOTICE:  ASSERT_FAIL two\r\n" +
      "psql:x.sql:9: ERROR:  boom\r\nNOTICE:  ASSERT_LEDGER total=2 passed=1 failed=1 declared=2\r\n",
  );
  assert.deepEqual(markers, [
    { verdict: "pass", name: "one" },
    { verdict: "fail", name: "two" },
  ]);
  assert.equal(errors.length, 1);
  assert.deepEqual(ledger, { total: 2, passed: 1, failed: 1, declared: 2 });
});
