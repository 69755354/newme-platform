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
const ACCEPTANCE_DIGEST = "d".repeat(64);
const ACCEPTANCE_MARKER = `<!-- postdeploy-acceptance-sha256:${ACCEPTANCE_DIGEST} -->`;
const RELEASE_BOARD = `# Taskboard

## 活动任务

| TASK_ID | STATUS | OWNER | UPDATED_AT |
| --- | --- | --- | --- |
| RELEASE-ITEM | REVIEW | Codex | 2026-08-14 |
| HISTORICAL-DONE | DONE | Codex | 2026-08-13 |

### 发布里程碑

| item | scope | closure condition |
| --- | --- | --- |
| RELEASE-ITEM | postdeploy_acceptance | canonical evidence required |

## Evidence history

This historical prose must remain under this heading.

| # | File | Operation | Verification |
| --- | --- | --- | --- |
| 1 | src/release.ts | MODIFY | exact historical evidence |
| 2 | src/second.ts | VERIFY | second ordered historical row |
| HISTORICAL-OPEN | REVIEW | production acceptance required |
`;
const CLOSURE_BOARD = RELEASE_BOARD.replace(
  "| RELEASE-ITEM | REVIEW | Codex | 2026-08-14 |",
  "| RELEASE-ITEM | DONE | Codex | 2026-08-15 |",
).replace(
  "| HISTORICAL-OPEN | REVIEW | production acceptance required |",
  "| HISTORICAL-OPEN | DONE | production acceptance required |",
) + `\n${ACCEPTANCE_MARKER}\n`;

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

  writeFileSync(path.join(repo, "TASKBOARD.md"), RELEASE_BOARD);
  const releaseSha = commit(repo, "release");

  writeFileSync(path.join(repo, "TASKBOARD.md"), CLOSURE_BOARD);
  const closureSha = commit(repo, "close taskboard");

  git(repo, "switch", "--quiet", "--create", "sibling", releaseSha);
  writeFileSync(path.join(repo, "TASKBOARD.md"), CLOSURE_BOARD);
  const siblingSha = commit(repo, "unrelated closure");

  git(repo, "switch", "--quiet", "--create", "source-change", releaseSha);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "TASKBOARD.md"), CLOSURE_BOARD);
  writeFileSync(path.join(repo, "src", "changed.ts"), "export const changed = true;\n");
  const sourceSha = commit(repo, "close taskboard and change source");

  return { repo, releaseSha, closureSha, siblingSha, sourceSha, acceptanceDigest: ACCEPTANCE_DIGEST };
}

function runCli(repo, releaseSha, closureSha, acceptanceDigest = ACCEPTANCE_DIGEST) {
  return spawnSync(
    process.execPath,
    [CLI, "--release-sha", releaseSha, "--closure-sha", closureSha, "--acceptance-digest", acceptanceDigest, "--repo", repo],
    { encoding: "utf8", windowsHide: true },
  );
}

function finalRunEvidence(closureSha, overrides = {}) {
  const manifest = JSON.parse(readFileSync(FINAL_JOBS, "utf8"));
  const updatedAt = new Date(Date.now() - 60_000);
  const startedAt = new Date(updatedAt.getTime() - 60_000);
  const createdAt = new Date(startedAt.getTime() - 60_000);
  const run = {
    id: Number(FINAL_RUN_ID),
    head_sha: closureSha,
    name: manifest.workflow,
    path: manifest.workflow_path,
    workflow_id: manifest.workflow_id,
    status: "completed",
    conclusion: "success",
    event: manifest.event,
    head_branch: manifest.head_branch,
    created_at: createdAt.toISOString(),
    run_started_at: startedAt.toISOString(),
    updated_at: updatedAt.toISOString(),
    ...overrides.run,
  };
  const jobs = manifest.required_jobs.map((entry) => ({
    name: entry.name,
    status: "completed",
    conclusion: "success",
    head_sha: closureSha,
    started_at: startedAt.toISOString(),
    completed_at: updatedAt.toISOString(),
  }));
  for (const override of overrides.jobs ?? []) {
    const index = jobs.findIndex((job) => job.name === override.name);
    if (override.drop && index >= 0) jobs.splice(index, 1);
    else if (index >= 0) jobs[index] = { ...jobs[index], ...override };
    else jobs.push(override);
  }
  return {
    run,
    workflow: overrides.workflow ?? {
      id: manifest.workflow_id,
      path: manifest.workflow_path,
      name: manifest.workflow,
      state: "active",
    },
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
    workflowJsonFile: path.join(repo, "workflow.json"),
    requiredJobsFile: path.join(repo, "final-required-jobs.json"),
  };
  writeFileSync(files.runJsonFile, JSON.stringify(evidence.run));
  writeFileSync(files.jobsJsonFile, JSON.stringify(evidence.jobsResponse));
  writeFileSync(files.workflowJsonFile, JSON.stringify(evidence.workflow));
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
      "--acceptance-digest", ACCEPTANCE_DIGEST,
      "--repo", repo,
      "--run-id", runId,
      "--run-json-file", files.runJsonFile,
      "--jobs-json-file", files.jobsJsonFile,
      "--workflow-json-file", files.workflowJsonFile,
      "--required-jobs-file", files.requiredJobsFile,
    ],
    { encoding: "utf8", windowsHide: true },
  );
}

