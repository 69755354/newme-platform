#!/usr/bin/env node
// ============================================================================
// Negative-control marker accounting
// ============================================================================
// Round-3 finding P1-12. The MODE=control gate in scripts/replay-migrations.sh
// used to assert two things about each load-bearing assertion: that its name
// appeared somewhere in the assertion file, and that the control log contained no
// `ASSERT_OK <name>` line for it. The second is satisfied by an assertion that
// never executed, and 78 of them never executed — a DO block that hit
// undefined_function against the un-remediated floor aborted and took every
// assertion below it with it. The exact-head CI log claimed 100 assertions
// "all fail without their migration" while containing 87 assertion-specific
// failure markers and 40 unclassified SQL errors.
//
// This is the replacement, and it is deliberately a separate, pure module rather
// than more shell: the accounting logic is the thing that was wrong, so it is
// mutation-tested directly by tests/release/control-marker-accounting.test.mjs
// with no database in the loop.
//
// Six checks, all of which the previous gate would have passed:
//
//   1. Declaration completeness, both directions. The assertion file and
//      supabase/replay/control-expectations.txt must name the same set. An
//      undeclared assertion has no expected verdict; a declared name with no
//      assertion can never fail and never proves anything.
//   2. One marker per assertion. Exactly one `ASSERT_OK <name>` or
//      `ASSERT_FAIL <name>` for every declared name — no missing markers.
//   3. No duplicate markers. Two markers for one name means the assertion ran
//      twice, or two assertions share a name, and either way a `fail` expectation
//      could be satisfied by the wrong one.
//   4. No unknown markers. A marker whose name is not declared means the file and
//      this gate have drifted.
//   5. Verdict match. Every `fail` name failed and every `pass` name passed.
//   6. No unclassified SQL errors. In collect mode the assertion file absorbs the
//      measurements the floor cannot take and reports them under the assertion's
//      own name, so a bare `ERROR:` line is an assertion that escaped the
//      accounting — the exact defect being closed here.
//
// Plus a non-vacuity check on the ledger the assertion file prints from inside
// the database: total must equal the declared count, and the passed/failed split
// must match the expectations. Log scraping alone cannot prove an assertion ran;
// the ledger counts rows in assert_log, so it can.
//
// Usage:
//   node scripts/control-marker-accounting.mjs \
//     --assertions supabase/replay/10_assert_release_contracts.sql \
//     --expectations supabase/replay/control-expectations.txt \
//     --log /tmp/control.log
// ============================================================================
import { readFileSync } from "node:fs";

/**
 * Assertion names, in file order, as the assertion file itself defines them.
 *
 * Read from the source rather than from a list, because a list is a second place
 * to update and this repository has already shipped a stale one. Both call shapes
 * count: `pg_temp.assert(<expr>, 'name')` and `pg_temp.assert_eval($q$ <expr>
 * $q$, 'name')`, the latter being how an assertion about an object the floor does
 * not have still reports under its own name.
 *
 * The helper definitions at the top of the file are skipped: they contain
 * `pg_temp.assert(false, p_name)`, which is a call site, not an assertion.
 */
export function parseAssertionNames(sql) {
  const start = sql.indexOf("-- Baseline drift");
  const body = start === -1 ? sql : sql.slice(start);
  const names = [];
  const call = /pg_temp\.assert(?:_eval)?\(/g;
  let m;
  while ((m = call.exec(body)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (depth > 0) {
      if (i >= body.length) throw new Error(`unterminated pg_temp.assert( at offset ${m.index}`);
      const c = body[i];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      else if (c === "'") {
        i += 1;
        while (body[i] !== "'") i += 1;
      } else if (c === "$") {
        const tag = /^\$[a-z]*\$/.exec(body.slice(i));
        if (tag) {
          const close = body.indexOf(tag[0], i + tag[0].length);
          if (close === -1) throw new Error(`unterminated dollar quote ${tag[0]}`);
          i = close + tag[0].length - 1;
        }
      }
      i += 1;
    }
    const args = body.slice(m.index + m[0].length, i - 1);
    const literals = [...args.matchAll(/'([a-z0-9][a-z0-9-]*)'/g)].map((x) => x[1]);
    if (literals.length === 0) continue; // pg_temp.assert(cond, p_name) inside a helper
    names.push(literals[literals.length - 1]);
    call.lastIndex = i;
  }
  return names;
}

/** `fail`/`pass` verdict per assertion name. Comments and blank lines ignored. */
export function parseExpectations(text) {
  const expected = new Map();
  const duplicates = [];
  const malformed = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const m = /^(fail|pass)\s+([a-z0-9][a-z0-9-]*)$/.exec(trimmed);
    if (!m) {
      malformed.push(`line ${index + 1}: ${trimmed}`);
      return;
    }
    if (expected.has(m[2])) duplicates.push(m[2]);
    expected.set(m[2], m[1]);
  });
  return { expected, duplicates, malformed };
}

