// ============================================================================
// P1-11: production history reconciliation, fail-closed on unknown drift
// ============================================================================
// The finding: `103/103` proves only that this repository's applied migrations are
// byte-identical to the PR base. It says nothing about production, and the gate
// that does ask production read only `version, name` — so a version recorded under
// the right name with the wrong SQL passed, and the seven production rows recorded
// with no statements at all passed too. The reviewer's own measurement against
// production found 18 differences: one 10-digit version, three production versions
// missing locally, eight same-version name mismatches, and six local baseline
// versions absent remotely but ordered before production's newest version.
//
// This file reproduces that shape synthetically — the exact counts, including the
// 10-digit stamp — and then holds the new behaviour to it:
//
//   * the old comparison still reports exactly those 18
//   * reading `statements` adds the seven rows the old gate could not see
//   * a database whose statements cannot be read at all is a refusal, not a pass
//   * a captured baseline is compared by count and fingerprint, in both
//     directions, and a baseline edited after capture is refused by its digest
//   * an acceptance can only ever explain a difference this gate measured for
//     itself: it must restate the observation, carry a reason and evidence,
//     require a capture, and an acceptance that matches nothing is its own refusal
//   * no acceptance can touch a claim failure — a false `applied_verified` is not
//     a historical difference
//
// There is no production capture in this file and none in the repository: the
// shipped supabase/migration-history-reconciliation.json is uncaptured and inert,
// which is asserted here. Capturing it is an authorised production action.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  auditHistory,
  compareHistories,
  rowsFingerprint,
  statementsFingerprint,
  FINGERPRINT_FORMAT,
  HISTORY_QUERY,
  STATEMENTS_FINGERPRINT_SQL,
  STATEMENTS_WELL_FORMED_SQL,
} from "../../scripts/verify-remote-migration-history.mjs";
import { splitSqlStatements } from "../../scripts/split-sql-statements.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/** 14-digit CLI stamps, ordered by construction. */
const v = (i) => `202601010000${String(i).padStart(2, "0")}`;

/**
 * The synthetic pair of histories, built to the review's measured shape.
 *
 *   i 0..7    eight versions applied under a different name than the release uses
 *   i 10..12  three versions production applied that the release does not contain
 *   i 20..26  seven versions recorded with NO statements
 *   i 30..34  five versions that agree in every respect
 *   i 40..45  six release migrations not applied, ordered before the newest applied
 *   i 50      the newest applied version
 *   plus      one 10-digit stamp that is not a CLI version at all
 */
function fixtures() {
  const remote = [];
  const local = [];
  const push = (i, { remoteName, localName, statements }) => {
    if (remoteName !== null) remote.push({ version: v(i), name: remoteName, statements });
    if (localName !== null) local.push({ version: v(i), name: localName, file: `${v(i)}_${localName}.sql` });
  };

  remote.push({ version: "1780601210", name: "workflow_stages", statements: ["create table x();"] });
  for (let i = 0; i <= 7; i += 1) {
    push(i, { remoteName: `mig_${i}`, localName: `mig_${i}_renamed`, statements: [`select ${i};`] });
  }
  for (let i = 10; i <= 12; i += 1) {
    push(i, { remoteName: `only_in_production_${i}`, localName: null, statements: [`select ${i};`] });
  }
  for (let i = 20; i <= 26; i += 1) {
    push(i, { remoteName: `no_statements_${i}`, localName: `no_statements_${i}`, statements: [] });
  }
  for (let i = 30; i <= 34; i += 1) {
    push(i, { remoteName: `agreed_${i}`, localName: `agreed_${i}`, statements: [`select ${i};`, "commit;"] });
  }
  for (let i = 40; i <= 45; i += 1) {
    push(i, { remoteName: null, localName: `local_baseline_${i}`, statements: null });
  }
  push(50, { remoteName: "newest_applied", localName: "newest_applied", statements: ["select 50;"] });

  local.sort((a, b) => a.version.localeCompare(b.version));
  return { remote, local };
}

/** What scripts/capture-remote-migration-history.mjs would write for those rows. */
function capturedFrom(remote, { accepted = [], digest = true, tamper = null, format = FINGERPRINT_FORMAT } = {}) {
  const rows = remote.map((row) => ({
    version: String(row.version),
    name: row.name,
    statement_count: Array.isArray(row.statements) ? row.statements.length : 0,
    statements_sha256: statementsFingerprint(row.statements),
  }));
  const capture = {
    captured_at: "2026-08-11T00:00:00.000Z",
    generator: "scripts/capture-remote-migration-history.mjs",
    url_file: "/etc/newme/migration-db.url",
    statements_measured: true,
    fingerprint_format: format,
    row_count: rows.length,
  };
  if (digest) capture.rows_sha256 = rowsFingerprint(rows);
  if (tamper) tamper(rows);
  return { capture, rows, accepted };
}

/**
 * What readLocalContent() would produce for those release files, without files.
 *
 * Faithful by default: every release migration parses into exactly the statements
 * production recorded for it, which is what round-4 C4 asks the gate to be able to
 * establish. `drift` names versions whose file parses into something else, and
 * `unreadable` names versions whose file cannot be opened at all.
 */
