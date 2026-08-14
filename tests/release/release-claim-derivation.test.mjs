// ============================================================================
// The deploy's migration set is derived, not accepted — round-4 review C4-1
// ============================================================================
// `newme-deploy <sha> <run> applied_verified <ids>` passed `<ids>` verbatim into
// scripts/verify-remote-migration-history.mjs as --require-applied. That gate
// re-measures every id it is handed, which reads like proof and is not: the claim
// was also the scope, and nothing derived the scope from the release.
//
// Measured before the change, with that gate's own pure judgement over this
// release's real manifest as it stood then (17 required + 1 deferred; the
// assertions below read the current size off the manifest):
//
//   * `applied_verified 20260806000000` → 0 findings, with 16 required migrations
//     unapplied. The app would have been switched onto a database missing the
//     authorization migrations this release exists to ship.
//   * every required migration applied AND the deferred contract phase applied
//     before the switch → 0 findings. That phase closes the direct money-write
//     path the still-live release uses; applying it early is the outage
//     supabase/preflight/expand-contract-rollback.md §2 is written to prevent.
//   * the wrapper's own argument regex, /^[0-9A-Za-z_.-]+(,[0-9A-Za-z_.-]+)*$/,
//     accepts a single id, so nothing on the path said otherwise.
//
// What is pinned here: the derivation and the exact-set comparison
// (auditReleaseClaim), the "must not be applied" direction of the history gate
// (--require-unapplied), and the three places on the deploy path that have to use
// them — the wrapper, scripts/deploy-immutable.sh, and the phase gate that now runs
// immediately before the traffic switch.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  auditReleaseClaim,
  manifestEntries,
  normalizeClaimId,
  readManifest,
} from "../../scripts/check-release-manifest.mjs";
import { auditHistory, compareHistories } from "../../scripts/verify-remote-migration-history.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GATE = path.join(ROOT, "scripts", "check-release-manifest.mjs");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const WRAPPER = path.join(ROOT, "infra", "systemd", "newme-deploy.sh");
const IMMUTABLE = path.join(ROOT, "scripts", "deploy-immutable.sh");

const manifest = readManifest();
const REQUIRED = manifest.required_for_app.map((entry) => entry.version).sort();
const DEFERRED = manifest.deferred_contract.map((entry) => entry.version).sort();
const STAMP = manifest.production_stamp;

const claimOf = (status, claimed) => auditReleaseClaim({ manifest, status, claimed });
const problemsOf = (status, claimed) => claimOf(status, claimed).problems;

// ---------------------------------------------------------------------------
// 1 · the derivation
// ---------------------------------------------------------------------------

test("the required and deferred sets are derived from the manifest, sorted", () => {
  const { problems, required, deferred } = claimOf("applied_verified", REQUIRED);
  assert.deepEqual(problems, []);
  assert.deepEqual(required, REQUIRED);
  assert.deepEqual(deferred, DEFERRED);
  assert.ok(required.length > 1, "a single-migration release makes the subset test vacuous");
  assert.ok(deferred.length > 0, "this release defers a contract phase; that is the half that must not be applied");
  // Disjoint, and the deferred phase sorts last: the manifest's own rule 4, restated
  // here because the derivation is what the deploy acts on.
  for (const version of deferred) assert.ok(!required.includes(version), version);
  assert.ok(deferred.every((version) => version > required.at(-1)));
});

test("an id may be a version or a filename stem, and nothing else", () => {
  assert.equal(normalizeClaimId("20260814000000"), "20260814000000");
  assert.equal(normalizeClaimId("20260814000000_l0_round3_authorization_and_integrity"), "20260814000000");
  assert.equal(normalizeClaimId("20260814000000_l0_round3_authorization_and_integrity.sql"), "20260814000000");
  assert.equal(normalizeClaimId(" 20260814000000 "), "20260814000000");
  for (const bad of ["2026081400000", "202608140000000", "abc", "", null, undefined, "2026-08-14"]) {
    assert.equal(normalizeClaimId(bad), null, JSON.stringify(bad));
  }
  // The filename form is what the runbook prints, so it must reach the same set.
  const byFile = claimOf("applied_verified", manifest.required_for_app.map((entry) => entry.file));
  assert.deepEqual(byFile.problems, []);
  assert.deepEqual(byFile.required, REQUIRED);
});

// ---------------------------------------------------------------------------
// 2 · the claim under mutation — this is the defect
// ---------------------------------------------------------------------------