test("a non-empty TASKBOARD-only descendant is a valid closure", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));

  const measured = inspectReleaseClosure(data);
  assert.equal(measured.isAncestor, true);
  assert.deepEqual(measured.changedFiles, ["TASKBOARD.md"]);
  assert.match(measured.taskboardText, new RegExp(ACCEPTANCE_DIGEST));
  assert.deepEqual(auditReleaseClosure({ ...data, ...measured }), []);

  const cli = runCli(data.repo, data.releaseSha, data.closureSha);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`release=${data.releaseSha} closure=${data.closureSha}`));
  assert.match(cli.stdout, /changed files \(1\): TASKBOARD\.md/);
});

test("a multi-commit modify-then-revert chain cannot hide source changes behind a net TASKBOARD diff", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));
  git(data.repo, "switch", "--quiet", "--create", "multi-commit", data.releaseSha);
  mkdirSync(path.join(data.repo, "src"), { recursive: true });
  writeFileSync(path.join(data.repo, "src", "hidden.ts"), "export const hidden = true;\n");
  commit(data.repo, "intermediate source mutation");
  rmSync(path.join(data.repo, "src", "hidden.ts"));
  writeFileSync(path.join(data.repo, "TASKBOARD.md"), CLOSURE_BOARD);
  const closureSha = commit(data.repo, "net taskboard closure");
  const measured = inspectReleaseClosure({ repo: data.repo, releaseSha: data.releaseSha, closureSha });

  assert.deepEqual(measured.changedFiles, ["TASKBOARD.md"]);
  assert.equal(measured.commitCount, 2);
  assert.notEqual(measured.directParent, data.releaseSha);
  const problems = auditReleaseClosure({
    releaseSha: data.releaseSha,
    closureSha,
    acceptanceDigest: ACCEPTANCE_DIGEST,
    ...measured,
  }).join("\n");
  assert.match(problems, /single direct child/);
  assert.match(problems, /exactly one commit/);
  const cli = runCli(data.repo, data.releaseSha, closureSha);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /single direct child/);
});