function localContentFrom(remote, local, { drift = [], unreadable = [], empty = [] } = {}) {
  const remoteByVersion = new Map(remote.map((row) => [String(row.version), row]));
  const byVersion = new Map();
  for (const entry of local) {
    if (unreadable.includes(entry.version)) {
      byVersion.set(entry.version, { file: entry.file, count: 0, fingerprint: null, error: "ENOENT" });
      continue;
    }
    if (empty.includes(entry.version)) {
      byVersion.set(entry.version, { file: entry.file, count: 0, fingerprint: statementsFingerprint([]), error: null });
      continue;
    }
    const recorded = remoteByVersion.get(entry.version)?.statements;
    const statements = drift.includes(entry.version) || !Array.isArray(recorded) || recorded.length === 0
      ? [`select 'only in the release';`]
      : recorded;
    byVersion.set(entry.version, {
      file: entry.file,
      count: statements.length,
      fingerprint: statementsFingerprint(statements),
      error: null,
    });
  }
  return byVersion;
}

/** The manifest versions the release declares — everything the release contains. */
const manifestOf = (local) => new Set(local.map((entry) => entry.version));

/**
 * auditHistory() with the two inputs a real run always has: the release's own
 * parsed content and its manifest. Built from the `remote` under test, so a test
 * that mutates production is testing the baseline comparison rather than
 * accidentally also testing the local one; the tests that are about a MISSING
 * local parse call auditHistory() directly.
 */
function audit({ remote, local, ...rest }) {
  return auditHistory({
    localContent: localContentFrom(remote, local),
    manifestVersions: manifestOf(local),
    remote,
    local,
    ...rest,
  });
}

const WHY = "production applied this before the repository baseline existed; recorded here so it is explained, not hidden";
const EVIDENCE = "supabase/preflight/migration-history-reconciliation.md §3, capture of 2026-08-11";

const kinds = (problems, needle) => problems.filter((p) => p.includes(needle)).length;

test("the review's 18 differences are reproduced by the version/name comparison", () => {
  const { remote, local } = fixtures();
  const problems = compareHistories({ remote, local });

  assert.equal(problems.length, 18, `expected the measured shape, got:\n${problems.join("\n")}`);
  assert.equal(kinds(problems, "is not a 14-digit CLI stamp"), 1);
  assert.ok(problems.some((p) => p.includes('"1780601210"')), "the 10-digit stamp must be named");
  assert.equal(kinds(problems, "applied history was deleted or renamed"), 3);
  assert.equal(kinds(problems, "applied history was renamed"), 8);
  assert.equal(kinds(problems, "it can never be applied in order"), 6);
});

test("reading statements adds the seven rows the old gate could not see", () => {
  const { remote, local } = fixtures();
  const { problems } = audit({ remote, local });

  assert.equal(kinds(problems, "with no statements"), 7);
  assert.equal(problems.length, 25, `18 structural + 7 content, got:\n${problems.join("\n")}`);
  // Each one names its version, so a reader can act on it without a database.
  for (let i = 20; i <= 26; i += 1) {
    assert.ok(
      problems.some((p) => p.includes(v(i)) && p.includes("cannot be verified from the history")),
      `${v(i)} was not reported as unverifiable`,
    );
  }
});

test("a database whose statements cannot be read is a refusal, not agreement", () => {
  const { remote, local } = fixtures();
  const rows = remote.map(({ version, name }) => ({ version, name })); // the old two-column shape
  const { problems } = audit({ remote: rows, local, statementsRead: false });

  assert.ok(
    problems.some((p) => p.includes("no readable statements column") && p.includes("cannot be measured")),
    `expected the unmeasurable case to refuse, got:\n${problems.join("\n")}`,
  );
  // And it does not additionally pretend to know about individual rows.
  assert.equal(kinds(problems, "with no statements"), 0);
});

test("rows that carry neither statements nor a measurement count as unverified", () => {
  // The failure mode this guards: someone drops the content columns from the query
  // and every row silently becomes "fine" again.
  const { remote, local } = fixtures();
  const rows = remote.map(({ version, name }) => ({ version, name }));
  const { problems } = audit({ remote: rows, local, statementsRead: true });
  assert.equal(kinds(problems, "with no statements"), remote.length);
});