test("a proper subset of the required set is refused, and the missing ids are named", () => {
  const problems = problemsOf("applied_verified", [REQUIRED[0]]);
  assert.equal(problems.length, 1, problems.join("\n"));
  // The count comes from the manifest, not from a literal: a hardcoded 18 here is
  // a second declaration of the release's size that rots the next time a migration
  // is added, and this file exists to pin derivation.
  assert.match(problems[0], new RegExp(
    `the claim names 1 migration\\(s\\) but this release requires all ${REQUIRED.length} of required_for_app`));
  for (const version of REQUIRED.slice(1)) assert.ok(problems[0].includes(version), version);
  assert.match(problems[0], /A proper subset is not a claim that this release's schema is present\./);

  // Every proper subset, not just the one-element one: dropping any single id fails.
  for (let i = 0; i < REQUIRED.length; i += 1) {
    const dropped = REQUIRED.filter((_, index) => index !== i);
    const found = problemsOf("applied_verified", dropped);
    assert.equal(found.length, 1, `dropping ${REQUIRED[i]} was accepted`);
    assert.ok(found[0].includes(REQUIRED[i]), found[0]);
  }
});

test("the deferred contract phase in an applied_verified claim is refused by name", () => {
  const problems = problemsOf("applied_verified", [...REQUIRED, ...DEFERRED]);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], new RegExp(`the claim names ${DEFERRED[0]}, which is this release's deferred contract-phase migration`));
  // The message has to say what to do, because the operator has already applied it.
  assert.match(problems[0], /must not be applied until the candidate is live and verified/);
  assert.match(problems[0], /Roll the phase back before deploying\./);
});

test("an id this release does not require, a duplicate, and an unparseable one are all refused", () => {
  assert.match(problemsOf("applied_verified", [...REQUIRED, STAMP])[0], new RegExp(`the claim names ${STAMP}, which this release's manifest does not list as required`));
  assert.match(problemsOf("applied_verified", [...REQUIRED, "20260899000000"])[0], /does not list as required/);
  assert.match(problemsOf("applied_verified", [...REQUIRED, REQUIRED[0]])[0], new RegExp(`the claim names ${REQUIRED[0]} twice`));
  assert.match(problemsOf("applied_verified", [...REQUIRED, "latest"])[0], /"latest" is not a migration id/);
  // An empty claim is a subset too, and the emptiest one.
  assert.match(problemsOf("applied_verified", [])[0], /the claim names 0 migration\(s\)/);
});

test("not_required is refused for a release that requires migrations", () => {
  const problems = problemsOf("not_required", []);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], new RegExp(
    `not_required was claimed but this release's manifest requires ${REQUIRED.length} migration\\(s\\)`));
  // And a not_required claim that carries ids is refused for both reasons.
  assert.ok(problemsOf("not_required", REQUIRED).length >= 2);
  assert.match(problemsOf("not_required", REQUIRED).join("\n"), /not_required must not carry migration ids/);
});

test("an unknown status is refused rather than treated as one of the two", () => {
  for (const status of ["applied", "APPLIED_VERIFIED", "", "verified", null, undefined, "not_required "]) {
    assert.match(
      problemsOf(status, REQUIRED).join("\n"),
      /the migration status must be applied_verified or not_required/,
      JSON.stringify(status),
    );
  }
});

test("a manifest the set cannot be derived from yields problems AND empty sets", () => {
  // Fail closed in the direction that matters: a partial derived set would be
  // handed to --require-applied and would silence the very check it feeds.
  const cases = [
    [(m) => delete m.required_for_app, /required_for_app must be an array/],
    [(m) => { m.required_for_app = {}; }, /required_for_app must be an array/],
    [(m) => delete m.deferred_contract, /deferred_contract must be an array/],
    [(m) => { m.required_for_app[3] = { file: "rollback_l0_20260811.sql", version: "20260811", sha256: "a".repeat(64) }; }, /is not a CLI-applicable migration filename/],
    [(m) => { m.required_for_app[3].version = "20260899000000"; }, /under version "20260899000000"/],
    [(m) => { m.required_for_app[3].sha256 = "nope"; }, /with no sha256, so the deploy cannot be told to require it/],
    [(m) => { m.deferred_contract.push({ ...m.required_for_app[0] }); }, /is listed in both required_for_app and deferred_contract/],
  ];
  for (const [mutate, pattern] of cases) {
    const mutated = JSON.parse(JSON.stringify(manifest));
    mutate(mutated);
    const result = auditReleaseClaim({ manifest: mutated, status: "applied_verified", claimed: REQUIRED });
    assert.match(result.problems.join("\n"), pattern);
    assert.deepEqual(result.required, [], "a malformed manifest must not yield a partial required set");
    assert.deepEqual(result.deferred, []);
  }
});