test("closure preserves the complete active inventory and every historical table row", () => {
  const base = {
    releaseSha: "a".repeat(40),
    closureSha: "b".repeat(40),
    acceptanceDigest: ACCEPTANCE_DIGEST,
    isAncestor: true,
    directParent: "a".repeat(40),
    commitCount: 1,
    perCommitChangedFiles: [["TASKBOARD.md"]],
    changedFiles: ["TASKBOARD.md"],
    releaseTaskboardText: RELEASE_BOARD,
  };
  const deletedItem = CLOSURE_BOARD.replace("| HISTORICAL-DONE | DONE | Codex | 2026-08-13 |\n", "");
  assert.match(auditReleaseClosure({ ...base, taskboardText: deletedItem }).join("\n"), /stable item/);

  const deletedHistory = CLOSURE_BOARD.replace("| 1 | src/release.ts | MODIFY | exact historical evidence |\n", "");
  assert.match(auditReleaseClosure({ ...base, taskboardText: deletedHistory }).join("\n"), /historical table row/);

  const rewrittenHistoricalEvidence = CLOSURE_BOARD.replace(
    "| HISTORICAL-OPEN | DONE | production acceptance required |",
    "| HISTORICAL-OPEN | DONE | different evidence |",
  );
  assert.match(auditReleaseClosure({ ...base, taskboardText: rewrittenHistoricalEvidence }).join("\n"), /historical/);

  const historicalStatusNotClosed = CLOSURE_BOARD.replace(
    "| HISTORICAL-OPEN | DONE | production acceptance required |",
    "| HISTORICAL-OPEN | IN_PROGRESS | production acceptance required |",
  );
  assert.match(auditReleaseClosure({ ...base, taskboardText: historicalStatusNotClosed }).join("\n"), /historical/);

  const unknownStatus = CLOSURE_BOARD.replace(
    "| RELEASE-ITEM | DONE | Codex | 2026-08-15 |",
    "| RELEASE-ITEM | COMPLETE | Codex | 2026-08-15 |",
  );
  assert.match(auditReleaseClosure({ ...base, taskboardText: unknownStatus }).join("\n"), /unknown status/);

  const rewrittenHeading = CLOSURE_BOARD.replace("## Evidence history", "## Evidence accepted");
  assert.match(auditReleaseClosure({ ...base, taskboardText: rewrittenHeading }).join("\n"), /historical headings/);

  const deletedProse = CLOSURE_BOARD.replace("This historical prose must remain under this heading.\n", "");
  assert.match(auditReleaseClosure({ ...base, taskboardText: deletedProse }).join("\n"), /historical headings/);

  const reorderedRows = CLOSURE_BOARD.replace(
    "| 1 | src/release.ts | MODIFY | exact historical evidence |\n| 2 | src/second.ts | VERIFY | second ordered historical row |",
    "| 2 | src/second.ts | VERIFY | second ordered historical row |\n| 1 | src/release.ts | MODIFY | exact historical evidence |",
  );
  assert.match(auditReleaseClosure({ ...base, taskboardText: reorderedRows }).join("\n"), /historical headings/);
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
      acceptanceDigest: ACCEPTANCE_DIGEST,
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
      acceptanceDigest: ACCEPTANCE_DIGEST,
      isAncestor: true,
      changedFiles: [],
      taskboardText: ACCEPTANCE_MARKER,
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
      acceptanceDigest: ACCEPTANCE_DIGEST,
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
      acceptanceDigest: ACCEPTANCE_DIGEST,
      isAncestor: true,
      changedFiles: ["TASKBOARD.md"],
      taskboardText: ACCEPTANCE_MARKER,
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
    acceptanceDigest: ACCEPTANCE_DIGEST,
    isAncestor: undefined,
    changedFiles: undefined,
  });
  assert.match(problems.join("\n"), /ancestry was not measured/);
  assert.match(problems.join("\n"), /changed files were not measured/);
});

test("closure TASKBOARD must bind exactly the attested acceptance digest", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));
  const base = {
    releaseSha: data.releaseSha,
    closureSha: data.closureSha,
    acceptanceDigest: ACCEPTANCE_DIGEST,
    isAncestor: true,
    changedFiles: ["TASKBOARD.md"],
  };
  assert.match(auditReleaseClosure({ ...base, taskboardText: "# no marker\n" }).join("\n"), /exactly one/);
  assert.match(auditReleaseClosure({ ...base, taskboardText: `${ACCEPTANCE_MARKER}\n${ACCEPTANCE_MARKER}\n` }).join("\n"), /exactly one/);
  assert.match(auditReleaseClosure({ ...base, taskboardText: `<!-- postdeploy-acceptance-sha256:${"e".repeat(64)} -->\n` }).join("\n"), /does not match/);
  assert.match(auditReleaseClosure({ ...base, acceptanceDigest: "short", taskboardText: ACCEPTANCE_MARKER }).join("\n"), /64 lowercase/);

  const mismatched = runCli(data.repo, data.releaseSha, data.closureSha, "e".repeat(64));
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /acceptance digest does not match/);
});