/**
 * Markers and unclassified errors, from the raw psql output.
 *
 * `ASSERT_UNMEASURABLE` is a notice, not an error: it records that the floor could
 * not take a measurement, and the assertion it belongs to still reports its own
 * ASSERT_FAIL. A bare ERROR line is the opposite — an assertion that left the
 * accounting — so it is collected and reported.
 */
export function parseLog(log) {
  const markers = [];
  const errors = [];
  let ledger = null;
  for (const raw of log.split(/\r?\n/)) {
    const marker = /ASSERT_(OK|FAIL) ([a-z0-9][a-z0-9-]*)\s*$/.exec(raw);
    if (marker) {
      markers.push({ verdict: marker[1] === "OK" ? "pass" : "fail", name: marker[2] });
      continue;
    }
    const led = /ASSERT_LEDGER total=(\d+) passed=(\d+) failed=(\d+) declared=(\d+)/.exec(raw);
    if (led) {
      ledger = {
        total: Number(led[1]),
        passed: Number(led[2]),
        failed: Number(led[3]),
        declared: Number(led[4]),
      };
      continue;
    }
    if (/(^|\s)ERROR:/.test(raw)) errors.push(raw.trim());
  }
  return { markers, errors, ledger };
}

/** The whole gate as a pure function. Returns the list of problems; empty = pass. */
export function account({ assertionSql, expectationsText, log }) {
  const problems = [];
  const names = parseAssertionNames(assertionSql);
  const { expected, duplicates, malformed } = parseExpectations(expectationsText);

  for (const line of malformed) problems.push(`malformed expectation, ${line}`);
  for (const name of new Set(duplicates)) problems.push(`declared twice in the expectations: ${name}`);

  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) problems.push(`two assertions share the name: ${name}`);
    seen.add(name);
  }

  for (const name of seen) {
    if (!expected.has(name)) {
      problems.push(`assertion is not declared in the expectations: ${name}`);
    }
  }
  for (const name of expected.keys()) {
    if (!seen.has(name)) {
      problems.push(`declared in the expectations but no such assertion exists: ${name}`);
    }
  }

  const { markers, errors, ledger } = parseLog(log);
  const byName = new Map();
  for (const marker of markers) {
    if (!byName.has(marker.name)) byName.set(marker.name, []);
    byName.get(marker.name).push(marker.verdict);
  }
  for (const [name, verdicts] of byName) {
    if (verdicts.length > 1) {
      problems.push(`${verdicts.length} markers for one assertion (${verdicts.join(", ")}): ${name}`);
    }
    if (!expected.has(name)) problems.push(`marker for an undeclared assertion: ${name}`);
  }
  for (const [name, verdict] of expected) {
    const verdicts = byName.get(name);
    if (!verdicts) {
      problems.push(`no marker at all — the assertion did not run: ${name}`);
      continue;
    }
    if (verdicts[0] !== verdict) {
      problems.push(
        verdict === "fail"
          ? `passed against the un-remediated floor, so it proves nothing: ${name}`
          : `expected to hold against the floor but failed: ${name}`,
      );
    }
  }

  for (const line of errors) problems.push(`unclassified SQL error in the control run: ${line}`);

  const wantFail = [...expected.values()].filter((v) => v === "fail").length;
  const wantPass = expected.size - wantFail;
  if (wantFail === 0) problems.push("no assertion is declared load-bearing, so the control proves nothing");
  if (wantPass === 0) problems.push("every assertion is declared load-bearing; the floor-passing set cannot be empty");

  if (!ledger) {
    problems.push("the assertion file printed no ASSERT_LEDGER line, so nothing proves it ran to the end");
  } else {
    if (ledger.total !== ledger.declared) {
      problems.push(`ledger reached ${ledger.total} assertions, the file declares ${ledger.declared}`);
    }
    if (ledger.declared !== expected.size) {
      problems.push(`ledger declares ${ledger.declared} assertions, the expectations list ${expected.size}`);
    }
    if (ledger.failed !== wantFail || ledger.passed !== wantPass) {
      problems.push(
        `ledger split passed=${ledger.passed} failed=${ledger.failed}, expectations say passed=${wantPass} failed=${wantFail}`,
      );
    }
  }

  return { problems, names, expected, markers, ledger, wantFail, wantPass };
}

function argv(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) {
    console.error(`control-marker-accounting: missing ${flag}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("control-marker-accounting.mjs")) {
  const result = account({
    assertionSql: readFileSync(argv("--assertions"), "utf8"),
    expectationsText: readFileSync(argv("--expectations"), "utf8"),
    log: readFileSync(argv("--log"), "utf8"),
  });
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`  ${problem}`);
    console.error(
      `\ncontrol marker accounting failed: ${result.problems.length} problem(s) across ${result.expected.size} declared assertions`,
    );
    process.exit(1);
  }
  console.log(
    `control marker accounting OK: ${result.expected.size} assertions, ` +
      `${result.wantFail} load-bearing (one ASSERT_FAIL each), ${result.wantPass} floor-passing, ` +
      `0 unclassified SQL errors, ledger total=${result.ledger.total}`,
  );
}
