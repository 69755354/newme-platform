// ============================================================================
// Contract test: the database phase is coupled to the release that serves it
// ============================================================================
// Round-4 review C8: "database phase rollback is not coupled to production app
// rollback — app rollback does not verify/switch DB mode; contract history can say
// applied while mode is compat. Required closure: a durable phase state machine.
// Rollback must verify compat before switching to f37; candidate completion must
// require strict."
//
// The judgement is scripts/check-release-phase.mjs, the declaration is
// `runs_under.database_phases` in infra/release/release-manifest.json (rule 7 of
// scripts/check-release-manifest.mjs), and the two callers are
// infra/systemd/newme-production-rollback.sh — before it moves the `current`
// symlink — and the finalize branch of infra/systemd/newme-deploy.sh.
//
// What is testable here and what is not: the judgement is pure and is tested
// against real inputs, including this release's own committed manifest placed in a
// release-shaped directory. Reading the live mode needs a database and the two
// callers need a production host, so those are covered by asserting the wiring at
// source level — the calls, the order, the fail-closed branches, and that no
// connection string ever reaches an argument list.
//
// The half that needs a database is measured, not skipped: step 11 of
// scripts/phase-tool-drill.sh (CI job `migration-replay`) runs the gate against a
// real catalog in all three modes, across the state 4 → 5 → 6 transitions, with the
// contract phase recorded while the mode is compat. The last test in this file
// requires that step to stay in the drill, because the drill exits 0 either way.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COMPLETION_PHASE,
  KNOWN_PHASES,
  UNDECLARED_PHASES,
  judgeCompletion,
  judgeSwitch,
  readReleaseManifest,
  resolveDeclaredPhases,
} from "../../scripts/check-release-phase.mjs";
import {
  auditManifest,
  contentHash,
  readBaseline,
  readManifest,
  readMigration,
} from "../../scripts/check-release-manifest.mjs";
import { readdirSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GATE = path.join(ROOT, "scripts", "check-release-phase.mjs");
const MANIFEST = path.join(ROOT, "infra", "release", "release-manifest.json");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

// --- the declaration -------------------------------------------------------

test("this release declares the modes it can serve, and only those", () => {
  const manifest = readManifest();
  const { phases, source, problems } = resolveDeclaredPhases(manifest);
  assert.deepEqual(problems, []);
  assert.equal(source, "declared");
  // States 2–6 of the runbook's matrix. Not `absent`: the mode function is created
  // by an expand migration, so `absent` is the state before this release's own
  // required_for_app set has been applied.
  assert.deepEqual(phases, ["compat", "strict"]);
  assert.ok(!phases.includes("absent"));
});

test("a release with no declaration is pre-mechanism, not unrestricted", () => {
  // The default is the whole point of the finding: the rollback target is the
  // release that predates the key, so what its silence means decides whether the
  // rollback that would take money writes down is refused.
  for (const manifest of [null, undefined, {}, { release: "old" }]) {
    const resolved = resolveDeclaredPhases(manifest);
    assert.deepEqual(resolved.problems, []);
    assert.equal(resolved.source, "undeclared");
    assert.deepEqual(resolved.phases, UNDECLARED_PHASES);
    assert.ok(!resolved.phases.includes("strict"), "a pre-mechanism release must not be assumed to survive strict");
  }
});

test("a malformed declaration resolves to nothing, not to a default", () => {
  for (const runs_under of [
    null,
    [],
    "compat",
    {},
    { database_phases: [] },
    { database_phases: "compat" },
    { database_phases: ["compat", "lenient"] },
    { database_phases: ["compat", 3] },
  ]) {
    const resolved = resolveDeclaredPhases({ runs_under });
    assert.equal(resolved.source, "invalid", JSON.stringify(runs_under));
    assert.deepEqual(resolved.phases, [], JSON.stringify(runs_under));
    assert.ok(resolved.problems.length > 0, JSON.stringify(runs_under));
  }
  // A duplicate is reported rather than silently folded: it means the file was
  // edited by hand and nobody read it back.
  const duplicated = resolveDeclaredPhases({ runs_under: { database_phases: ["compat", "compat"] } });
  assert.equal(duplicated.source, "invalid");
  assert.ok(duplicated.problems.some((problem) => /lists "compat" twice/.test(problem)));
});

test("the manifest gate refuses every malformed or missing declaration", () => {
  // Rule 7. Without this, the declaration the deploy path depends on could be
  // deleted, misspelled or narrowed with every other gate still green.
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => /^[0-9]{14}_.*\.sql$/.test(file)).sort();
  const hashes = new Map(files.map((file) => [file, contentHash(readMigration(MIGRATIONS_DIR, file))]));
  const baseline = readBaseline();
  const audit = (mutate) => {
    const manifest = JSON.parse(JSON.stringify(readManifest()));
    mutate(manifest);
    return auditManifest({ manifest, files, hashes, baseline }).filter((problem) => /runs_under/.test(problem));
  };

  assert.deepEqual(auditManifest({ manifest: readManifest(), files, hashes, baseline }), []);

  const cases = [
    ["missing", (manifest) => delete manifest.runs_under, /must name the direct-write modes/],
    ["not an object", (manifest) => { manifest.runs_under = ["compat"]; }, /must be an object/],
    ["empty", (manifest) => { manifest.runs_under.database_phases = []; }, /non-empty array/],
    ["unknown", (manifest) => { manifest.runs_under.database_phases = ["compat", "lenient"]; }, /not one of absent, compat, strict/],
    ["duplicate", (manifest) => { manifest.runs_under.database_phases = ["compat", "compat", "strict"]; }, /twice/],
    // The three that are about this release rather than about JSON shape.
    ["absent claimed", (manifest) => { manifest.runs_under.database_phases = ["absent", "compat", "strict"]; }, /before its own required_for_app migrations are applied/],
    ["no strict", (manifest) => { manifest.runs_under.database_phases = ["compat"]; }, /could never be completed/],
    ["no compat", (manifest) => { manifest.runs_under.database_phases = ["strict"]; }, /between the two pushes/],
  ];
  for (const [label, mutate, expected] of cases) {
    const problems = audit(mutate);
    assert.ok(problems.length > 0, `${label} was accepted`);
    assert.ok(problems.some((problem) => expected.test(problem)), `${label}: ${problems.join("; ")}`);
  }
});