// ---------------------------------------------------------------------------
// 3 · the history gate's other direction
// ---------------------------------------------------------------------------

const row = (version) => ({ version, name: "x", statements: ["select 1"] });
const local = [
  { version: STAMP, name: "x", file: `${STAMP}_x.sql` },
  ...manifestEntries(manifest).map((entry) => ({ version: entry.version, name: "x", file: entry.file })),
];

test("the derived set turns the accepted subset into 16 refusals", () => {
  const { required, deferred } = claimOf("applied_verified", REQUIRED);
  // Production as it is today: the release's migrations are not applied.
  const findings = compareHistories({
    remote: [row(STAMP), row(REQUIRED[0])],
    local,
    requireApplied: required,
    requireUnapplied: deferred,
  });
  assert.equal(findings.length, REQUIRED.length - 1);
  for (const version of REQUIRED.slice(1)) {
    assert.ok(
      findings.some((message) => message === `${version} was claimed applied but the database has no record of ${version}`),
      version,
    );
  }
});

test("the deferred contract phase already applied is refused with its remedy", () => {
  const findings = compareHistories({
    remote: [row(STAMP), ...REQUIRED.map(row), ...DEFERRED.map(row)],
    local,
    requireApplied: REQUIRED,
    requireUnapplied: DEFERRED,
  });
  assert.equal(findings.length, 1, findings.join("\n"));
  assert.match(findings[0], new RegExp(`^${DEFERRED[0]} is this release's deferred contract-phase migration and the database has already applied it`));
  assert.match(findings[0], /rollback_money_direct_write_contract_phase\.sql \(runbook §5\.1\)/);

  // The correct pre-switch state — every required migration applied, the contract
  // phase not — is the one that passes.
  assert.deepEqual(
    compareHistories({ remote: [row(STAMP), ...REQUIRED.map(row)], local, requireApplied: REQUIRED, requireUnapplied: DEFERRED }),
    [],
  );
});

test("a version required both applied and unapplied is a refusal, not a coin toss", () => {
  const findings = compareHistories({
    remote: [row(STAMP), ...REQUIRED.map(row)],
    local,
    requireApplied: REQUIRED,
    requireUnapplied: [REQUIRED[0]],
  });
  assert.equal(findings.length, 1, findings.join("\n"));
  assert.match(findings[0], /was required both applied and not applied/);
});

test("unapplied claims fail closed on unparseable ids and on absent files", () => {
  const base = { remote: [row(STAMP), ...REQUIRED.map(row)], local, requireApplied: REQUIRED };
  assert.match(compareHistories({ ...base, requireUnapplied: ["tomorrow"] })[0], /"tomorrow" is not a migration id this gate can check/);
  assert.match(
    compareHistories({ ...base, requireUnapplied: ["20260899000000"] })[0],
    /was required to be unapplied but this release contains no migration 20260899000000/,
  );
  // A row recorded under that version by something other than the CLI still counts
  // as applied: the question is whether it ran, not who recorded it.
  const weird = compareHistories({
    remote: [row(STAMP), ...REQUIRED.map(row), { version: DEFERRED[0], name: "x", statements: [] }],
    local,
    requireApplied: REQUIRED,
    requireUnapplied: DEFERRED,
  });
  assert.ok(weird.some((message) => /has already applied it/.test(message)), weird.join("\n"));
});

test("the full audit carries the same verdict, so the deploy gate cannot disagree with the pure one", () => {
  const { problems } = auditHistory({
    remote: [row(STAMP), ...REQUIRED.map(row), ...DEFERRED.map(row)],
    local,
    requireApplied: REQUIRED,
    requireUnapplied: DEFERRED,
    statementsRead: true,
    localContent: null,
  });
  assert.ok(problems.some((message) => /has already applied it/.test(message)), problems.join("\n"));
});

// ---------------------------------------------------------------------------
// 4 · behaviour: the CLI the deploy path actually runs
// ---------------------------------------------------------------------------

const run = (args, options = {}) => spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: "utf8", ...options });