test("the final job manifest binds the closure job to the deployed release input", () => {
  const manifest = JSON.parse(readFileSync(FINAL_JOBS, "utf8"));
  assert.equal(manifest.workflow, "ci");
  assert.equal(manifest.workflow_path, ".github/workflows/ci.yml");
  assert.equal(manifest.workflow_id, 310914082);
  assert.equal(manifest.max_run_age_seconds, 86400);
  assert.equal(manifest.event, "workflow_dispatch");
  assert.equal(manifest.head_branch, "main");
  assert.deepEqual(manifest.tolerated_conclusions, ["success"]);
  assert.deepEqual(manifest.required_jobs.map((job) => job.name), ["Release-final taskboard completion"]);
  assert.match(manifest.required_jobs[0].why, /closure SHA/);
  assert.match(manifest.required_jobs[0].why, /release_sha input/);
  assert.match(manifest.required_jobs[0].why, /acceptance_digest/);
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

test("same-name workflow lookalikes, inactive workflow identity, invalid ordering, and stale CI are refused", () => {
  const closureSha = "c".repeat(40);
  const lookalikePath = finalRunEvidence(closureSha, { run: { path: ".github/workflows/lookalike.yml" } });
  assert.match(auditFinalRequiredRun({ closureSha, runId: FINAL_RUN_ID, ...lookalikePath }).join("\n"), /different workflow path/);

  const lookalikeId = finalRunEvidence(closureSha, { run: { workflow_id: 999 }, workflow: {
    id: 999,
    path: ".github/workflows/ci.yml",
    name: "ci",
    state: "active",
  } });
  const lookalikeProblems = auditFinalRequiredRun({ closureSha, runId: FINAL_RUN_ID, ...lookalikeId }).join("\n");
  assert.match(lookalikeProblems, /different workflow_id/);

  const inactive = finalRunEvidence(closureSha, { workflow: {
    id: 310914082,
    path: ".github/workflows/ci.yml",
    name: "ci",
    state: "disabled_manually",
  } });
  assert.match(auditFinalRequiredRun({ closureSha, runId: FINAL_RUN_ID, ...inactive }).join("\n"), /not active/);

  const unordered = finalRunEvidence(closureSha, { run: {
    created_at: "2026-08-15T12:02:00Z",
    run_started_at: "2026-08-15T12:01:00Z",
    updated_at: "2026-08-15T12:03:00Z",
  } });
  assert.match(auditFinalRequiredRun({ closureSha, runId: FINAL_RUN_ID, now: "2026-08-15T12:04:00Z", ...unordered }).join("\n"), /not ordered/);

  const stale = finalRunEvidence(closureSha, { run: {
    created_at: "2026-08-10T12:00:00Z",
    run_started_at: "2026-08-10T12:01:00Z",
    updated_at: "2026-08-10T12:03:00Z",
  }, jobs: [{
    name: "Release-final taskboard completion",
    started_at: "2026-08-10T12:01:00Z",
    completed_at: "2026-08-10T12:02:00Z",
  }] });
  assert.match(auditFinalRequiredRun({ closureSha, runId: FINAL_RUN_ID, now: "2026-08-15T12:04:00Z", ...stale }).join("\n"), /freshness SLO/);
});

test("CI evidence that had one second remaining is refused after the irreversible-boundary clock passes it", () => {
  const closureSha = "c".repeat(40);
  const evidence = finalRunEvidence(closureSha, {
    run: {
      created_at: "2026-08-15T11:59:58Z",
      run_started_at: "2026-08-15T11:59:59Z",
      updated_at: "2026-08-15T12:00:00Z",
    },
    jobs: [{
      name: "Release-final taskboard completion",
      started_at: "2026-08-15T11:59:59Z",
      completed_at: "2026-08-15T12:00:00Z",
    }],
  });
  evidence.manifest = { ...evidence.manifest, max_run_age_seconds: 2 };
  assert.deepEqual(auditFinalRequiredRun({
    closureSha,
    runId: FINAL_RUN_ID,
    now: "2026-08-15T12:00:01Z",
    ...evidence,
  }), []);
  assert.match(auditFinalRequiredRun({
    closureSha,
    runId: FINAL_RUN_ID,
    now: "2026-08-15T12:00:03Z",
    ...evidence,
  }).join("\n"), /freshness SLO/);
});

test("the oldest required job expires at the boundary even while the run completion remains fresh", () => {
  const closureSha = "c".repeat(40);
  const evidence = finalRunEvidence(closureSha, {
    run: {
      created_at: "2026-08-15T11:59:58Z",
      run_started_at: "2026-08-15T11:59:59Z",
      updated_at: "2026-08-15T12:00:03Z",
    },
    jobs: [{
      name: "Release-final taskboard completion",
      started_at: "2026-08-15T11:59:59Z",
      completed_at: "2026-08-15T12:00:00Z",
    }],
  });
  evidence.manifest = { ...evidence.manifest, max_run_age_seconds: 4 };
  assert.deepEqual(auditFinalRequiredRun({
    closureSha,
    runId: FINAL_RUN_ID,
    now: "2026-08-15T12:00:03Z",
    ...evidence,
  }), []);
  const expired = auditFinalRequiredRun({
    closureSha,
    runId: FINAL_RUN_ID,
    now: "2026-08-15T12:00:05Z",
    ...evidence,
  }).join("\n");
  assert.match(expired, /required final job .* freshness SLO/);
  assert.doesNotMatch(expired, /final run completion is outside/);
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
      "--acceptance-digest", ACCEPTANCE_DIGEST,
      "--repo", data.repo,
      "--run-id", FINAL_RUN_ID,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(partial.status, 64);
  assert.match(partial.stderr, /final run verification requires all five flags/);

  const evidence = finalRunEvidence(data.closureSha);
  const files = writeFinalRunEvidence(data.repo, evidence);
  writeFileSync(files.runJsonFile, "not-json\n");
  const malformed = spawnSync(
    process.execPath,
    [
      CLI,
      "--release-sha", data.releaseSha,
      "--closure-sha", data.closureSha,
      "--acceptance-digest", ACCEPTANCE_DIGEST,
      "--repo", data.repo,
      "--run-id", FINAL_RUN_ID,
      "--run-json-file", files.runJsonFile,
      "--jobs-json-file", files.jobsJsonFile,
      "--workflow-json-file", files.workflowJsonFile,
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
  assert.match(workflow, /\n      acceptance_digest:\n[\s\S]*?type: string/);

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
  assert.match(job, /ACCEPTANCE_DIGEST: \$\{\{ inputs\.acceptance_digest \}\}/);
  assert.match(job, /--acceptance-digest "\$ACCEPTANCE_DIGEST"/);
  assert.match(job, /\[ "\$GITHUB_REF" = "refs\/heads\/main" \]/);
  assert.match(job, /\[ "\$CLOSURE_SHA" = "\$GITHUB_SHA" \]/);
  assert.match(job, /\[ "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA" \]/);
});

test("canonical attestation and digest-only finalization replace freeform UAT self-report", () => {
  const source = readFileSync(CANONICAL_DEPLOY, "utf8").replaceAll("\r\n", "\n");
  const finalizeStart = source.indexOf('if [ "${1:-}" = "finalize" ]; then');
  const finalizeEnd = source.indexOf("\nfi\n\nBOOTSTRAP_ONLY=0", finalizeStart);
  assert.ok(finalizeStart >= 0 && finalizeEnd > finalizeStart);
  const finalize = source.slice(finalizeStart, finalizeEnd);

  assert.match(source, /attest\|attest-recover\|attest-abort/);
  assert.match(source, /verify-postdeploy-acceptance\.mjs/);
  assert.match(source, /record-deploy-acceptance\.mjs/);
  assert.match(source, /status=acceptance_verified/);
  assert.match(finalize, /\[ "\$#" -eq 5 \]/);
  assert.match(finalize, /FINALIZE_ACCEPTANCE_DIGEST=\$\{3:-\}/);
  assert.doesNotMatch(finalize, /UAT_ACTOR|UAT_FIXTURE_IDS|FIXTURE_CLEANUP_STATUS|UAT_STATUS/);
  assert.match(finalize, /verify_release_closure_and_final_ci/);
  assert.ok(finalize.indexOf("verify_release_closure_and_final_ci") < finalize.indexOf("finalize-deploy-evidence.sh"));
  assert.match(finalize, /"\$EVIDENCE_FILE" "\$FINALIZE_ACCEPTANCE_DIGEST" "\$FINALIZE_CLOSURE_SHA" "\$FINALIZE_RUN_ID"/);

  const verifierStart = source.indexOf("verify_release_closure_and_final_ci() (");
  assert.ok(verifierStart >= 0 && verifierStart < finalizeStart);
  const verifier = source.slice(verifierStart, finalizeStart);
  assert.match(verifier, /\[ "\$FINALIZE_CLOSURE_SHA" = "\$main_sha" \]/);
  assert.match(verifier, /\$FINALIZE_CLOSURE_SHA:infra\/release\/final-required-jobs\.json/);
  assert.match(verifier, /actions\/runs\/\$FINALIZE_RUN_ID\/jobs\?per_page=100&filter=latest/);
  assert.match(verifier, /actions\/workflows\/\$CANONICAL_CI_WORKFLOW_ID/);
  assert.match(verifier, /--release-sha "\$FINALIZE_RELEASE_SHA"/);
  assert.match(verifier, /--closure-sha "\$FINALIZE_CLOSURE_SHA"/);
  assert.match(verifier, /--acceptance-digest "\$FINALIZE_ACCEPTANCE_DIGEST"/);
  assert.match(verifier, /--run-id "\$FINALIZE_RUN_ID"/);
  assert.match(verifier, /--workflow-json-file "\$workflow_file"/);
  const finalRevalidations = [...finalize.matchAll(/verify_release_closure_and_final_ci/g)].map((match) => match.index);
  assert.ok(finalRevalidations.length >= 2);
  assert.ok(finalRevalidations.at(-1) < finalize.indexOf("finalize-deploy-evidence.sh", finalRevalidations.at(-1)));
});
