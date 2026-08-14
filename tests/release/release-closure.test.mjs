import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditFinalRequiredRun,
  auditReleaseClosure,
  inspectReleaseClosure,
} from "../../scripts/check-release-closure.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(ROOT, "scripts", "check-release-closure.mjs");
const FINAL_JOBS = path.join(ROOT, "infra", "release", "final-required-jobs.json");
const CI_WORKFLOW = path.join(ROOT, ".github", "workflows", "ci.yml");
const CANONICAL_DEPLOY = path.join(ROOT, "infra", "systemd", "newme-deploy.sh");
const FINAL_RUN_ID = "29351813434";

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Release Closure Test",
      GIT_AUTHOR_EMAIL: "release-closure@example.invalid",
      GIT_COMMITTER_NAME: "Release Closure Test",
      GIT_COMMITTER_EMAIL: "release-closure@example.invalid",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function commit(repo, message) {
  git(repo, "add", "--all");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function fixture() {
  const repo = mkdtempSync(path.join(tmpdir(), "newme-release-closure-"));
  git(repo, "init", "--quiet");

  writeFileSync(path.join(repo, "TASKBOARD.md"), "# Taskboard\n\n| item | status |\n| --- | --- |\n| release | open |\n");
  const releaseSha = commit(repo, "release");

  writeFileSync(path.join(repo, "TASKBOARD.md"), "# Taskboard\n\n| item | status |\n| --- | --- |\n| release | closed |\n");
  const closureSha = commit(repo, "close taskboard");

  git(repo, "switch", "--quiet", "--create", "sibling", releaseSha);
  writeFileSync(path.join(repo, "TASKBOARD.md"), "# sibling closure\n");
  const siblingSha = commit(repo, "unrelated closure");

  git(repo, "switch", "--quiet", "--create", "source-change", releaseSha);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "TASKBOARD.md"), "# Taskboard closed with source change\n");
  writeFileSync(path.join(repo, "src", "changed.ts"), "export const changed = true;\n");
  const sourceSha = commit(repo, "close taskboard and change source");

  return { repo, releaseSha, closureSha, siblingSha, sourceSha };
}

function runCli(repo, releaseSha, closureSha) {
  return spawnSync(
    process.execPath,
    [CLI, "--release-sha", releaseSha, "--closure-sha", closureSha, "--repo", repo],
    { encoding: "utf8", windowsHide: true },
  );
}

function finalRunEvidence(closureSha, overrides = {}) {
  const manifest = JSON.parse(readFileSync(FINAL_JOBS, "utf8"));
  const run = {
    id: Number(FINAL_RUN_ID),
    head_sha: closureSha,
    name: manifest.workflow,
    status: "completed",
    conclusion: "success",
    event: manifest.event,
    head_branch: manifest.head_branch,
    ...overrides.run,
  };
  const jobs = manifest.required_jobs.map((entry) => ({
    name: entry.name,
    status: "completed",
    conclusion: "success",
    head_sha: closureSha,
  }));
  for (const override of overrides.jobs ?? []) {
    const index = jobs.findIndex((job) => job.name === override.name);
    if (override.drop && index >= 0) jobs.splice(index, 1);
    else if (index >= 0) jobs[index] = { ...jobs[index], ...override };
    else jobs.push(override);
  }
  return {
    run,
    jobsResponse: {
      total_count: overrides.totalCount ?? jobs.length,
      jobs,
    },
    manifest: overrides.manifest ?? manifest,
  };
}

function writeFinalRunEvidence(repo, evidence) {
  const files = {
    runJsonFile: path.join(repo, "run.json"),
    jobsJsonFile: path.join(repo, "jobs.json"),
    requiredJobsFile: path.join(repo, "final-required-jobs.json"),
  };
  writeFileSync(files.runJsonFile, JSON.stringify(evidence.run));
  writeFileSync(files.jobsJsonFile, JSON.stringify(evidence.jobsResponse));
  writeFileSync(files.requiredJobsFile, JSON.stringify(evidence.manifest));
  return files;
}

