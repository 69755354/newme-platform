import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

test("CI runs on pull requests, main pushes, and manual dispatch", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  assert.match(workflow, /^on:\s*\n(?:[\s\S]*?)^  workflow_dispatch:/m);
  assert.match(workflow, /^  pull_request:\s*$/m);
  assert.match(workflow, /^  push:\s*\n    branches:\s*\n      - main\s*$/m);
  // The Windows SPEC gate runs on PRs and every release-candidate dispatch.
  assert.match(
    workflow,
    /windows-checkout:[\s\S]*?if: \$\{\{ github\.event_name == 'pull_request' \|\| github\.event_name == 'workflow_dispatch' \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(
    workflow,
    /sparse-checkout: \|\s*\n\s*crm-v3\/SPEC\.md\s*\n\s*scripts\/check-spec\.sh\s*\n\s*scripts\/run-bash\.mjs\s*\n\s*sparse-checkout-cone-mode: false/,
  );
  assert.match(workflow, /node scripts\/run-bash\.mjs scripts\/check-spec\.sh/);
  assert.doesNotMatch(workflow, /playwright install/);
  assert.match(
    workflow,
    /container:\s*\n\s*image: mcr\.microsoft\.com\/playwright:v1\.60\.0-noble@sha256:[0-9a-f]{64}/,
  );
  assert.match(
    workflow,
    /npm exec --offline -- playwright test --config=playwright\.production-smoke\.config\.ts/,
  );
});

test("ordinary, credential-remediation, and release-final taskboard modes are distinct", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const ordinaryManifest = JSON.parse(await readFile(new URL("infra/release/required-jobs.json", ROOT), "utf8"));
  const credentialManifest = JSON.parse(
    await readFile(new URL("infra/release/credential-remediation-required-jobs.json", ROOT), "utf8"),
  );
  const shell = await readFile(new URL("scripts/check-taskboard.sh", ROOT), "utf8");
  assert.equal(packageJson.scripts["check:taskboard"], "node scripts/check-taskboard.mjs");
  assert.equal(
    packageJson.scripts["check:taskboard:complete"],
    "node scripts/check-taskboard.mjs --require-complete",
  );
  // Round-4 C4-4. There are exactly two taskboard milestones: the canonical
  // wrapper and bootstrap coordinator both run predeploy, while release-final
  // keeps requiring the whole board after production evidence exists.
  assert.equal(
    packageJson.scripts["check:taskboard:predeploy"],
    "node scripts/check-taskboard.mjs --require-scope=predeploy_ready",
  );
  assert.equal(
    packageJson.scripts["check:taskboard:credential-remediation"],
    "node scripts/check-taskboard.mjs --require-credential-remediation",
  );
  assert.equal(packageJson.scripts["check:taskboard:bootstrap"], undefined);
  assert.match(workflow, /- name: Taskboard gate\s*\n        run: npm run check:taskboard/);
  assert.match(workflow, /release_final:[\s\S]*?type: boolean/);
  assert.match(workflow, /credential_remediation:[\s\S]*?type: boolean/);
  assert.match(
    workflow,
    /taskboard-completion:[\s\S]*?github\.event_name == 'workflow_dispatch' && inputs\.release_final[\s\S]*?npm run check:taskboard:complete/,
  );
  assert.match(
    workflow,
    /taskboard-predeploy:[\s\S]*?github\.event_name == 'workflow_dispatch' && !inputs\.credential_remediation[\s\S]*?npm run check:taskboard:predeploy/,
  );
  assert.match(
    workflow,
    /credential-remediation-readiness:[\s\S]*?name: Credential remediation readiness[\s\S]*?github\.event_name == 'workflow_dispatch' && inputs\.credential_remediation[\s\S]*?credential remediation and release_final are mutually exclusive[\s\S]*?npm run check:taskboard:credential-remediation/,
  );
  assert.match(workflow, /credential remediation must be dispatched on main/);

  assert.equal(credentialManifest.workflow, "ci");
  assert.equal(credentialManifest.workflow_path, ".github/workflows/ci.yml");
  assert.equal(credentialManifest.workflow_id, 310914082);
  assert.equal(credentialManifest.event, "workflow_dispatch");
  assert.equal(credentialManifest.head_branch, "main");
  assert.equal(credentialManifest.max_run_age_seconds, 21600);
  const credentialRequired = credentialManifest.required_jobs.map((entry) => entry.name);
  assert.deepEqual(credentialRequired, [
    "Repository validation",
    "CodeQL analysis",
    "Windows checkout and SPEC gate",
    "Credential remediation readiness",
    "Control-plane restore interruption drill",
    "Narrow task follow-up database contract",
    "Migration replay and release contracts",
  ]);
  const credentialSkipped = credentialManifest.required_skipped_jobs.map((entry) => entry.name);
  assert.deepEqual(credentialSkipped, [
    "Predeploy taskboard readiness",
    "Release-final taskboard completion",
  ]);
  const ordinaryRequired = ordinaryManifest.required_jobs.map((entry) => entry.name);
  assert.ok(ordinaryRequired.includes("Predeploy taskboard readiness"));
  assert.ok(!ordinaryRequired.includes("Credential remediation readiness"));
  assert.ok(credentialRequired.includes("Credential remediation readiness"));
  assert.ok(!credentialRequired.includes("Predeploy taskboard readiness"));
  assert.ok(
    credentialSkipped.includes("Predeploy taskboard readiness"),
    "a remediation run must skip the job whose success the ordinary deploy manifest requires",
  );
  assert.match(shell, /exec node "\$SCRIPT_DIR\/check-taskboard\.mjs" "\$@"/);
});

test("release-candidate CI requires the isolated control-plane SIGTERM and reentry drill", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  const manifest = JSON.parse(await readFile(new URL("infra/release/required-jobs.json", ROOT), "utf8"));
  const jobs = jobBlocks(workflow);
  const drill = jobs.find((job) => job.id === "control-plane-restore");
  assert.ok(drill, "ci.yml must define the control-plane restore drill job");
  assert.match(drill.body, /name: Control-plane restore interruption drill/);
  assert.match(drill.body, /github\.event_name == 'workflow_dispatch' && !inputs\.release_final/);
  assert.match(drill.body, /fetch-depth: 0/);
  assert.match(drill.body, /persist-credentials: false/);
  assert.match(drill.body, /docker run --rm/);
  assert.match(drill.body, /--network none/);
  assert.match(drill.body, /--volume "\$PWD:\/repo:ro"/);
  assert.match(drill.body, /NEWME_DRILL_CONFIRM=throwaway-container/);
  assert.match(drill.body, /docker\.io\/library\/node:24\.18\.0-bookworm@sha256:[0-9a-f]{64}/);
  assert.match(drill.body, /bash \/repo\/scripts\/control-plane-restore-drill\.sh/);
  assert.match(drill.body, /bash \/repo\/scripts\/credential-assets-transaction-drill\.sh/);
  assert.match(drill.body, /bash \/repo\/scripts\/alert-state-preflight-drill\.sh/);
  assert.match(drill.body, /node \/repo\/scripts\/credential-live-attestation-drill\.mjs/);
  assert.match(drill.body, /exec 9>\/run\/lock\/newme-production-release\.lock; exec node \/repo\/scripts\/credential-live-five-stage-drill\.mjs/);
  assert.match(drill.body, /NEWME_CREDENTIAL_LIVE_DRILL_MODE=expire-prepared/);
  assert.match(drill.body, /--pids-limit 256/);
  assert.match(drill.body, /--memory 1g/);
  assert.match(drill.body, /--cpus 2/);
  const controlPlaneDrill = await readFile(
    new URL("scripts/control-plane-restore-drill.sh", ROOT),
    "utf8",
  );
  assert.match(
    controlPlaneDrill,
    /git -c safe\.directory="\$REPO" -C "\$REPO" show f37c203:scripts\/install-systemd-assets\.sh/,
  );
  assert.match(
    controlPlaneDrill,
    /git -c safe\.directory="\$REPO" -C "\$REPO" show 03f53ab08c61dcfff830e3e6d219f7c374c914f9:scripts\/install-systemd-assets\.sh/,
  );
  assert.match(controlPlaneDrill, /03f53ab08c61dcfff830e3e6d219f7c374c914f9:scripts\/install-systemd-assets\.sh/);
  assert.doesNotMatch(controlPlaneDrill, /show HEAD:scripts\/install-systemd-assets\.sh/);
  const alertPreflightDrill = await readFile(new URL("scripts/alert-state-preflight-drill.sh", ROOT), "utf8");
  assert.match(alertPreflightDrill, /bash "\$FIXTURE_ROOT\/scripts\/install-systemd-assets\.sh" \\/);
  assert.match(alertPreflightDrill, /untrusted_directory/);
  assert.match(alertPreflightDrill, /untrusted_file/);
  assert.match(alertPreflightDrill, /state-symlink symlink/);
  assert.match(alertPreflightDrill, /chown -R root:root "\$FIXTURE_ROOT"\s+git -C "\$FIXTURE_ROOT" init -q/);
  assert.match(alertPreflightDrill, /leaves the complete target tree unchanged/);
  assert.match(alertPreflightDrill, /installer lock write/);
  assert.match(alertPreflightDrill, /before deploy-state creation/);
  const credentialLiveDrill = await readFile(
    new URL("scripts/credential-live-attestation-drill.mjs", ROOT),
    "utf8",
  );
  const credentialAssetDrill = await readFile(
    new URL("scripts/credential-assets-transaction-drill.sh", ROOT),
    "utf8",
  );
  assert.match(
    credentialAssetDrill,
    /chown root:root \/etc\/systemd\/system\/newme-platform\.service\s+chmod 0644 \/etc\/systemd\/system\/newme-platform\.service/,
  );
  assert.match(credentialLiveDrill, /removeTrustedRootFileMatching/);
  assert.match(credentialLiveDrill, /readCredentialEscrow/);
  assert.match(credentialLiveDrill, /credential_live_attestation_drill_checks=/);
  const credentialFiveStageDrill = await readFile(
    new URL("scripts/credential-live-five-stage-drill.mjs", ROOT),
    "utf8",
  );
  assert.match(credentialFiveStageDrill, /prepareInstalledCredentialAttestation/);
  assert.match(credentialFiveStageDrill, /produceInstalledRevocationProof/);
  assert.match(credentialFiveStageDrill, /produceInstalledCompletion/);
  assert.match(credentialFiveStageDrill, /produceInstalledReadback/);
  assert.match(credentialFiveStageDrill, /consumeInstalledCredentialAttestation/);
  assert.match(credentialFiveStageDrill, /expirePreparedCredentialAttestation/);
  assert.match(credentialFiveStageDrill, /credential_live_five_stage_drill_checks=/);
  assert.match(credentialFiveStageDrill, /credential_live_expiry_drill_checks=/);
  assert.doesNotMatch(drill.body, /\bsecrets\.|SUPABASE_|POSTGRES|PGPASSWORD/i);
  assert.ok(
    manifest.required_jobs.some((entry) => entry.name === "Control-plane restore interruption drill"),
    "the canonical wrapper would not require the drill's result",
  );
});