test("a matching captured baseline adds nothing, and both drift directions refuse", () => {
  const { remote, local } = fixtures();
  const base = audit({ remote, local }).problems.length;

  const clean = audit({ remote, local, reconciliation: capturedFrom(remote) });
  assert.equal(clean.problems.length, base, "a baseline that matches production must add no problems");

  // Content changed under a version whose name and count are unchanged — the exact
  // defect version+name cannot see.
  const rewritten = remote.map((row) =>
    row.version === v(30) ? { ...row, statements: ["select 999;", "commit;"] } : row,
  );
  const drift = audit({ remote: rewritten, local, reconciliation: capturedFrom(remote) });
  assert.ok(
    drift.problems.some((p) => p.includes(v(30)) && p.includes("different statement fingerprint")),
    `expected content drift to be reported, got:\n${drift.problems.join("\n")}`,
  );

  // A count change is reported as a count change, not as an opaque hash mismatch.
  const shorter = remote.map((row) => (row.version === v(31) ? { ...row, statements: ["select 31;"] } : row));
  const counted = audit({ remote: shorter, local, reconciliation: capturedFrom(remote) });
  assert.ok(
    counted.problems.some((p) => p.includes(v(31)) && p.includes("statement(s) but the database now reports 1")),
    `expected a count difference to be reported, got:\n${counted.problems.join("\n")}`,
  );

  // Production ahead of the baseline: refused unless it is this release's claimed,
  // manifested, content-verified delta, which is the C5 test below.
  const ahead = [...remote, { version: v(60), name: "applied_after_capture", statements: ["select 60;"] }];
  assert.ok(
    audit({ remote: ahead, local, reconciliation: capturedFrom(remote) }).problems.some(
      (p) => p.includes(v(60)) && p.includes("captured baseline does not contain it"),
    ),
    "an unexplained version applied after the capture must refuse",
  );
  const behind = remote.filter((row) => row.version !== v(32));
  assert.ok(
    audit({ remote: behind, local, reconciliation: capturedFrom(remote) }).problems.some(
      (p) => p.includes(v(32)) && p.includes("applied history was removed from production"),
    ),
    "history removed from production must refuse",
  );
});

test("a baseline edited after capture is refused by its own digest", () => {
  const { remote, local } = fixtures();
  const tampered = capturedFrom(remote, {
    tamper: (rows) => {
      rows[5].name = "quietly_relabelled";
    },
  });
  assert.ok(
    audit({ remote, local, reconciliation: tampered }).problems.some((p) =>
      p.includes("edited after it was captured"),
    ),
    "a hand-edited baseline must be refused",
  );

  const undigested = capturedFrom(remote, { digest: false });
  assert.ok(
    audit({ remote, local, reconciliation: undigested }).problems.some((p) =>
      p.includes("cannot be shown to be the one that was captured"),
    ),
    "a baseline with no digest must be refused",
  );

  const provenanceless = { capture: null, rows: capturedFrom(remote).rows, accepted: [] };
  assert.ok(
    audit({ remote, local, reconciliation: provenanceless }).problems.some((p) =>
      p.includes("records no capture"),
    ),
    "rows with no capture block must be refused",
  );
});

test("an acceptance explains exactly the difference it restates, and nothing else", () => {
  const { remote, local } = fixtures();
  const base = audit({ remote, local }).problems.length;

  const accepted = [];
  for (let i = 0; i <= 7; i += 1) {
    accepted.push({
      kind: "name_mismatch",
      version: v(i),
      remote_name: `mig_${i}`,
      local_name: `mig_${i}_renamed`,
      why: WHY,
      evidence: EVIDENCE,
    });
  }
  const result = audit({ remote, local, reconciliation: capturedFrom(remote, { accepted }) });
  assert.equal(result.reconciled.length, 8);
  assert.equal(result.problems.length, base - 8, `only the eight named differences may be explained:\n${result.problems.join("\n")}`);
  assert.equal(kinds(result.problems, "applied history was renamed"), 0);
  // The reason and the evidence travel with it, so the deploy log still names it.
  for (const entry of result.reconciled) {
    assert.equal(entry.kind, "name_mismatch");
    assert.equal(entry.why, WHY);
    assert.equal(entry.evidence, EVIDENCE);
  }
  // …and it explains one difference, not the class: seven more remain unexplained
  // if only one is written.
  const one = audit({
    remote,
    local,
    reconciliation: capturedFrom(remote, { accepted: [accepted[0]] }),
  });
  assert.equal(one.reconciled.length, 1);
  assert.equal(kinds(one.problems, "applied history was renamed"), 7);
});

test("an acceptance that does not describe production is itself a refusal", () => {
  const { remote, local } = fixtures();
  const good = {
    kind: "name_mismatch",
    version: v(0),
    remote_name: "mig_0",
    local_name: "mig_0_renamed",
    why: WHY,
    evidence: EVIDENCE,
  };

  const mutations = [
    [{ ...good, local_name: "mig_0_renamed_again" }, "did not observe"],
    [{ ...good, remote_name: "mig_0_something_else" }, "did not observe"],
    [{ ...good, version: v(99) }, "did not observe"],
    [{ ...good, why: "typo" }, "must state why"],
    [{ ...good, evidence: "" }, "must state why"],
    [{ ...good, kind: "duplicate_version" }, "not a difference this gate lets anyone accept"],
    [{ ...good, kind: "fixture_content_drift" }, "not a difference this gate lets anyone accept"],
  ];
  for (const [entry, needle] of mutations) {
    const { problems, reconciled } = audit({
      remote,
      local,
      reconciliation: capturedFrom(remote, { accepted: [entry] }),
    });
    assert.equal(reconciled.length, 0, `${JSON.stringify(entry.kind)} must not reconcile: ${needle}`);
    assert.ok(
      problems.some((p) => p.includes(needle)),
      `expected ${needle}, got:\n${problems.join("\n")}`,
    );
    // The difference it failed to explain is still reported.
    if (needle === "did not observe") {
      assert.ok(problems.some((p) => p.includes(v(0)) && p.includes("applied history was renamed")));
    }
  }

  // Two acceptances cannot explain the same single difference.
  const doubled = audit({
    remote,
    local,
    reconciliation: capturedFrom(remote, { accepted: [good, { ...good }] }),
  });
  assert.equal(doubled.reconciled.length, 1);
  assert.ok(doubled.problems.some((p) => p.includes("did not observe")));
});