function runFinalCli(repo, releaseSha, closureSha, evidence, runId = FINAL_RUN_ID) {
  const files = writeFinalRunEvidence(repo, evidence);
  return spawnSync(
    process.execPath,
    [
      CLI,
      "--release-sha", releaseSha,
      "--closure-sha", closureSha,
      "--repo", repo,
      "--run-id", runId,
      "--run-json-file", files.runJsonFile,
      "--jobs-json-file", files.jobsJsonFile,
      "--required-jobs-file", files.requiredJobsFile,
    ],
    { encoding: "utf8", windowsHide: true },
  );
}

test("a non-empty TASKBOARD-only descendant is a valid closure", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));

  const measured = inspectReleaseClosure(data);
  assert.deepEqual(measured, { isAncestor: true, changedFiles: ["TASKBOARD.md"] });
  assert.deepEqual(auditReleaseClosure({ ...data, ...measured }), []);

  const cli = runCli(data.repo, data.releaseSha, data.closureSha);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`release=${data.releaseSha} closure=${data.closureSha}`));
  assert.match(cli.stdout, /changed files \(1\): TASKBOARD\.md/);
});

test("a closure outside the release ancestry is refused", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));

  const measured = inspectReleaseClosure({
    repo: data.repo,
    releaseSha: data.closureSha,
    closureSha: data.siblingSha,
  });
  assert.equal(measured.isAncestor, false);
  assert.match(
    auditReleaseClosure({
      releaseSha: data.closureSha,
      closureSha: data.siblingSha,
      ...measured,
    }).join("\n"),
    /not an ancestor/,
  );

  const cli = runCli(data.repo, data.closureSha, data.siblingSha);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /release SHA is not an ancestor of closure SHA/);
});

test("an empty release-to-closure diff is refused", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));

  assert.match(
    auditReleaseClosure({
      releaseSha: data.releaseSha,
      closureSha: data.releaseSha,
      isAncestor: true,
      changedFiles: [],
    }).join("\n"),
    /diff is empty/,
  );

  const cli = runCli(data.repo, data.releaseSha, data.releaseSha);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /release-to-closure diff is empty/);
});

test("any source file in the closure diff is refused by name", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));

  const measured = inspectReleaseClosure({
    repo: data.repo,
    releaseSha: data.releaseSha,
    closureSha: data.sourceSha,
  });
  assert.deepEqual(measured.changedFiles, ["TASKBOARD.md", "src/changed.ts"]);
  assert.match(
    auditReleaseClosure({
      releaseSha: data.releaseSha,
      closureSha: data.sourceSha,
      ...measured,
    }).join("\n"),
    /files other than TASKBOARD\.md: "src\/changed\.ts"/,
  );

  const cli = runCli(data.repo, data.releaseSha, data.sourceSha);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /"src\/changed\.ts"/);
});

test("malformed, short, uppercase, and missing commit SHAs fail closed", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));

  for (const bad of ["bad", "a".repeat(39), "A".repeat(40), `${"a".repeat(39)}g`, ""]) {
    const problems = auditReleaseClosure({
      releaseSha: bad,
      closureSha: data.closureSha,
      isAncestor: true,
      changedFiles: ["TASKBOARD.md"],
    });
    assert.match(problems.join("\n"), /release SHA must be exactly 40 lowercase hexadecimal characters/);
    const cli = runCli(data.repo, bad, data.closureSha);
    assert.notEqual(cli.status, 0, `bad SHA was accepted: ${JSON.stringify(bad)}`);
    assert.match(cli.stderr, /release SHA must be exactly 40 lowercase hexadecimal characters/);
  }

  const absent = "f".repeat(40);
  const cli = runCli(data.repo, absent, data.closureSha);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /release SHA is not an existing commit in the repository/);
});

test("an unmeasured pure-function claim is refused", () => {
  const problems = auditReleaseClosure({
    releaseSha: "a".repeat(40),
    closureSha: "b".repeat(40),
    isAncestor: undefined,
    changedFiles: undefined,
  });
  assert.match(problems.join("\n"), /ancestry was not measured/);
  assert.match(problems.join("\n"), /changed files were not measured/);
});