test("the published-credential gate is wired into CI with its negative regression", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));

  assert.equal(
    packageJson.scripts["check:published-credentials"],
    "node scripts/check-published-credentials.mjs",
  );
  // Part of the aggregate too, so `npm run check:security` cannot pass a tree the
  // dedicated gate would fail.
  assert.match(packageJson.scripts["check:security"], /npm run check:published-credentials/);

  assert.match(workflow, /- name: Published credential gate\s*\n        run: npm run check:published-credentials/);
  // The gate alone proves nothing — it exits 0 on a tree it has no rule for. The
  // regression is what makes a green gate mean something, so CI must run both.
  assert.match(
    workflow,
    /- name: Published credential gate negative regression\s*\n        run: node --test tests\/security\/published-credentials\.test\.mjs tests\/security\/dev-identity-bootstrap\.test\.mjs/,
  );

  // Both steps run inside the job whose identity production requires.
  const jobs = jobBlocks(workflow);
  const validate = jobs.find((job) => job.id === "validate");
  assert.ok(validate, "ci.yml must define the validate job");
  assert.match(validate.body, /npm run check:published-credentials/);

  // And the gate never prints a value, in any of its output paths. Checked as a
  // property of the interpolations rather than of the words: the remediation text
  // says "redact the value", which is prose about a value and not one.
  const gate = await readFile(new URL("scripts/check-published-credentials.mjs", ROOT), "utf8");
  assert.match(gate, /Values are deliberately not printed/);
  for (const printer of gate.matchAll(/console\.(?:log|error)\((.*)$/gm)) {
    for (const interpolation of printer[1].matchAll(/\$\{([^}]*)\}/g)) {
      assert.doesNotMatch(
        interpolation[1],
        /\b(value|secret|password|passwd|token|credential|cell|line\[|match)\b/i,
        `a gate output line may interpolate the location and the rule, never the matched text: ${printer[1]}`,
      );
    }
  }
  // The finding shape is the structural guarantee behind that: a finding cannot
  // carry a value because it has nowhere to put one.
  const { auditSource, auditText } = await import("../../scripts/check-published-credentials.mjs");
  const shapes = [
    ...auditSource('const DEV_PASSWORD = "not-a-real-value";'),
    // Deliberately not an address in the first column: the pair rule would then
    // report this fixture too, and one fixture should exercise one rule.
    ...auditText(["| Account | Password |", "|---|---|", "| an-account | not-a-real-value |"].join("\n")),
  ];
  assert.ok(shapes.length >= 2);
  for (const finding of shapes) {
    assert.deepEqual(Object.keys(finding).sort(), ["detail", "line", "rule"]);
    assert.doesNotMatch(finding.detail, /not-a-real-value/);
  }
});