test("an acceptance without a captured baseline explains nothing", () => {
  const { remote, local } = fixtures();
  const accepted = [
    {
      kind: "no_statements",
      version: v(20),
      remote_name: "no_statements_20",
      why: WHY,
      evidence: EVIDENCE,
    },
  ];
  const uncaptured = audit({ remote, local, reconciliation: { capture: null, rows: [], accepted } });
  assert.equal(uncaptured.reconciled.length, 0);
  assert.ok(
    uncaptured.problems.some((p) => p.includes("without read-only evidence is not a reconciliation")),
    `expected the evidence requirement, got:\n${uncaptured.problems.join("\n")}`,
  );
  assert.ok(uncaptured.problems.some((p) => p.includes(v(20)) && p.includes("no statements")));
  // And the file itself is reported, not only the acceptance inside it: round-4 C4
  // is that "the baseline agrees" and "there is no baseline" reached the same
  // outcome, so the absence has to be a finding of its own.
  assert.ok(
    uncaptured.problems.some((p) => p.includes("records no capture") && p.includes("has never been read")),
    "an uncaptured reconciliation must refuse on its own account",
  );

  // A capture block over an empty row set is a captured baseline, so the acceptance
  // does match — and the run still refuses, because a baseline containing none of
  // production's rows cannot account for any of them.
  const emptyBaseline = audit({
    remote,
    local,
    reconciliation: {
      capture: {
        captured_at: "x",
        statements_measured: true,
        fingerprint_format: FINGERPRINT_FORMAT,
        rows_sha256: rowsFingerprint([]),
      },
      rows: [],
      accepted,
    },
  });
  assert.equal(emptyBaseline.reconciled.length, 1, "the acceptance describes an observed difference");
  assert.equal(
    emptyBaseline.problems.filter((p) => p.includes("captured baseline does not contain it")).length,
    remote.length,
    `every production row must be unaccounted for, got:\n${emptyBaseline.problems.join("\n")}`,
  );
});

test("a capture whose content or encoding cannot be compared is refused", () => {
  const { remote, local } = fixtures();

  const unmeasured = capturedFrom(remote);
  unmeasured.capture.statements_measured = false;
  assert.ok(
    audit({ remote, local, reconciliation: unmeasured }).problems.some((p) =>
      p.includes("statements were not measurable when it was taken"),
    ),
    "a baseline captured without content must not read as agreement",
  );

  // The previous encoding folded the element count in and joined the elements with
  // a space, so its digests are numerically fine and semantically meaningless here.
  const stale = capturedFrom(remote, { format: "statements-v1-space-joined" });
  const problems = audit({ remote, local, reconciliation: stale }).problems;
  assert.ok(
    problems.some((p) => p.includes("must be captured again") && p.includes("statements-v1-space-joined")),
    `expected the stale encoding to be named, got:\n${problems.join("\n")}`,
  );

  const undeclared = capturedFrom(remote);
  delete undeclared.capture.fingerprint_format;
  assert.ok(
    audit({ remote, local, reconciliation: undeclared }).problems.some((p) => p.includes("must be captured again")),
    "a capture that does not say which encoding it used must be refused",
  );
});

test("the seven no-statement rows are reconcilable, one row at a time", () => {
  // This is the production case: those rows exist, their content is unprovable, and
  // the only honest resolutions are to record why each is expected or to refuse.
  const { remote, local } = fixtures();
  const accepted = [];
  for (let i = 20; i <= 26; i += 1) {
    accepted.push({
      kind: "no_statements",
      version: v(i),
      remote_name: `no_statements_${i}`,
      why: WHY,
      evidence: EVIDENCE,
    });
  }
  const { problems, reconciled } = audit({
    remote,
    local,
    reconciliation: capturedFrom(remote, { accepted }),
  });
  assert.equal(reconciled.length, 7);
  assert.equal(kinds(problems, "with no statements"), 0);
  // The other 18 are untouched: reconciling content says nothing about structure.
  assert.equal(problems.length, 18);
});