test("--stamp leaves the declaration alone", () => {
  // The stamp rewrites hashes in place with a regex per filename. A stamp that
  // reserialised the manifest could drop a key it does not know about, and the key
  // it does not know about is the one the deploy path reads.
  const source = read("scripts/check-release-manifest.mjs");
  const stampStart = source.indexOf("function stamp() {");
  const stampEnd = source.indexOf("\n}\n", stampStart);
  assert.ok(stampStart >= 0 && stampEnd > stampStart);
  const body = source.slice(stampStart, stampEnd);
  assert.match(body, /updated = updated\.replace\(pattern, `\$1\$\{hash\}\$2`\)/);
  assert.doesNotMatch(body, /JSON\.stringify/, "the stamp reserialises the manifest instead of patching hashes");
});

// --- the switch verdict ----------------------------------------------------

test("rollback to a pre-mechanism release is refused under strict and allowed under compat", () => {
  const target = resolveDeclaredPhases(null); // f37: no manifest, no declaration
  const strict = judgeSwitch({ mode: "strict", ...target });
  assert.equal(strict.ok, false);
  assert.ok(
    strict.problems.some((problem) => /rollback_money_direct_write_contract_phase\.sql/.test(problem)),
    "the refusal must name the companion that makes the rollback possible",
  );
  assert.ok(strict.problems.some((problem) => /no runs_under declaration/.test(problem)));

  // The same target, after the companion has run. This is the pair that makes the
  // gate a gate rather than a block: there is a documented way through it.
  assert.equal(judgeSwitch({ mode: "compat", ...target }).ok, true);
  assert.equal(judgeSwitch({ mode: "absent", ...target }).ok, true);
});