test("migration replay job gates on a negative control and never reaches production", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  const start = workflow.indexOf("  migration-replay:");
  assert.notEqual(start, -1, "ci.yml must define the migration-replay job");
  const job = workflow.slice(start);

  // A throwaway service container, not a linked project.
  assert.match(job, /image: docker\.io\/library\/postgres:17\.11-trixie@sha256:[0-9a-f]{64}/);
  assert.match(job, /POSTGRES_HOST_AUTH_METHOD: trust/);
  assert.doesNotMatch(
    job,
    /\bsecrets\.|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|supabase\s+link|--linked|PGPASSWORD/i,
  );

  // The control step must come before the gating replay: assertions that hold
  // against the un-remediated floor prove nothing, and running them second would
  // let a vacuous gate report green first.
  const control = job.indexOf("MODE=control");
  const branch = job.indexOf("MODE=branch");
  const history = job.indexOf("MODE=history");
  assert.notEqual(control, -1, "the negative control step must exist");
  assert.notEqual(branch, -1, "the gating replay step must exist");
  assert.ok(control < branch, "the negative control must run before the gating replay");

  // All three modes gate. The reviewed revision allowed exactly one
  // continue-on-error step — the history replay — and this test asserted its
  // presence, so the false green was written into the contract. A step whose
  // result is discarded is not evidence of anything, so there is now no
  // continue-on-error in this job at all, and the assertion runs the other way.
  // Anchored to a YAML key so the comment recording that history does not satisfy
  // its own assertion.
  assert.doesNotMatch(job, /^\s*continue-on-error\s*:/m);
  assert.notEqual(history, -1, "the full-history replay step must exist");
  assert.ok(history > branch, "the full-history replay must run after the branch replay");

  // And it must be gating against the captured production watermark, not a
  // recorded failure that treats an unreplayable directory as success.
  assert.match(job, /- name: Captured production baseline and exact pending migration replay/);
  assert.match(job, /authenticated schema-only production capture/);
  assert.doesNotMatch(job, /history-replay-expectation\.txt/);

  // The fixed hosted-runner label remains a time-bounded exception, so its
  // preinstalled client is asserted against a pinned version and no mutable apt
  // resolution is allowed back into the release job. The Debian packaging
  // revision is deliberately not pinned: the runner image re-spun the same
  // 16.14 client as +2, which is not a replay risk, and pinning it turned every
  // run in the repository into a coin flip on which image the job landed.
  assert.match(job, /"psql \(PostgreSQL\) 16\.14 \(Ubuntu 16\.14-1\.pgdg24\.04\+"\*\)/);
  assert.match(job, /unexpected psql client for this replay/);
  assert.doesNotMatch(job, /\bapt(?:-get)?\s+(?:update|install)\b/);

  // The history immutability gate is a precondition for every replay below it:
  // if applied migrations have been edited or renamed, the replay is measuring a
  // history production does not have.
  const historyGate = job.indexOf("npm run check:migration-history");
  assert.notEqual(historyGate, -1, "the migration history immutability gate must run in this job");
  assert.ok(historyGate < control, "the history immutability gate must run before the replays");
  // It cross-checks the manifest against BASE_COMMIT with git, and fails rather
  // than warning when that commit is absent.
  assert.match(job.slice(0, historyGate), /fetch-depth: 0/);
});