test("no acceptance can explain away a false claim", () => {
  // `applied_verified` is a claim the deploy made about itself, not a historical
  // difference, so it is deliberately outside the reconcilable set.
  const { remote, local } = fixtures();
  const version = v(70);
  const accepted = [
    { kind: "claim_not_applied", version, why: WHY, evidence: EVIDENCE },
    { kind: "remote_only", version, remote_name: "", why: WHY, evidence: EVIDENCE },
  ];
  const { problems, reconciled } = audit({
    remote,
    local,
    requireApplied: [version],
    reconciliation: capturedFrom(remote, { accepted }),
  });
  assert.equal(reconciled.length, 0);
  assert.ok(problems.some((p) => p.includes("the database has no record of") && p.includes(version)));
  assert.ok(problems.some((p) => p.includes("not a difference this gate lets anyone accept")));

  // Same for the no-pending claim.
  const noPending = audit({
    remote,
    local,
    requireNoPending: true,
    reconciliation: capturedFrom(remote, {
      accepted: [{ kind: "claim_no_pending", version: null, why: WHY, evidence: EVIDENCE }],
    }),
  });
  assert.ok(noPending.problems.some((p) => p.includes("declared to need no migrations")));
  assert.equal(noPending.reconciled.length, 0);
});

test("an erased history is still the first thing reported", () => {
  const { local } = fixtures();
  const { problems } = audit({ remote: [], local, reconciliation: capturedFrom([]) });
  assert.ok(problems[0].includes("zero applied migrations"));
});

test("the fingerprints are stable and separate content from structure", () => {
  // Fixed vectors: a change to either function is a change to every recorded
  // baseline, so it has to be a deliberate one.
  assert.notEqual(statementsFingerprint(["a", "b"]), statementsFingerprint(["a b"]));
  assert.equal(statementsFingerprint(["select 1;"]), statementsFingerprint(["select 1;"]));

  // Round-4 C4-6. The two vectors above used to sit beside two more that asserted
  // the opposite of what this gate needs: `statementsFingerprint([])` equal to
  // `statementsFingerprint(null)`, and `["a"]` merely unequal to `["a",""]`. Both
  // were consequences of coercing a missing element to the empty string, and
  // coercion is what makes a digest lie — a null column and an empty array reached
  // the same value, so a row that records nothing could satisfy a comparison
  // against a release that records something. The domain is now narrow and
  // everything outside it throws, because a thrown error cannot be compared into a
  // pass the way two nulls can.
  for (const [value, why] of [
    [null, "the value is null"],
    [undefined, "the value is undefined"],
    ["select 1;", "the value is string"],
    [["ok", null], "element 2 is null"],
    [["ok", undefined], "element 2 is undefined"],
    [["ok", ""], "element 2 is empty"],
    [["", "select 1;"], "element 1 is empty"],
    [["ok", 7], "element 2 is of type number"],
    [[["a"], ["b"]], "element 1 is itself an array"],
  ]) {
    assert.throws(
      () => statementsFingerprint(value),
      (error) => {
        assert.equal(error.code, "unfingerprintable_statements");
        assert.ok(error.reason.startsWith(why), `${why} — reported instead: ${error.reason}`);
        return true;
      },
      `${why} must not be fingerprintable`,
    );
  }
  // The empty array stays inside the domain: zero statements is a shape the CLI
  // really records (production has seven such rows) and it is handled as the
  // `no_statements` acceptance, not as a digest that cannot be computed.
  assert.equal(statementsFingerprint([]).length, 64);
  assert.notEqual(statementsFingerprint([]), statementsFingerprint(["a"]));

  const rows = [{ version: "1", name: "n", statement_count: 1, statements_sha256: "abc" }];
  assert.equal(rowsFingerprint(rows), rowsFingerprint([...rows]));
  assert.notEqual(rowsFingerprint(rows), rowsFingerprint([{ ...rows[0], name: "m" }]));
  assert.notEqual(rowsFingerprint(rows), rowsFingerprint([{ ...rows[0], statements_sha256: "abd" }]));
});