test("this release can be switched to under compat and strict, and not before its expand phase", () => {
  const declared = resolveDeclaredPhases(readManifest());
  assert.equal(judgeSwitch({ mode: "compat", ...declared }).ok, true);
  assert.equal(judgeSwitch({ mode: "strict", ...declared }).ok, true);
  const absent = judgeSwitch({ mode: "absent", ...declared });
  assert.equal(absent.ok, false);
  assert.ok(absent.problems.some((problem) => /its runs_under declaration says so/.test(problem)));
});

test("an unreadable mode and an unresolvable declaration both refuse", () => {
  for (const mode of ["unreadable", "", null, undefined, "STRICT", "compat "]) {
    const verdict = judgeSwitch({ mode, phases: ["compat", "strict"], source: "declared" });
    assert.equal(verdict.ok, false, `mode ${JSON.stringify(mode)} was accepted`);
    assert.ok(verdict.problems.some((problem) => /does not know/.test(problem)));
  }
  for (const phases of [[], null, undefined]) {
    const verdict = judgeSwitch({ mode: "compat", phases, source: "invalid" });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /declares no database phase/.test(problem)));
  }
  // Every mode the resolver admits is judged by name, so a new mode added to the
  // database without being added here is refused rather than assumed benign.
  assert.deepEqual(KNOWN_PHASES, ["absent", "compat", "strict"]);
});

// --- the completion verdict ------------------------------------------------

test("completion requires strict, and says how to get there", () => {
  assert.equal(COMPLETION_PHASE, "strict");
  assert.equal(judgeCompletion({ mode: "strict" }).ok, true);

  const compat = judgeCompletion({ mode: "compat" });
  assert.equal(compat.ok, false);
  assert.ok(compat.problems.some((problem) => /--phase deferred_contract/.test(problem)));

  for (const mode of ["absent", "unreadable", undefined]) {
    assert.equal(judgeCompletion({ mode }).ok, false, `${mode} completed a release`);
  }
});

// --- reading a target release ---------------------------------------------