test("--verify-claim prints the derived sets and exits 0 only on an exact claim", () => {
  const ok = run(["--verify-claim", "--status", "applied_verified", "--ids", REQUIRED.join(",")]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`^required_for_app=${REQUIRED.join(",")}$`, "m"));
  assert.match(ok.stdout, new RegExp(`^deferred_contract=${DEFERRED.join(",")}$`, "m"));
  assert.match(ok.stdout, new RegExp(
    `release claim: applied_verified agrees with the manifest — ${REQUIRED.length} required before the switch, `
    + `${DEFERRED.length} deferred until after it`));

  const subset = run(["--verify-claim", "--status", "applied_verified", "--ids", REQUIRED[0]]);
  assert.equal(subset.status, 1);
  assert.match(subset.stderr, /release claim: the claim names 1 migration\(s\)/);
  assert.match(subset.stderr, /refusing: 1 problem\(s\)/);
  // The derived set is printed on refusal too: it is the operator's next command.
  assert.match(subset.stdout, new RegExp(`^required_for_app=${REQUIRED.join(",")}$`, "m"));

  assert.equal(run(["--verify-claim", "--status", "not_required"]).status, 1);
  assert.equal(run(["--verify-claim", "--ids", REQUIRED.join(",")]).status, 1);
  assert.match(run(["--verify-claim", "--ids", "x"]).stderr, /--verify-claim requires --status/);
});