test("the gate asks the server for the fingerprint, never for the statements", () => {
  const source = read("scripts/verify-remote-migration-history.mjs");
  assert.ok(HISTORY_QUERY, "HISTORY_QUERY must be exported so the capture script runs the same one");
  // Asserted on the built query rather than on the source text, because the digest
  // expression is now interpolated: it has three callers — this gate, the capture,
  // and the read-after-write check in scripts/db-phase-push.mjs, which must write
  // rows this gate can reproduce — and a second copy of it in any of them is a
  // second encoding no side can see. So: one definition in the source, interpolated
  // into the query, and the query still asks for a digest and never for the text.
  assert.match(source, /export const STATEMENTS_FINGERPRINT_SQL = `case when \$\{STATEMENTS_WELL_FORMED_SQL\} then encode\(sha256\(/);
  assert.match(source, /\$\{STATEMENTS_FINGERPRINT_SQL\} as statements_sha256/);
  // Round-4 C4-6: the domain predicate is one definition too, interpolated into the
  // digest AND into the count. A count computed outside it would describe a value
  // the digest declined to describe, and the pair would disagree about the same row.
  assert.equal(
    source.split("export const STATEMENTS_WELL_FORMED_SQL").length - 1,
    1,
    "the well-formedness predicate is written more than once in this module",
  );
  assert.match(source, /case when \$\{STATEMENTS_WELL_FORMED_SQL\} then cardinality\(m\.statements\) end as statement_count/);
  assert.equal(
    source.split("encode(sha256(").length - 1,
    1,
    "the digest expression is written more than once in this module",
  );
  const query = [HISTORY_QUERY];
  assert.match(query[0], /encode\(sha256\(/);
  assert.doesNotMatch(query[0], /select m?\.?version,\s*\n?\s*m?\.?name,\s*\n?\s*m?\.?statements\b/);
  assert.match(query[0], /^\s*from supabase_migrations\.schema_migrations m$/m);
  // The expression is written against `m`, so any query interpolating it has to
  // alias the history table that way — a silent requirement otherwise.
  assert.match(STATEMENTS_FINGERPRINT_SQL, /m\.statements/);

  // Length-delimited on both sides, and no space-joined encoding anywhere: round-4
  // C4 is that joining with a separator lets ["a","b c"] and ["a b","c"] collide,
  // so a statement boundary could move without the fingerprint moving.
  assert.doesNotMatch(query[0], /array_to_string\(/);
  // One backslash, not two: the built query carries the E-string escape the source
  // had to write twice. And no coalesce around the element: C4-6 measured
  // `coalesce(s.statement,'')` mapping a NULL element onto an empty one, which gave
  // `{ok,NULL}` and `{ok,''}` the same count and the same digest on PostgreSQL
  // 17.10. Both are now outside the domain instead of being equal inside it.
  assert.match(query[0], /octet_length\(convert_to\(s\.statement, 'UTF8'\)\)::text \|\| E'\\n'/);
  assert.doesNotMatch(query[0], /coalesce\(s\.statement/);
  assert.match(query[0], /order by s\.ord/);
  // The four ways a text[] can be malformed, each refused by the server side rather
  // than coerced into a comparable value. `array_ndims` and `array_lower` are NULL
  // for an empty array while `cardinality` is 0, so the coalesce admits `'{}'` and
  // nothing else: a 2-D array, a non-standard lower bound, a NULL column and a NULL
  // or empty element all fall out.
  assert.match(STATEMENTS_WELL_FORMED_SQL, /m\.statements is not null/);
  assert.match(STATEMENTS_WELL_FORMED_SQL, /coalesce\(array_ndims\(m\.statements\), 1\) = 1/);
  assert.match(STATEMENTS_WELL_FORMED_SQL, /coalesce\(array_lower\(m\.statements, 1\), 1\) = 1/);
  assert.match(STATEMENTS_WELL_FORMED_SQL, /bad\.statement is null or bad\.statement = ''/);
  // cardinality, not array_length: array_length(a,1) counts dimension 1 while
  // unnest flattens, so on a 2-D array the header would not describe the payload
  // (measured: 2x2 gives array_length 2 and cardinality 4). The predicate refuses
  // 2-D outright, and the count agrees with the elements the digest hashes.
  assert.doesNotMatch(query[0], /array_length\(m\.statements/);
  assert.match(source, /hash\.update\(`\$\{statements\.length\}\\n`\)/);
  assert.match(source, /hash\.update\(`\$\{bytes\.length\}\\n`\)/);

  // The old encoding is what these two vectors collided under; sha256("2 a b c") is
  // one value, so the regression is stated as a measurement rather than a comment.
  const spaceJoined = (list) =>
    createHash("sha256").update(`${list.length}`).update(list.map((s) => ` ${s}`).join("")).digest("hex");
  assert.equal(spaceJoined(["a", "b c"]), spaceJoined(["a b", "c"]), "the old encoding did collide");
  assert.notEqual(statementsFingerprint(["a", "b c"]), statementsFingerprint(["a b", "c"]));

  const capture = read("scripts/capture-remote-migration-history.mjs");
  assert.match(capture, /import \{ fetchRemoteHistory, rowsFingerprint, FINGERPRINT_FORMAT \}/);
  assert.match(capture, /fingerprint_format: FINGERPRINT_FORMAT/);
  assert.doesNotMatch(capture, /statements_sha256: [^n]*row\.statements\b/);

  // The parity drill that holds this query against statementsFingerprint() on a
  // real server is wired into CI, not left as a hand-run script.
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /scripts\/statements-fingerprint-parity\.mjs/);
});

test("the reconciliation shipped in this repository is uncaptured, and refuses", () => {
  const shipped = JSON.parse(read("supabase/migration-history-reconciliation.json"));
  assert.equal(shipped.capture, null, "no production capture may be committed by a code round");
  assert.deepEqual(shipped.rows, []);
  assert.deepEqual(shipped.accepted, []);
  assert.ok(
    shipped._comment.join(" ").includes("NOT CAPTURED"),
    "the file must say what state it is in",
  );

  // Round-4 C4's second half. This used to be asserted as *inert* — passing the
  // file changed no verdict — and the claim that the deploy gate therefore refuses
  // until the capture happens rested on production having differences to find,
  // which is a statement about production, not about the gate. Now the absence of
  // a capture is itself the refusal, so the property holds against any database.
  const { remote, local } = fixtures();
  const withFile = audit({ remote, local, reconciliation: shipped }).problems;
  const without = audit({ remote, local }).problems;
  assert.deepEqual(
    withFile.filter((p) => !without.includes(p)),
    ["a reconciliation file was supplied but records no capture: production's recorded history has never been read, so nothing in this run compares it to anything"],
  );

  // A database this release agrees with completely: still refused, because nobody
  // has read production's history.
  const agreed = local.map((entry) => ({ version: entry.version, name: entry.name, statements: [`select ${entry.version};`] }));
  const clean = audit({ remote: agreed, local });
  assert.deepEqual(clean.problems, [], "the synthetic agreeing database must otherwise pass");
  assert.deepEqual(audit({ remote: agreed, local, reconciliation: shipped }).problems, [
    "a reconciliation file was supplied but records no capture: production's recorded history has never been read, so nothing in this run compares it to anything",
  ]);
});

test("every recorded row is compared with this release's own file", () => {
  // Round-4 C4. The capture comparison proves production has not changed since it
  // was read. This is the other half: production's recorded statements against the
  // statements this release's files parse into. Without it the gate could only ever
  // say "production is stable", never "production ran this".
  const { remote, local } = fixtures();
  const { problems, reproduced } = audit({ remote, local });

  // The five agreeing rows plus the eight renamed ones plus the newest applied:
  // every row that has a local file and recorded statements. Not the three
  // production-only rows (no file), and not the seven with nothing recorded.
  assert.equal(reproduced.length, 14);
  for (let i = 20; i <= 26; i += 1) {
    assert.ok(!reproduced.includes(v(20)), "a row with no statements is never counted as reproduced");
  }
  assert.equal(kinds(problems, "is not what this release carries"), 0);

  // Content changed under an unchanged version and name, with no capture in sight:
  // the release's own file is enough to catch it.
  const drifted = audit({
    remote,
    local,
    localContent: localContentFrom(remote, local, { drift: [v(30)] }),
    manifestVersions: manifestOf(local),
  });
  assert.ok(
    drifted.problems.some((p) => p.includes(v(30)) && p.includes("is not what this release carries")),
    `expected a content difference against the local file, got:\n${drifted.problems.join("\n")}`,
  );
  assert.ok(!drifted.reproduced.includes(v(30)));

  // A file that cannot be opened, and one that parses into nothing, are refusals —
  // not silent skips, which is how the previous gate treated everything local.
  const unreadable = audit({
    remote,
    local,
    localContent: localContentFrom(remote, local, { unreadable: [v(31)] }),
    manifestVersions: manifestOf(local),
  });
  assert.ok(unreadable.problems.some((p) => p.includes(v(31)) && p.includes("could not be read")));

  const empty = audit({
    remote,
    local,
    localContent: localContentFrom(remote, local, { empty: [v(32)] }),
    manifestVersions: manifestOf(local),
  });
  assert.ok(empty.problems.some((p) => p.includes("parses into no statements at all")));

  // And no local parse at all is one refusal that names the missing half, rather
  // than a run that quietly compares nothing.
  const unparsed = auditHistory({ remote, local });
  assert.ok(
    unparsed.problems.some((p) => p.includes("were not parsed into statements")),
    "a run without the local parse must say so",
  );
  assert.equal(unparsed.reproduced.length, 0);
});

test("a CRLF checkout is one refusal, not a hundred content differences", () => {
  // Every migration blob in this repository is LF. A CRLF working file therefore
  // means the checkout rewrote it — core.autocrlf on Windows — and fingerprinting
  // it compares bytes production never applied. Reported once, by cause: the
  // alternative is a deploy log full of content drift that looks like production
  // was tampered with.
  const { remote, local } = fixtures();
  const rewritten = localContentFrom(remote, local);
  for (const row of rewritten.values()) row.crlf = true;

  const { problems, reproduced } = audit({
    remote,
    local,
    localContent: rewritten,
    manifestVersions: manifestOf(local),
  });
  assert.equal(kinds(problems, "CRLF line endings"), 1);
  assert.ok(problems.some((p) => p.includes("core.autocrlf=false")));
  // And no per-row content claim in either direction.
  assert.equal(kinds(problems, "is not what this release carries"), 0);
  assert.equal(reproduced.length, 0);
});

test("a content difference is historical, or it is a false claim", () => {
  // C5's other half. Production applied its history through CLI versions this
  // release does not pin, so a recorded array whose boundaries differ from this
  // release's parse of the same file is explainable for an old row.
  const { remote, local } = fixtures();
  const localContent = localContentFrom(remote, local, { drift: [v(30)] });
  const observed = {
    kind: "content_not_locally_reproducible",
    version: v(30),
    remote_name: "agreed_30",
    remote_count: "2",
    local_count: "1",
    why: WHY,
    evidence: EVIDENCE,
  };
  const historical = auditHistory({
    remote,
    local,
    localContent,
    manifestVersions: manifestOf(local),
    reconciliation: capturedFrom(remote, { accepted: [observed] }),
  });
  assert.equal(historical.reconciled.length, 1);
  assert.equal(kinds(historical.problems, "is not what this release carries"), 0);

  // But not for a version this release claims to have just applied. That is the
  // deploy applying something other than what it shipped, and no acceptance
  // written in advance may excuse it.
  const claimed = auditHistory({
    remote,
    local,
    requireApplied: [v(30)],
    localContent,
    manifestVersions: manifestOf(local),
    reconciliation: capturedFrom(remote, { accepted: [observed] }),
  });
  assert.equal(claimed.reconciled.length, 0);
  assert.ok(
    claimed.problems.some((p) => p.includes(v(30)) && p.includes("is not what this release carries")),
    `the content difference must survive for a claimed version, got:\n${claimed.problems.join("\n")}`,
  );
  assert.ok(
    claimed.problems.some((p) => p.includes("a claimed migration's content cannot be excused")),
    `the acceptance itself must be refused, got:\n${claimed.problems.join("\n")}`,
  );
});

test("the post-capture delta is admitted only on all five conditions", () => {
  // Round-4 C5. Before this, any row applied after the capture was reported as a
  // stale baseline, so a deploy could not apply a migration without invalidating
  // the baseline that let it deploy — a deadlock resolvable only by recapturing
  // production between two steps of the same release.
  //
  // The way out is not to relax the baseline but to require something stronger for
  // the one row that bypasses it: it sorts after everything captured, this release
  // contains it, the release manifest declares it, the command line claims it, and
  // its recorded content was reproduced from this release's own file. The last
  // condition is what makes the bypass safe.
  const { remote, local } = fixtures();
  const version = v(60);
  const name = "expand_phase";
  const file = `${version}_${name}.sql`;
  const statements = ["alter table contracts add column x int;"];

  const ahead = [...remote, { version, name, statements }];
  const localAhead = [...local, { version, name, file }];
  const capture = capturedFrom(remote); // taken BEFORE the delta was applied
  const full = {
    remote: ahead,
    local: localAhead,
    requireApplied: [version],
    localContent: localContentFrom(ahead, localAhead),
    manifestVersions: manifestOf(localAhead),
    reconciliation: capture,
  };

  const allowed = auditHistory(full);
  assert.deepEqual(
    allowed.deltas,
    [{ version, file }],
    `the claimed delta must be admitted and named, got:\n${allowed.problems.join("\n")}`,
  );
  assert.equal(kinds(allowed.problems, "captured baseline does not contain it"), 0);
  assert.ok(allowed.reproduced.includes(version));
  // And admitting it changes nothing else: the same 18 structural differences.
  assert.equal(allowed.problems.length, audit({ remote, local }).problems.length);

  // Now each condition, removed one at a time. Every one of them must turn the
  // delta back into a refusal, because each is load-bearing on its own.
  const refuses = (label, override, expected = version) => {
    const result = auditHistory({ ...full, ...override });
    assert.deepEqual(result.deltas, [], `${label}: the delta must not be admitted`);
    assert.ok(
      result.problems.some((p) => p.includes(expected) && p.includes("captured baseline does not contain it")),
      `${label}: expected the baseline refusal, got:\n${result.problems.join("\n")}`,
    );
  };

  // 1 · not claimed on the command line.
  refuses("unclaimed", { requireApplied: [] });
  // 2 · not declared in the release manifest.
  refuses("unmanifested", { manifestVersions: manifestOf(local) });
  // 3 · no manifest read at all.
  refuses("no manifest", { manifestVersions: null });
  // 4 · content not reproducible from this release's file.
  refuses("content drift", { localContent: localContentFrom(ahead, localAhead, { drift: [version] }) });
  // 5 · the release does not contain the file.
  refuses("not in the release", {
    local,
    localContent: localContentFrom(ahead, local),
    manifestVersions: manifestOf(local),
  });
  // 6 · and the ordering condition: a row that sorts BEFORE the newest captured
  //     version is not a post-capture delta at all, whatever else is true of it.
  const inside = v(33);
  const withoutInside = remote.filter((row) => row.version !== inside);
  refuses(
    "inside the captured range",
    { remote, requireApplied: [inside], reconciliation: capturedFrom(withoutInside) },
    inside,
  );
});

test("the deploy gate passes the reconciliation and the document explains it", () => {
  const wrapper = read("infra/systemd/newme-deploy.sh");
  assert.match(wrapper, /--history-fixture/);
  assert.match(wrapper, /migration-history-reconciliation\.json/);
  // The wrapper must keep failing the deploy on the gate's exit code.
  assert.match(wrapper, /production migration history does not match the release being deployed/);

  const doc = read("supabase/preflight/migration-history-reconciliation.md");
  assert.match(doc, /Status: \*\*NOT CAPTURED\.\*\*/);
  assert.match(doc, /\*\*\[AUTHORISED ACTION\]/);
  assert.match(doc, /capture-remote-migration-history\.mjs/);
  // The counts the reviewer measured are recorded as the thing to reconcile.
  for (const count of ["one", "three", "eight", "six", "seven"]) {
    assert.ok(doc.includes(count), `the document must account for the ${count} differences`);
  }
  // Read-only only: the document tells an operator what to run against production.
  const blocks = [...doc.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  const forbidden = /^\s*(insert|update|delete|alter|drop|grant|revoke|truncate|create|call|do|set|copy)\b/i;
  for (const block of blocks) {
    for (const line of block.split(/\r?\n/)) {
      if (/^\s*--/.test(line) || !line.trim()) continue;
      assert.ok(!forbidden.test(line), `a documented query mutates production: ${line.trim()}`);
    }
  }
});