test("the final job manifest binds the closure job to the deployed release input", () => {
  const manifest = JSON.parse(readFileSync(FINAL_JOBS, "utf8"));
  assert.equal(manifest.workflow, "ci");
  assert.equal(manifest.event, "workflow_dispatch");
  assert.equal(manifest.head_branch, "main");
  assert.deepEqual(manifest.tolerated_conclusions, ["success"]);
  assert.deepEqual(manifest.required_jobs.map((job) => job.name), ["Release-final taskboard completion"]);
  assert.match(manifest.required_jobs[0].why, /closure SHA/);
  assert.match(manifest.required_jobs[0].why, /release_sha input/);
  assert.match(manifest.required_jobs[0].why, /deployed release SHA/);
});

test("final CI evidence is accepted only when the run and required job are green at closure SHA", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));
  const evidence = finalRunEvidence(data.closureSha);

  assert.deepEqual(auditFinalRequiredRun({
    closureSha: data.closureSha,
    runId: FINAL_RUN_ID,
    ...evidence,
  }), []);

  const cli = runFinalCli(data.repo, data.releaseSha, data.closureSha, evidence);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`final CI run ${FINAL_RUN_ID} is green at closure SHA`));
});

test("a green final run at the release SHA cannot close the later closure SHA", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));
  const evidence = finalRunEvidence(data.closureSha, {
    run: { head_sha: data.releaseSha },
    jobs: [{ name: "Release-final taskboard completion", head_sha: data.releaseSha }],
  });
  const problems = auditFinalRequiredRun({
    closureSha: data.closureSha,
    runId: FINAL_RUN_ID,
    ...evidence,
  });
  assert.match(problems.join("\n"), /final run head_sha is not the closure SHA/);
  assert.match(problems.join("\n"), /ran against a different commit/);

  const cli = runFinalCli(data.repo, data.releaseSha, data.closureSha, evidence);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /final run head_sha is not the closure SHA/);
});

test("missing, skipped, duplicate, failed, and paginated final jobs all fail closed", () => {
  const closureSha = "c".repeat(40);
  const cases = [
    [
      finalRunEvidence(closureSha, { jobs: [
        { name: "Release-final taskboard completion", drop: true },
        { name: "Repository validation", status: "completed", conclusion: "success", head_sha: closureSha },
      ] }),
      /required final job\(s\) absent/,
    ],
    [
      finalRunEvidence(closureSha, { jobs: [{ name: "Release-final taskboard completion", conclusion: "skipped" }] }),
      /concluded "skipped"/,
    ],
    [
      finalRunEvidence(closureSha, { jobs: [{ name: "Release-final taskboard completion copy", status: "completed", conclusion: "success", head_sha: closureSha }], manifest: {
        ...JSON.parse(readFileSync(FINAL_JOBS, "utf8")),
        required_jobs: [
          { name: "Release-final taskboard completion" },
          { name: "Release-final taskboard completion" },
        ],
      } }),
      /manifest lists a job twice/,
    ],
    [
      finalRunEvidence(closureSha, { jobs: [{ name: "Repository validation", status: "completed", conclusion: "failure", head_sha: closureSha }] }),
      /non-required final job "Repository validation" concluded "failure"/,
    ],
    [
      finalRunEvidence(closureSha, { totalCount: 101 }),
      /final job list is incomplete/,
    ],
  ];

  for (const [evidence, pattern] of cases) {
    assert.match(auditFinalRequiredRun({
      closureSha,
      runId: FINAL_RUN_ID,
      ...evidence,
    }).join("\n"), pattern);
  }
});