test("--verify-claim refuses when the manifest does not describe the tree it is derived from", () => {
  // The derivation's premise. A required migration present on disk and missing from
  // the manifest would make the derived set a subset of the truth — the same defect
  // one layer down — so the whole manifest audit runs first and its failure is
  // reported as "the required set cannot be derived", not as a hash complaint.
  const dir = mkdtempSync(path.join(tmpdir(), "c41-claim-"));
  try {
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"))) {
      copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
    }
    writeFileSync(path.join(dir, "20260819000000_unclassified.sql"), "select 1;\n");
    const smuggled = run(["--verify-claim", "--status", "applied_verified", "--ids", REQUIRED.join(","), "--migrations-dir", dir]);
    assert.equal(smuggled.status, 1);
    assert.match(smuggled.stderr, /20260819000000_unclassified\.sql sorts after .* but no phase claims it/);
    assert.match(smuggled.stderr, /the manifest at this SHA does not describe supabase\/migrations\//);

    // And an edited required migration: the claim would name the right versions and
    // the wrong content.
    const victim = manifest.required_for_app.at(-1).file;
    rmSync(path.join(dir, "20260819000000_unclassified.sql"));
    writeFileSync(path.join(dir, victim), `${readFileSync(path.join(dir, victim), "utf8")}\nselect 1;\n`);
    const edited = run(["--verify-claim", "--status", "applied_verified", "--ids", REQUIRED.join(","), "--migrations-dir", dir]);
    assert.equal(edited.status, 1);
    assert.match(edited.stderr, /has changed since the manifest was stamped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5 · the deploy path
// ---------------------------------------------------------------------------

test("the wrapper derives the set from its own worktree and verifies the derived one", () => {
  const wrapper = readFileSync(WRAPPER, "utf8");
  const lines = wrapper.split(/\r?\n/);
  const at = (pattern) => lines.findIndex((line) => pattern.test(line));

  // Both sides from $WORKTREE: the root-owned worktree at the canonical main SHA.
  assert.match(
    wrapper,
    /RELEASE_CLAIM="\$\(cd "\$WORKTREE" && "\$NODE_BIN" scripts\/check-release-manifest\.mjs \\\n\s*--verify-claim --status "\$MIGRATION_STATUS" --ids "\$MIGRATION_IDS"\)"/,
  );
  // --require-applied takes the DERIVED list. This is the line the finding is about.
  assert.match(wrapper, /MIGRATION_HISTORY_ARGS\+=\(--require-applied "\$REQUIRED_IDS"\)/);
  assert.doesNotMatch(wrapper, /--require-applied "\$MIGRATION_IDS"/);
  assert.match(wrapper, /MIGRATION_HISTORY_ARGS\+=\(--require-unapplied "\$DEFERRED_IDS"\)/);
  // Empty or malformed derivation is a refusal, never an empty --require-applied.
  assert.match(wrapper, /\[\[ "\$REQUIRED_IDS" =~ \^\[0-9\]\{14\}\(,\[0-9\]\{14\}\)\*\$ \]\] \|\|/);
  assert.match(wrapper, /the release manifest yielded no required migration set to verify/);

  const claim = at(/--verify-claim --status/);
  const history = at(/verify-remote-migration-history\.mjs/);
  const assets = at(/install-systemd-assets\.sh"/);
  assert.ok(claim > 0 && claim < history, "the claim must be derived before the history gate consumes it");
  assert.ok(history < assets);

  // Recorded as its own gate, so the installer can tell a wrapper that derives the
  // set from one that takes the operator's word (scripts/verify-deploy-gate-record.mjs).
  assert.match(wrapper, /^gate=release-claim-derived$/m);
  // And the derived list, not the operator's, is what is handed downstream and
  // archived in the evidence record.
  assert.match(wrapper, /MIGRATION_IDS="\$REQUIRED_IDS" \\/);
});

test("deploy-immutable.sh derives the same set from the SHA it extracted", () => {
  const script = readFileSync(IMMUTABLE, "utf8");
  const lines = script.split(/\r?\n/);
  const at = (pattern) => lines.findIndex((line) => pattern.test(line));

  // From $STAGE, which is `git archive $SHA` — not from $ROOT's working copy, which
  // is not the tree being deployed.
  assert.match(
    script,
    /RELEASE_CLAIM="\$\(cd "\$STAGE" && node scripts\/check-release-manifest\.mjs \\\n\s*--verify-claim --status "\$MIGRATION_STATUS" --ids "\$\{MIGRATION_IDS:-\}"\)"/,
  );
  const extract = at(/git -C "\$ROOT" archive "\$SHA"/);
  const derive = at(/--verify-claim --status/);
  const install = at(/^npm ci /);
  const switchLine = at(/^mv -Tf "\$CURRENT_NEXT" "\$CURRENT"$/);
  assert.ok(extract > 0 && derive > extract, "the claim is derived from the extracted tree");
  assert.ok(derive < install, "a wrong claim must not cost a build");
  assert.ok(derive < switchLine);
  // A failure here aborts; it is not a warning.
  assert.match(script, /fail "MIGRATION_IDS is not the migration set this release's manifest requires"\n\s*exit 1/);
});

test("the traffic switch is gated on an exact pre-switch revalidation bundle", () => {
  const script = readFileSync(IMMUTABLE, "utf8");
  const lines = script.split(/\r?\n/);
  const at = (pattern) => lines.findIndex((line) => pattern.test(line));

  const gate = at(/PRE_SWITCH_OUTPUT="\$\(node "\$PRE_SWITCH_GATE"/);
  const switchLine = at(/^mv -Tf "\$CURRENT_NEXT" "\$CURRENT"$/);
  const statePending = at(/^write_deploy_state switch_pending$/);
  assert.notEqual(gate, -1, "nothing revalidates the release/database boundary before the switch");
  assert.notEqual(switchLine, -1, "the traffic switch line moved; re-anchor this test");
  assert.ok(gate < statePending && statePending < switchLine, "the full boundary must be verified before the switch is even pending");

  // The release proves itself: the helper from that release, exact early-derived
  // sets, the root-owned URL file, and the candidate's own node_modules.
  assert.match(script, /PRE_SWITCH_GATE="\$RELEASE\/scripts\/check-pre-switch-release\.mjs"/);
  assert.match(script, /--release-dir "\$RELEASE"/);
  assert.match(script, /--expect-required "\$INITIAL_REQUIRED_IDS"/);
  assert.match(script, /--expect-deferred "\$INITIAL_DEFERRED_IDS"/);
  assert.match(script, /--url-file "\$MIGRATION_DB_URL_FILE"/);
  assert.match(script, /MIGRATION_DB_URL_FILE="\$\{NEWME_MIGRATION_DB_URL_FILE:-\/etc\/newme\/migration-db\.url\}"/);
  assert.doesNotMatch(script, /--url[= ]postgres/);
  assert.match(script, /exact pre-switch migration history\/posture\/companion revalidation refused this release/);
  // A missing gate in the release is a refusal, not a skip.
  assert.match(script, /the release carries no scripts\/check-pre-switch-release\.mjs/);
  // And an empty stdout from the gate cannot read as a verified mode.
  assert.match(script, /the database phase gate reported no mode/);
});

test("the installer knows the derived-claim gate and bootstrap delegates it to the coordinator", () => {
  // Held equal in one place already (tests/release/control-plane-bootstrap-contract.test.mjs);
  // repeated here for the one gate this finding adds, because a gate the wrapper
  // writes and the installer does not know is a refused install.
  const record = readFileSync(path.join(ROOT, "scripts/verify-deploy-gate-record.mjs"), "utf8");
  assert.match(record, /"release-claim-derived",/);
  const doc = readFileSync(path.join(ROOT, "infra/release/control-plane-bootstrap.md"), "utf8");
  assert.match(doc, /candidate-manifest claim derivation and exact operator-claim comparison/);
  assert.match(doc, /machine generation of the one-use installer gate record/);
  assert.doesNotMatch(doc, /^\s*gate=/m);
});