test("a release directory is read as itself, and an unreadable one is a refusal", () => {
  const work = mkdtempSync(path.join(tmpdir(), "newme-phase-"));
  try {
    // The candidate: a release-shaped directory holding this release's own manifest.
    const candidate = path.join(work, "candidate");
    mkdirSync(path.join(candidate, "infra", "release"), { recursive: true });
    copyFileSync(MANIFEST, path.join(candidate, "infra", "release", "release-manifest.json"));
    const read = readReleaseManifest(candidate);
    assert.equal(read.present, true);
    const declared = resolveDeclaredPhases(read.manifest);
    assert.equal(declared.source, "declared");
    assert.equal(judgeSwitch({ mode: "strict", ...declared }).ok, true);

    // The rollback target: no manifest at all, which is the pre-mechanism release.
    const previous = path.join(work, "previous");
    mkdirSync(previous, { recursive: true });
    const missing = readReleaseManifest(previous);
    assert.equal(missing.present, false);
    assert.equal(missing.manifest, null);
    assert.equal(judgeSwitch({ mode: "strict", ...resolveDeclaredPhases(missing.manifest) }).ok, false);

    // A manifest that exists and cannot be read is not the pre-mechanism case: the
    // release tried to say something and the answer was lost.
    const broken = path.join(work, "broken");
    mkdirSync(path.join(broken, "infra", "release"), { recursive: true });
    writeFileSync(path.join(broken, "infra", "release", "release-manifest.json"), "{ not json");
    assert.throws(() => readReleaseManifest(broken));

    const linked = path.join(work, "linked");
    mkdirSync(path.join(linked, "infra", "release"), { recursive: true });
    try {
      symlinkSync(MANIFEST, path.join(linked, "infra", "release", "release-manifest.json"));
      assert.throws(() => readReleaseManifest(linked), /symlink/);
    } catch (error) {
      // Unprivileged Windows checkouts cannot create symlinks; the assertion above
      // is the one that matters and it runs on CI.
      if (error.code !== "EPERM") throw error;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("absence of the mode function is established positively", () => {
  // Calling the function and reading `undefined_function` as `absent` would also
  // read a revoked grant, a search_path problem or a typo as `absent` — the one
  // answer that lets a pre-mechanism release through under strict.
  const source = read("scripts/check-release-phase.mjs");
  // The reader only, not the rest of the module: main() has exactly one legitimate
  // console.log — the `NEWME_DB_PHASE=` line the callers record — and the point of
  // this test is that the function talking to production is not the one printing.
  const body = source.slice(
    source.indexOf("export async function readLiveMode"),
    source.indexOf("function parseArgs("),
  );
  const catalogProbe = body.indexOf("pg_catalog.pg_proc");
  const functionCall = body.indexOf("select public.money_direct_write_mode()");
  assert.ok(catalogProbe >= 0 && functionCall > catalogProbe, "the function is called before the catalog is asked");
  assert.match(body, /begin read only/);
  assert.match(body, /pronargs = 0/);
  assert.match(body, /client\.query\("rollback"\)/);
  // A pg connection error's message can quote the URL it failed to reach, so the
  // one catch that can see it reports the code and never the message.
  // Comments stripped: the code is what runs, and the comment on that line has to
  // be free to say which mistake it is avoiding.
  const connectCatch = body
    .slice(body.indexOf("await client.connect()"), body.indexOf("begin read only"))
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(connectCatch, /error\.code \?\? error\.name/);
  assert.doesNotMatch(connectCatch, /error\.message/);
  assert.doesNotMatch(body, /console\.log/, "the mode reader prints to stdout");
});

test("the gate refuses to be called without a verdict to give", () => {
  const run = (...args) => spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
  for (const args of [[], ["--for-switch"], ["--for-switch", "--url-file", "x"], ["--for-completion"], ["--url-file"]]) {
    const result = run(...args);
    assert.equal(result.status, 2, `accepted ${JSON.stringify(args)}`);
    assert.equal(result.stdout, "", "a refusal must not print a mode");
  }
  // A connection string on the command line is refused by name, not connected with.
  const inlined = run("--for-completion", "--url-file", "postgres://x/y");
  assert.notEqual(inlined.status, 0);
  assert.equal(inlined.stdout, "");
});

// --- the rollback caller ---------------------------------------------------

test("production rollback verifies the phase before it switches releases", () => {
  const source = read("infra/systemd/newme-production-rollback.sh").replaceAll("\r\n", "\n");
  const executeStart = source.indexOf("  execute)");
  assert.ok(executeStart > 0);
  const execute = source.slice(executeStart);

  const gate = execute.indexOf('read_target_database_phase "$target_release" "$current"');
  const snapshot = execute.indexOf('snapshot_live_assets "$current"');
  const prepared = execute.indexOf("write_pending_state prepared");
  const switched = execute.indexOf('switch_release_links "$target_release" "$target_rollback"');
  assert.ok(gate > 0, "the execute path does not verify the database phase");
  assert.ok(gate < snapshot, "the phase is verified after the live assets are snapshotted");
  assert.ok(snapshot < prepared && prepared < switched, "the transaction order changed");
  assert.match(execute, /refusing to switch to \$target_release: the database phase does not permit it" >&2\n      exit 70/);

  // The gate is the live release's copy, judging the target directory. The target is
  // normally the release that carries neither.
  assert.match(source, /gate="\$live\/scripts\/check-release-phase\.mjs"/);
  assert.match(source, /--for-switch \\\n\s*--release-dir "\$target" \\\n\s*--url-file "\$MIGRATION_DB_URL_FILE" \\\n\s*--modules-dir "\$live\/node_modules"/);
  assert.match(source, /MIGRATION_DB_URL_FILE=\/etc\/newme\/migration-db\.url/);
  assert.match(source, /stat -c '%U:%G' "\$MIGRATION_DB_URL_FILE"\)" = root:root/);
  assert.match(source, /400\|600\) ;;/);
  // Fail-closed on every precondition, and no way past it.
  for (const refusal of [
    /node is required to verify the database phase/,
    /carries no scripts\/check-release-phase\.mjs/,
    /root-owned migration database URL file is missing/,
    /exited 0 without reporting a mode/,
  ]) {
    assert.match(source, refusal);
  }
  assert.doesNotMatch(source, /NEWME_SKIP|--force|FORCE_/, "the phase gate has a bypass");
  assert.doesNotMatch(source, /postgres(ql)?:\/\//, "a connection string appears in the rollback script");

  // The recovery paths must NOT ask: neither switches a new release in, and a
  // refusal there could only strand a half-finished transaction.
  const recovery = source.slice(
    source.indexOf("recover_preswitch_deploy() {"),
    source.indexOf("switch_release_links() {"),
  );
  assert.ok(recovery.length > 0);
  assert.doesNotMatch(recovery, /read_target_database_phase/);
  const restore = source.slice(
    source.indexOf("restore_original_transaction() {"),
    source.indexOf("finalize_completed_transaction() {"),
  );
  assert.ok(restore.length > 0);
  assert.doesNotMatch(restore, /read_target_database_phase/);
});

test("the observed phase is part of the durable transaction record", () => {
  const source = read("infra/systemd/newme-production-rollback.sh").replaceAll("\r\n", "\n");
  // Written in the record, between the asset backup and the state, so a resumed or
  // audited transaction says which database it was judged against.
  assert.match(source, /live_asset_backup=%s\\ndb_phase=%s\\nstate=%s\\n/);
  assert.match(source, /"\$PENDING_LIVE_ASSET_BACKUP" "\$PENDING_DB_PHASE" "\$state"/);
  // And validated on the way back in, with the line count raised to match: a record
  // that does not carry the phase is not a record this script wrote.
  assert.match(source, /wc -l < "\$PENDING_RECORD"\)" -eq 10/);
  assert.match(source, /grep -Ec '\^db_phase=\(absent\|compat\|strict\)\$'/);
  assert.match(source, /PENDING_DB_PHASE="\$\(sed -n 's\/\^db_phase=\/\/p' "\$PENDING_RECORD"\)"/);
  // Reported by `status` from the record, and in the journal entry for the run.
  assert.match(source, /rollback_db_phase=%s/);
  assert.match(source, /NEWME_DB_PHASE=\$PENDING_DB_PHASE/);
  // `status` must stay cheap: it may not open a database connection to answer.
  const statusBody = source.slice(source.indexOf("  status)"), source.indexOf("\n    ;;\n  execute)"));
  assert.doesNotMatch(statusBody, /read_target_database_phase|check-release-phase/);
});

// --- the completion caller -------------------------------------------------

test("finalization requires strict before it may call a release complete", () => {
  const source = read("infra/systemd/newme-deploy.sh").replaceAll("\r\n", "\n");
  const finalizeStart = source.indexOf('if [ "${1:-}" = "finalize" ]; then');
  const finalizeEnd = source.indexOf("\nfi\n\nSHA=${1:-}", finalizeStart);
  assert.ok(finalizeStart >= 0 && finalizeEnd > finalizeStart);
  const finalize = source.slice(finalizeStart, finalizeEnd);

  const gate = finalize.indexOf("--for-completion");
  const evidence = finalize.indexOf("finalize-deploy-evidence.sh");
  assert.ok(gate > 0, "finalization is not gated on the database phase");
  assert.ok(gate < evidence, "the evidence file is rewritten before the phase is checked");
  assert.match(finalize, /if \[ "\$UAT_STATUS" = pass \]; then/);
  assert.match(finalize, /require_node \|\| exit 65/);
  assert.match(finalize, /validate_migration_db_url_file \|\| exit 65/);
  assert.match(finalize, /--url-file "\$MIGRATION_DB_URL_FILE"/);
  assert.match(finalize, /the database phase does not allow this release to be completed" >&2\n      exit 70/);
  // No bypass when the gate is missing from the release being finalized.
  assert.match(finalize, /carries no scripts\/check-release-phase\.mjs; completion cannot be gated/);
  const missingGate = finalize.slice(finalize.indexOf("FINALIZE_PHASE_GATE="));
  assert.doesNotMatch(missingGate.slice(0, missingGate.indexOf("--for-completion")), /note:|continue|true/);

  // A failed UAT records uat_failed and claims nothing, so it is not gated.
  assert.ok(
    finalize.indexOf('if [ "$UAT_STATUS" = pass ]; then') < gate,
    "a fail finalization is blocked by the completion gate",
  );

  // One definition of the URL file and its validation, used by both entry points.
  assert.equal(source.split("MIGRATION_DB_URL_FILE=/etc/newme/migration-db.url").length - 1, 1);
  assert.equal(source.split("validate_migration_db_url_file() {").length - 1, 1);
  assert.equal(source.split("validate_migration_db_url_file || exit 65").length - 1, 2);
});

test("the gate the deploy path runs is committed, and the phases agree with the runbook", () => {
  // A gate the release does not carry cannot run on the host, and both callers now
  // refuse when it is absent — so its presence is part of the release contract.
  assert.match(read("scripts/check-release-phase.mjs"), /export async function readLiveMode/);
  const runbook = read("supabase/preflight/expand-contract-rollback.md");
  for (const phase of KNOWN_PHASES) assert.ok(runbook.includes(phase), `the runbook does not mention ${phase}`);
  assert.match(runbook, /runs_under/, "the runbook does not document the declaration the deploy path reads");
  assert.match(runbook, /check-release-phase\.mjs/);
  // The runbook must also tell the operator what a refusal looks like and how to
  // get past it, because the gate refuses at the moment they are rolling back.
  assert.match(runbook, /exits \*\*70\*\*|exit 70/);
  assert.match(runbook, /rollback_db_phase/);
});

test("the mode the gate reads is measured against a real database, not only stubbed", () => {
  // Everything above stubs the mode: these are pure functions and there is no
  // database in `npm test`. The one thing a stub cannot establish is that
  // readLiveMode returns `absent`, `compat` and `strict` when a real catalog is in
  // those states — and that is the input every judgement here depends on. Step 11 of
  // the drill measures it, and the drill exits 0 whether or not the step is there,
  // so the step is pinned from outside.
  const drill = read("scripts/phase-tool-drill.sh");
  assert.match(drill, /check-release-phase\.mjs/, "the drill does not run the phase gate");
  // All three modes, each named at an assertion rather than only in a comment.
  assert.match(drill, /gate_mode strict/);
  assert.match(drill, /gate_mode compat/);
  assert.match(drill, /gate_mode absent/);
  // The state 4 → 5 → 6 walk, which is what makes the refusal a property of the
  // database rather than a one-shot event.
  assert.match(drill, /rollback_money_direct_write_contract_phase\.sql/);
  assert.match(drill, /recontract_money_direct_write_contract_phase\.sql/);
  // C8's two halves in one place: the contract phase recorded, the mode at compat.
  assert.match(drill, /schema_migrations where version = '\$CONTRACT_VERSION'/);
  assert.match(drill, /phase_gate refuse "\$PGDATABASE" "completion at state 5" --for-completion/);
  // The pre-mechanism target is a real directory with no manifest, not a stub, and
  // the refusal must arrive through the undeclared default rather than an error.
  assert.match(drill, /target declares    : absent, compat \\\(undeclared, no manifest in the release\\\)/);
  // A refusal that still printed a mode would be recorded by the rollback script as
  // a switch it may make, so stdout is checked on every refusal.
  assert.match(drill, /refused but printed a mode on stdout/);
  // Negative controls: absence must not be inferred from a failing call, and the
  // URL-file mode check only means something on a POSIX host.
  assert.match(drill, /absence is not being established positively/);
  assert.match(drill, /accepted a group-readable URL file/);
  // And the drill has to be run by a job that can go red.
  const ci = read(".github/workflows/ci.yml");
  const at = ci.indexOf("phase-tool-drill.sh");
  assert.ok(at > 0, "no job runs the drill");
  assert.doesNotMatch(ci.slice(at - 400, at), /continue-on-error:\s*true/);
});