test("partial final-run CLI evidence and malformed JSON are refusals", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));
  const partial = spawnSync(
    process.execPath,
    [
      CLI,
      "--release-sha", data.releaseSha,
      "--closure-sha", data.closureSha,
      "--repo", data.repo,
      "--run-id", FINAL_RUN_ID,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(partial.status, 64);
  assert.match(partial.stderr, /final run verification requires all four flags/);

  const evidence = finalRunEvidence(data.closureSha);
  const files = writeFinalRunEvidence(data.repo, evidence);
  writeFileSync(files.runJsonFile, "not-json\n");
  const malformed = spawnSync(
    process.execPath,
    [
      CLI,
      "--release-sha", data.releaseSha,
      "--closure-sha", data.closureSha,
      "--repo", data.repo,
      "--run-id", FINAL_RUN_ID,
      "--run-json-file", files.runJsonFile,
      "--jobs-json-file", files.jobsJsonFile,
      "--required-jobs-file", files.requiredJobsFile,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /final run evidence could not be read as JSON/);
});

test("release-final workflow proves the exact closure before checking taskboard completion", () => {
  const workflow = readFileSync(CI_WORKFLOW, "utf8").replaceAll("\r\n", "\n");
  assert.match(workflow, /\n      release_sha:\n[\s\S]*?type: string/);
  assert.match(workflow, /\n      closure_sha:\n[\s\S]*?type: string/);

  const start = workflow.indexOf("  taskboard-completion:");
  const end = workflow.indexOf("\n  local-database:", start);
  assert.ok(start >= 0 && end > start);
  const job = workflow.slice(start, end);
  const closureGate = job.indexOf("node scripts/check-release-closure.mjs");
  const taskboardGate = job.indexOf("npm run check:taskboard:complete");
  assert.ok(closureGate > 0 && taskboardGate > closureGate);
  assert.match(job, /fetch-depth: 0/);
  assert.match(job, /RELEASE_SHA: \$\{\{ inputs\.release_sha \}\}/);
  assert.match(job, /CLOSURE_SHA: \$\{\{ inputs\.closure_sha \}\}/);
  assert.match(job, /\[ "\$GITHUB_REF" = "refs\/heads\/main" \]/);
  assert.match(job, /\[ "\$CLOSURE_SHA" = "\$GITHUB_SHA" \]/);
  assert.match(job, /\[ "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA" \]/);
});

test("canonical pass finalization verifies dual SHAs and closure CI; fail remains a non-completion path", () => {
  const source = readFileSync(CANONICAL_DEPLOY, "utf8").replaceAll("\r\n", "\n");
  const finalizeStart = source.indexOf('if [ "${1:-}" = "finalize" ]; then');
  const finalizeEnd = source.indexOf("\nfi\n\nBOOTSTRAP_ONLY=0", finalizeStart);
  assert.ok(finalizeStart >= 0 && finalizeEnd > finalizeStart);
  const finalize = source.slice(finalizeStart, finalizeEnd);

  assert.match(finalize, /\[ "\$#" -eq 8 \] && \[ "\$\{5:-\}" = pass \]/);
  assert.match(finalize, /\[ "\$#" -eq 6 \] && \[ "\$\{3:-\}" = fail \]/);
  assert.match(finalize, /verify_release_closure_and_final_ci/);
  assert.ok(finalize.indexOf("verify_release_closure_and_final_ci") < finalize.indexOf("finalize-deploy-evidence.sh"));
  assert.match(finalize, /RELEASE_CLOSURE_SHA="\$FINALIZE_CLOSURE_SHA"/);
  assert.match(finalize, /RELEASE_FINAL_RUN_ID="\$FINALIZE_RUN_ID"/);

  const verifierStart = source.indexOf("verify_release_closure_and_final_ci() (");
  assert.ok(verifierStart >= 0 && verifierStart < finalizeStart);
  const verifier = source.slice(verifierStart, finalizeStart);
  assert.match(verifier, /\[ "\$FINALIZE_CLOSURE_SHA" = "\$main_sha" \]/);
  assert.match(verifier, /\$FINALIZE_CLOSURE_SHA:infra\/release\/final-required-jobs\.json/);
  assert.match(verifier, /actions\/runs\/\$FINALIZE_RUN_ID\/jobs\?per_page=100&filter=latest/);
  assert.match(verifier, /--release-sha "\$FINALIZE_RELEASE_SHA"/);
  assert.match(verifier, /--closure-sha "\$FINALIZE_CLOSURE_SHA"/);
  assert.match(verifier, /--run-id "\$FINALIZE_RUN_ID"/);
});
