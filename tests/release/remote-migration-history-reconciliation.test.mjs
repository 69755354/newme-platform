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
import path from "node:path";

import {
  auditHistory,
  compareHistories,
  rowsFingerprint,
  statementsFingerprint,
} from "../../scripts/verify-remote-migration-history.mjs";

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
function capturedFrom(remote, { accepted = [], digest = true, tamper = null } = {}) {
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
    row_count: rows.length,
  };
  if (digest) capture.rows_sha256 = rowsFingerprint(rows);
  if (tamper) tamper(rows);
  return { capture, rows, accepted };
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
  const { problems } = auditHistory({ remote, local });

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
  const { problems } = auditHistory({ remote: rows, local, statementsRead: false });

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
  const { problems } = auditHistory({ remote: rows, local, statementsRead: true });
  assert.equal(kinds(problems, "with no statements"), remote.length);
});

test("a matching captured baseline adds nothing, and both drift directions refuse", () => {
  const { remote, local } = fixtures();
  const base = auditHistory({ remote, local }).problems.length;

  const clean = auditHistory({ remote, local, reconciliation: capturedFrom(remote) });
  assert.equal(clean.problems.length, base, "a baseline that matches production must add no problems");

  // Content changed under a version whose name and count are unchanged — the exact
  // defect version+name cannot see.
  const rewritten = remote.map((row) =>
    row.version === v(30) ? { ...row, statements: ["select 999;", "commit;"] } : row,
  );
  const drift = auditHistory({ remote: rewritten, local, reconciliation: capturedFrom(remote) });
  assert.ok(
    drift.problems.some((p) => p.includes(v(30)) && p.includes("different statement fingerprint")),
    `expected content drift to be reported, got:\n${drift.problems.join("\n")}`,
  );

  // A count change is reported as a count change, not as an opaque hash mismatch.
  const shorter = remote.map((row) => (row.version === v(31) ? { ...row, statements: ["select 31;"] } : row));
  const counted = auditHistory({ remote: shorter, local, reconciliation: capturedFrom(remote) });
  assert.ok(
    counted.problems.some((p) => p.includes(v(31)) && p.includes("statement(s) but the database now reports 1")),
    `expected a count difference to be reported, got:\n${counted.problems.join("\n")}`,
  );

  // Production ahead of the baseline, and production behind it.
  const ahead = [...remote, { version: v(60), name: "applied_after_capture", statements: ["select 60;"] }];
  assert.ok(
    auditHistory({ remote: ahead, local, reconciliation: capturedFrom(remote) }).problems.some(
      (p) => p.includes(v(60)) && p.includes("baseline is older than production"),
    ),
    "a version applied after the capture must refuse",
  );
  const behind = remote.filter((row) => row.version !== v(32));
  assert.ok(
    auditHistory({ remote: behind, local, reconciliation: capturedFrom(remote) }).problems.some(
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
    auditHistory({ remote, local, reconciliation: tampered }).problems.some((p) =>
      p.includes("edited after it was captured"),
    ),
    "a hand-edited baseline must be refused",
  );

  const undigested = capturedFrom(remote, { digest: false });
  assert.ok(
    auditHistory({ remote, local, reconciliation: undigested }).problems.some((p) =>
      p.includes("cannot be shown to be the one that was captured"),
    ),
    "a baseline with no digest must be refused",
  );

  const provenanceless = { capture: null, rows: capturedFrom(remote).rows, accepted: [] };
  assert.ok(
    auditHistory({ remote, local, reconciliation: provenanceless }).problems.some((p) =>
      p.includes("records no capture"),
    ),
    "rows with no capture block must be refused",
  );
});

test("an acceptance explains exactly the difference it restates, and nothing else", () => {
  const { remote, local } = fixtures();
  const base = auditHistory({ remote, local }).problems.length;

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
  const result = auditHistory({ remote, local, reconciliation: capturedFrom(remote, { accepted }) });
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
  const one = auditHistory({
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
    const { problems, reconciled } = auditHistory({
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
  const doubled = auditHistory({
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
  for (const reconciliation of [
    { capture: null, rows: [], accepted },
    { capture: { captured_at: "x", rows_sha256: rowsFingerprint([]) }, rows: [], accepted },
  ]) {
    const { problems, reconciled } = auditHistory({ remote, local, reconciliation });
    assert.equal(reconciled.length, 0);
    assert.ok(
      problems.some((p) => p.includes("without read-only evidence is not a reconciliation")),
      `expected the evidence requirement, got:\n${problems.join("\n")}`,
    );
    assert.ok(problems.some((p) => p.includes(v(20)) && p.includes("no statements")));
  }
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
  const { problems, reconciled } = auditHistory({
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
  const { problems, reconciled } = auditHistory({
    remote,
    local,
    requireApplied: [version],
    reconciliation: capturedFrom(remote, { accepted }),
  });
  assert.equal(reconciled.length, 0);
  assert.ok(problems.some((p) => p.includes("the database has no record of") && p.includes(version)));
  assert.ok(problems.some((p) => p.includes("not a difference this gate lets anyone accept")));

  // Same for the no-pending claim.
  const noPending = auditHistory({
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
  const { problems } = auditHistory({ remote: [], local, reconciliation: capturedFrom([]) });
  assert.ok(problems[0].includes("zero applied migrations"));
});

test("the fingerprints are stable and separate content from structure", () => {
  // Fixed vectors: a change to either function is a change to every recorded
  // baseline, so it has to be a deliberate one.
  assert.equal(statementsFingerprint([]), statementsFingerprint(null));
  assert.notEqual(statementsFingerprint(["a", "b"]), statementsFingerprint(["a b"]));
  assert.notEqual(statementsFingerprint(["a"]), statementsFingerprint(["a", ""]));
  assert.equal(statementsFingerprint(["select 1;"]), statementsFingerprint(["select 1;"]));

  const rows = [{ version: "1", name: "n", statement_count: 1, statements_sha256: "abc" }];
  assert.equal(rowsFingerprint(rows), rowsFingerprint([...rows]));
  assert.notEqual(rowsFingerprint(rows), rowsFingerprint([{ ...rows[0], name: "m" }]));
  assert.notEqual(rowsFingerprint(rows), rowsFingerprint([{ ...rows[0], statements_sha256: "abd" }]));
});

test("the gate asks the server for the fingerprint, never for the statements", () => {
  const source = read("scripts/verify-remote-migration-history.mjs");
  const query = /export const HISTORY_QUERY = `([\s\S]*?)`;/.exec(source);
  assert.ok(query, "HISTORY_QUERY must be exported so the capture script runs the same one");
  // No bare `statements` in the select list: the text must not cross the wire.
  assert.match(query[1], /encode\(sha256\(convert_to\(/);
  assert.match(query[1], /array_to_string\(statements, ' '\)/);
  assert.doesNotMatch(query[1], /select version,\s*\n?\s*name,\s*\n?\s*statements\b/);
  assert.match(query[1], /^\s*from supabase_migrations\.schema_migrations$/m);

  // And the count prefix in SQL is the count prefix in JS, or every fingerprint
  // captured by the server would mismatch every fingerprint computed here.
  assert.match(query[1], /coalesce\(array_length\(statements, 1\), 0\)::text \|\|/);
  assert.match(source, /hash\.update\(`\$\{list\.length\}`\)/);

  const capture = read("scripts/capture-remote-migration-history.mjs");
  assert.match(capture, /import \{ fetchRemoteHistory, rowsFingerprint \}/);
  assert.doesNotMatch(capture, /statements_sha256: [^n]*row\.statements\b/);
});

test("the reconciliation shipped in this repository is uncaptured and inert", () => {
  const shipped = JSON.parse(read("supabase/migration-history-reconciliation.json"));
  assert.equal(shipped.capture, null, "no production capture may be committed by a code round");
  assert.deepEqual(shipped.rows, []);
  assert.deepEqual(shipped.accepted, []);
  assert.ok(
    shipped._comment.join(" ").includes("NOT CAPTURED"),
    "the file must say what state it is in",
  );

  // Inert means exactly that: passing it changes no verdict.
  const { remote, local } = fixtures();
  const withFile = auditHistory({ remote, local, reconciliation: shipped }).problems;
  const without = auditHistory({ remote, local }).problems;
  assert.deepEqual(withFile, without);
  assert.equal(withFile.length, 25);
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