test("local database job is pinned, isolated, repeatable, and has no remote credential path", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  const start = workflow.indexOf("  local-database:");
  assert.notEqual(start, -1);
  const localJob = workflow.slice(start);
  assert.match(localJob, /uses: actions\/checkout@[0-9a-f]{40} # v4\.4\.0\s*\n        with:\s*\n          fetch-depth: 0/);
  assert.match(localJob, /name: Narrow task follow-up database contract/);
  assert.doesNotMatch(localJob, /uses: supabase\/setup-cli@/);
  assert.match(localJob, /node scripts\/install-reviewed-artifact\.mjs supabase-cli-linux-amd64/);
  assert.match(localJob, /RUNNER_TEMP\/newme-supabase-cli/);
  assert.match(localJob, /node supabase\/ci-local\/verify-provenance\.mjs/);
  assert.match(localJob, /supabase db start --workdir supabase\/ci-local/);
  assert.equal(
    localJob.match(/supabase db reset --local --workdir supabase\/ci-local --yes/g)?.length,
    2,
  );
  assert.equal(localJob.match(/node supabase\/ci-local\/verify-reset\.mjs/g)?.length, 2);
  assert.match(
    localJob,
    /supabase test db --local --workdir supabase\/ci-local supabase\/ci-local\/supabase\/tests\/database/,
  );
  assert.match(
    localJob,
    /printf '%s\\n' "\$test_output" \| node scripts\/verify-pgtap-output\.mjs/,
  );
  assert.match(
    localJob,
    /supabase stop --project-id newme-ci-task-followup-v1 --no-backup/,
  );
  assert.doesNotMatch(
    localJob,
    /\bsecrets\.|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|supabase\s+link|--linked|\bdb\s+(?:push|pull|dump)\b/i,
  );
  assert.doesNotMatch(localJob, /--workdir\s+supabase(?:\s|$)/m);
});

/**
 * The migration-history immutability gate verifies the manifest against the base
 * commit with git and fails closed when that commit is not in the clone. On a
 * shallow checkout it therefore cannot pass — which is what it should do, and
 * which means every job that runs it needs full history. This was a real red on
 * the first push of this branch: the `validate` job ran the gate's test through
 * `npm test` with the default (depth-1) checkout and reported
 * "manifest vs git: NOT VERIFIED".
 */
function jobBlocks(workflow) {
  const jobsAt = workflow.indexOf("\njobs:");
  assert.notEqual(jobsAt, -1, "ci.yml has no jobs: block");
  const body = workflow.slice(jobsAt);
  const starts = [...body.matchAll(/^ {2}([a-z0-9_-]+):$/gm)];
  return starts.map((match, index) => ({
    id: match[1],
    body: body.slice(match.index, index + 1 < starts.length ? starts[index + 1].index : undefined),
  }));
}

test("every job that verifies migration history checks out with full history", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  const jobs = jobBlocks(workflow);
  assert.ok(jobs.length >= 4, `parsed ${jobs.length} jobs out of ci.yml — the parser has drifted`);

  // A job needs full history if it runs the gate directly, or runs a test suite
  // that contains it. `npm test` runs tests/**, which includes the gate's test.
  const needsHistory = jobs.filter(({ body }) =>
    /npm run check:migration-history|npm (?:run )?test\b|node --test/.test(body),
  );
  assert.ok(
    needsHistory.length >= 2,
    "expected at least the validate and migration-replay jobs to verify migration history",
  );
  for (const job of needsHistory) {
    assert.match(
      job.body,
      /uses: actions\/checkout@[0-9a-f]{40} # v4\.4\.0\s*\n\s*with:\s*\n(?:\s*[a-z-]+:.*\n)*?\s*fetch-depth: 0/,
      `job '${job.id}' verifies migration history but checks out shallow; the gate then reports NOT VERIFIED and fails`,
    );
  }
});

test("the migration history gate refuses an unverifiable manifest rather than warning", async () => {
  const gate = await readFile(new URL("scripts/check-migration-history.mjs", ROOT), "utf8");
  // Negative: the failure mode this replaces is a gate that prints
  // "could not verify" and exits 0.
  assert.match(gate, /fetch-depth: 0/, "the gate must name the checkout requirement in its failure text");
  assert.match(
    gate,
    /is not present in this clone/,
    "the gate must report a missing base commit as a problem, not as a skipped check",
  );
});
