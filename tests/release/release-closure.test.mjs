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
  CLOSURE_DRIFT_ALLOWED_PATHS,
  auditClosureDrift,
  auditFinalRequiredRun,
  auditReleaseClosure,
  inspectReleaseClosure,
  isClosureDriftAllowedPath,
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

function runCli(repo, releaseSha, closureSha, acceptanceDigest = ACCEPTANCE_DIGEST, finalSha = null) {
  return spawnSync(
    process.execPath,
    [
      CLI,
      "--release-sha", releaseSha,
      "--closure-sha", closureSha,
      "--acceptance-digest", acceptanceDigest,
      "--repo", repo,
      ...(finalSha ? ["--final-sha", finalSha] : []),
    ],
    { encoding: "utf8", windowsHide: true },
  );
}

/**
 * Commits that land on main after the closure record. Each entry becomes one
 * commit on a branch started at `from`; returns the branch head.
 */
function driftChain(repo, from, name, steps) {
  git(repo, "switch", "--quiet", "--create", name, from);
  let head = from;
  for (const [index, files] of steps.entries()) {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      if (contents === null) rmSync(path.join(repo, file));
      else writeFileSync(path.join(repo, file), contents);
    }
    head = commit(repo, `${name} step ${index + 1}`);
  }
  return head;
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

function runFinalCli(repo, releaseSha, closureSha, evidence, runId = FINAL_RUN_ID, finalSha = null) {
  const files = writeFinalRunEvidence(repo, evidence);
  return spawnSync(
    process.execPath,
    [
      CLI,
      "--release-sha", releaseSha,
      "--closure-sha", closureSha,
      "--acceptance-digest", ACCEPTANCE_DIGEST,
      "--repo", repo,
      ...(finalSha ? ["--final-sha", finalSha] : []),
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
  assert.match(cli.stdout, new RegExp(`release=${data.releaseSha} closure=${data.closureSha} final=${data.closureSha}`));
  assert.match(cli.stdout, /changed files \(1\): TASKBOARD\.md/);
  assert.doesNotMatch(cli.stdout, /closure-to-final/);

  // (a) The original single-slot flow, with the final SHA named explicitly as
  // the closure itself, is unchanged.
  const explicit = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, data.closureSha);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, cli.stdout);
});

test("(b) non-runtime commits between the closure record and the final-run SHA are tolerated", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));
  const finalSha = driftChain(data.repo, data.closureSha, "docs-chore", [
    { "docs/runbooks/new.md": "# runbook\n", "docs/old.md": "old\n", ".claude/hooks/pre-commit.sh": "#!/bin/sh\n", "CLAUDE.md": "@AGENTS.md\n" },
    { "crm-v3/SPEC.md": "# spec\n", "README.md": "readme\n", "docs/old.md": null, "docs/arch.excalidraw": "{}\n" },
    { "TASKBOARD.md": `${CLOSURE_BOARD}\n| NEXT-ITEM | TODO | Codex | 2026-08-16 |\n` },
  ]);

  const measured = inspectReleaseClosure({ repo: data.repo, releaseSha: data.releaseSha, closureSha: data.closureSha, finalSha });
  assert.equal(measured.closureIsFinalAncestor, true);
  assert.equal(measured.driftCommitCount, 3);
  assert.deepEqual(measured.driftCommits.map((entry) => entry.parents.length), [1, 1, 1]);
  assert.equal(measured.driftCommits[0].parents[0], data.closureSha);
  assert.equal(measured.driftCommits.at(-1).sha, finalSha);
  assert.deepEqual(auditReleaseClosure({ ...data, finalSha, ...measured }), []);

  const cli = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, finalSha);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`release=${data.releaseSha} closure=${data.closureSha} final=${finalSha}`));
  assert.match(cli.stdout, /closure-to-final non-runtime commits \(3\)/);
  assert.match(cli.stdout, /closure-to-final changed files \(\d+\): .*docs\/runbooks\/new\.md/);

  // Final CI must be bound to the final-run SHA, not to the closure record.
  const atFinal = runFinalCli(data.repo, data.releaseSha, data.closureSha, finalRunEvidence(finalSha), FINAL_RUN_ID, finalSha);
  assert.equal(atFinal.status, 0, atFinal.stderr);
  assert.match(atFinal.stdout, new RegExp(`is green at final-run SHA ${finalSha}`));
  const atClosure = runFinalCli(data.repo, data.releaseSha, data.closureSha, finalRunEvidence(data.closureSha), FINAL_RUN_ID, finalSha);
  assert.equal(atClosure.status, 1);
  assert.match(atClosure.stderr, /final run head_sha is not the final-run SHA/);
});

test("(b) the closure record itself stays strict even when the drift is non-runtime", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));
  // Closure that also changed a source file, followed by a docs-only commit: the
  // tolerant drift rule must not launder the strict single-child rule.
  const finalSha = driftChain(data.repo, data.sourceSha, "docs-after-bad-closure", [{ "docs/x.md": "x\n" }]);
  const cli = runCli(data.repo, data.releaseSha, data.sourceSha, ACCEPTANCE_DIGEST, finalSha);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /the closure commit itself must change exactly TASKBOARD\.md/);

  // A docs commit directly after the release, with the TASKBOARD closure after
  // it, is the wrong order: the record must be the first commit.
  const docsFirst = driftChain(data.repo, data.releaseSha, "docs-first", [
    { "docs/x.md": "x\n" },
    { "TASKBOARD.md": CLOSURE_BOARD },
  ]);
  const wrongOrder = runCli(data.repo, data.releaseSha, docsFirst);
  assert.equal(wrongOrder.status, 1);
  assert.match(wrongOrder.stderr, /single direct child/);
});

test("(c) a runtime path anywhere between the closure record and the final-run SHA is refused by name", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));
  const cases = [
    ["src/app/page.tsx", "src"],
    ["supabase/migrations/20261120000000_x.sql", "supabase"],
    ["scripts/check-release-closure.mjs", "scripts"],
    ["infra/release/final-required-jobs.json", "infra"],
    [".github/workflows/ci.yml", "github"],
    ["tests/release/x.test.mjs", "tests"],
    ["package.json", "package-json"],
    ["package-lock.json", "package-lock"],
    ["public/robots.txt", "public"],
    ["next.config.ts", "next-config"],
    ["crm-v3/ops/sync-metadata.json", "crm-v3-non-spec"],
    ["notes/README.md", "nested-md-outside-docs"],
  ];
  for (const [file, name] of cases) {
    // One harmless docs commit on either side so the offending commit is in the
    // middle of an otherwise acceptable chain.
    const finalSha = driftChain(data.repo, data.closureSha, `runtime-${name}`, [
      { "docs/before.md": "before\n" },
      { [file]: "changed\n" },
      { "docs/after.md": "after\n" },
    ]);
    const measured = inspectReleaseClosure({ repo: data.repo, releaseSha: data.releaseSha, closureSha: data.closureSha, finalSha });
    const problems = auditReleaseClosure({ ...data, finalSha, ...measured }).join("\n");
    assert.match(problems, new RegExp(`closure-to-final commit [0-9a-f]{12} changes paths outside the non-runtime allowlist: ${JSON.stringify(file).replaceAll(".", "\\.")}`), file);
    assert.match(problems, /closure-to-final diff contains paths outside the non-runtime allowlist/);
    const cli = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, finalSha);
    assert.equal(cli.status, 1, file);
    assert.match(cli.stderr, new RegExp(JSON.stringify(file).replaceAll(".", "\\.")));
  }

  // A rename out of a runtime path shows up as a delete of that path and is refused.
  const renamed = driftChain(data.repo, data.closureSha, "rename-src", [
    { "src/moved.ts": "export const moved = true;\n" },
  ]);
  const movedAway = driftChain(data.repo, renamed, "rename-src-away", [
    { "src/moved.ts": null, "docs/moved.ts": "export const moved = true;\n" },
  ]);
  const rename = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, movedAway);
  assert.equal(rename.status, 1);
  assert.match(rename.stderr, /"src\/moved\.ts"/);
});

test("(d) merge commits, non-descendants, a final SHA before the closure, and an erased marker are refused", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));

  // Merge of a docs-only branch into a docs-only chain: still refused, because
  // the chain must be linear.
  const left = driftChain(data.repo, data.closureSha, "merge-left", [{ "docs/left.md": "left\n" }]);
  driftChain(data.repo, data.closureSha, "merge-right", [{ "docs/right.md": "right\n" }]);
  git(data.repo, "switch", "--quiet", "merge-left");
  git(data.repo, "merge", "--quiet", "--no-ff", "--no-edit", "merge-right");
  const mergeSha = git(data.repo, "rev-parse", "HEAD");
  const merged = inspectReleaseClosure({ repo: data.repo, releaseSha: data.releaseSha, closureSha: data.closureSha, finalSha: mergeSha });
  const mergeProblems = auditReleaseClosure({ ...data, finalSha: mergeSha, ...merged }).join("\n");
  assert.match(mergeProblems, /is a merge or root commit \(2 parents\)/);
  const mergeCli = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, mergeSha);
  assert.equal(mergeCli.status, 1);
  assert.match(mergeCli.stderr, /merge or root commit/);
  assert.notEqual(left, mergeSha);

  // A docs-only commit on a sibling branch of the closure does not descend from it.
  const sibling = driftChain(data.repo, data.releaseSha, "sibling-docs", [{ "docs/sibling.md": "s\n" }]);
  const siblingCli = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, sibling);
  assert.equal(siblingCli.status, 1);
  assert.match(siblingCli.stderr, /closure SHA is not an ancestor of final SHA/);

  // The release SHA itself, and a SHA that does not exist, cannot be the final run.
  const atRelease = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, data.releaseSha);
  assert.equal(atRelease.status, 1);
  assert.match(atRelease.stderr, /final SHA must not be the release SHA/);
  const absent = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, "f".repeat(40));
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /final SHA is not an existing commit/);
  const malformed = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, "F".repeat(40));
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /final SHA must be exactly 40 lowercase hexadecimal characters/);

  // A later TASKBOARD edit that removes or duplicates the closure's marker is refused.
  const erased = driftChain(data.repo, data.closureSha, "erase-marker", [
    { "TASKBOARD.md": CLOSURE_BOARD.replace(`\n${ACCEPTANCE_MARKER}\n`, "\n") },
  ]);
  const erasedCli = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, erased);
  assert.equal(erasedCli.status, 1);
  assert.match(erasedCli.stderr, /must still carry the closure acceptance marker exactly once \(found 0\)/);
  const duplicated = driftChain(data.repo, data.closureSha, "duplicate-marker", [
    { "TASKBOARD.md": `${CLOSURE_BOARD}\n${ACCEPTANCE_MARKER}\n` },
  ]);
  const duplicatedCli = runCli(data.repo, data.releaseSha, data.closureSha, ACCEPTANCE_DIGEST, duplicated);
  assert.equal(duplicatedCli.status, 1);
  assert.match(duplicatedCli.stderr, /exactly once \(found 2\)/);
});

test("a release shipped with the pre-final-sha checker is still closable under the single-slot flow", (t) => {
  // 527c9753 is the last main commit before --final-sha existed. The coordinator
  // runs the DEPLOYED release's checker, so the exact invocation it makes for a
  // final SHA equal to the closure SHA must be one that checker accepts.
  const legacy = spawnSync("git", ["-C", ROOT, "show", "527c9753:scripts/check-release-closure.mjs"], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (legacy.status !== 0) {
    t.skip("history before the final-run SHA is not available in this checkout");
    return;
  }
  const data = fixture();
  t.after(() => rmSync(data.repo, { recursive: true, force: true }));
  const legacyCli = path.join(data.repo, "legacy-check-release-closure.mjs");
  writeFileSync(legacyCli, legacy.stdout);
  const run = (...extra) => spawnSync(
    process.execPath,
    [legacyCli, "--release-sha", data.releaseSha, "--closure-sha", data.closureSha, "--acceptance-digest", ACCEPTANCE_DIGEST, "--repo", data.repo, ...extra],
    { encoding: "utf8", windowsHide: true },
  );
  const withoutFlag = run();
  assert.equal(withoutFlag.status, 0, withoutFlag.stderr);
  const withFlag = run("--final-sha", data.closureSha);
  assert.equal(withFlag.status, 64, "the legacy checker rejects the flag outright, which is why the coordinator omits it when final == closure");
  assert.match(withFlag.stderr, /unknown argument "--final-sha"/);
});

test("the drift allowlist is closed: denylist first, root markdown only, no traversal", () => {
  assert.deepEqual([...CLOSURE_DRIFT_ALLOWED_PATHS], [
    "TASKBOARD.md",
    "*.md (repository root only)",
    "docs/**",
    ".claude/**",
    "crm-v3/SPEC.md",
  ]);
  for (const allowed of ["TASKBOARD.md", "CLAUDE.md", "AGENTS.md", "README.md", "docs/a.md", "docs/deep/b.svg", ".claude/settings.json", ".claude/hooks/x.sh", "crm-v3/SPEC.md"]) {
    assert.equal(isClosureDriftAllowedPath(allowed), true, allowed);
  }
  for (const denied of [
    "", "/docs/a.md", "docs/", "docs", ".claude", "docs/../src/a.ts", "./README.md", "docs/./a.md",
    "src/a.md", "supabase/README.md", "scripts/README.md", "infra/README.md", ".github/README.md",
    "tests/README.md", "public/a.md", "node_modules/x/README.md", "package.json", "package-lock.json",
    "next.config.ts", "tsconfig.json", "crm-v3/README.md", "crm-v3/ops/sync-metadata.json", "nested/x.md",
    "TASKBOARD.md.bak", "docs\\a.md", 42, null, undefined,
  ]) {
    assert.equal(isClosureDriftAllowedPath(denied), false, String(denied));
  }
});

test("an unmeasured or inconsistent closure-to-final claim is refused", () => {
  const closureSha = "b".repeat(40);
  const finalSha = "c".repeat(40);
  const base = { closureSha, finalSha, acceptanceDigest: ACCEPTANCE_DIGEST };
  const unmeasured = auditClosureDrift(base).join("\n");
  assert.match(unmeasured, /ancestry was not measured/);
  assert.match(unmeasured, /commit chain was not measured/);

  const good = {
    ...base,
    closureIsFinalAncestor: true,
    driftCommitCount: 1,
    driftCommits: [{ sha: finalSha, parents: [closureSha], changedFiles: ["docs/a.md"] }],
    driftChangedFiles: ["docs/a.md"],
    finalTaskboardText: `${CLOSURE_BOARD}`,
  };
  assert.deepEqual(auditClosureDrift(good), []);
  assert.deepEqual(auditClosureDrift({ ...good, finalSha: closureSha }), [], "final equal to closure is the original rule");
  assert.match(auditClosureDrift({ ...good, driftCommitCount: 2 }).join("\n"), /commit count does not match/);
  assert.match(auditClosureDrift({ ...good, driftCommits: [] }).join("\n"), /range is empty/);
  assert.match(auditClosureDrift({ ...good, driftCommits: [{ sha: finalSha, parents: ["e".repeat(40)], changedFiles: [] }] }).join("\n"), /does not continue the linear chain/);
  assert.match(auditClosureDrift({ ...good, driftCommits: [{ sha: "e".repeat(40), parents: [closureSha], changedFiles: [] }] }).join("\n"), /does not end at the final SHA/);
  assert.match(auditClosureDrift({ ...good, driftCommits: [{ sha: finalSha, parents: [closureSha] }] }).join("\n"), /inventory was not measured/);
  assert.match(auditClosureDrift({ ...good, driftChangedFiles: undefined }).join("\n"), /changed files were not measured/);
  assert.match(auditClosureDrift({ ...good, finalTaskboardText: undefined }).join("\n"), /TASKBOARD\.md content was not measured/);
  assert.match(auditClosureDrift({ ...good, closureIsFinalAncestor: false }).join("\n"), /not an ancestor of final/);
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

test("a release carrying an earlier closure's marker can still be closed by appending one new marker", () => {
  const priorMarker = `<!-- postdeploy-acceptance-sha256:${"c".repeat(64)} -->`;
  const releaseBoard = `${RELEASE_BOARD}\n${priorMarker}\n`;
  const closureBoard = `${CLOSURE_BOARD.replace(`\n${ACCEPTANCE_MARKER}\n`, "")}\n${priorMarker}\n\n${ACCEPTANCE_MARKER}\n`;
  const base = {
    releaseSha: "a".repeat(40),
    closureSha: "b".repeat(40),
    acceptanceDigest: ACCEPTANCE_DIGEST,
    isAncestor: true,
    directParent: "a".repeat(40),
    commitCount: 1,
    perCommitChangedFiles: [["TASKBOARD.md"]],
    changedFiles: ["TASKBOARD.md"],
    releaseTaskboardText: releaseBoard,
  };
  assert.deepEqual(auditReleaseClosure({ ...base, taskboardText: closureBoard }), []);

  const nothingAdded = closureBoard.replace(`\n${ACCEPTANCE_MARKER}\n`, "\n");
  assert.match(auditReleaseClosure({ ...base, taskboardText: nothingAdded }).join("\n"), /add exactly one/);

  const twoAdded = `${closureBoard}\n${ACCEPTANCE_MARKER}\n`;
  assert.match(auditReleaseClosure({ ...base, taskboardText: twoAdded }).join("\n"), /add exactly one/);

  const reused = `${closureBoard.replace(`\n${ACCEPTANCE_MARKER}\n`, "\n")}\n${priorMarker}\n`;
  const reusedProblems = auditReleaseClosure({ ...base, acceptanceDigest: "c".repeat(64), taskboardText: reused }).join("\n");
  assert.match(reusedProblems, /reuses an acceptance digest/);
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
  assert.match(manifest.required_jobs[0].why, /final-run SHA/);
  assert.match(manifest.required_jobs[0].why, /non-runtime-only descendant/);
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
  assert.match(cli.stdout, new RegExp(`final CI run ${FINAL_RUN_ID} is green at final-run SHA ${data.closureSha}`));
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
  assert.match(problems.join("\n"), /final run head_sha is not the final-run SHA/);
  assert.match(problems.join("\n"), /ran against a different commit/);

  const cli = runFinalCli(data.repo, data.releaseSha, data.closureSha, evidence);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /final run head_sha is not the final-run SHA/);
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
  assert.match(workflow, /\n      final_sha:\n[\s\S]*?default: ''\n[\s\S]*?type: string/);
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
  assert.match(job, /FINAL_SHA: \$\{\{ inputs\.final_sha \}\}/);
  assert.match(job, /ACCEPTANCE_DIGEST: \$\{\{ inputs\.acceptance_digest \}\}/);
  assert.match(job, /--closure-sha "\$CLOSURE_SHA"/);
  assert.match(job, /--final-sha "\$FINAL_SHA"/);
  assert.match(job, /--acceptance-digest "\$ACCEPTANCE_DIGEST"/);
  assert.match(job, /\[ "\$GITHUB_REF" = "refs\/heads\/main" \]/);
  // The final-run SHA defaults to the closure SHA, must be a full SHA, and must be
  // the exact workflow SHA: the closure record is never required to be main head.
  assert.match(job, /FINAL_SHA="\$\{FINAL_SHA:-\$CLOSURE_SHA\}"/);
  assert.match(job, /\[\[ "\$FINAL_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(job, /\[ "\$FINAL_SHA" = "\$GITHUB_SHA" \]/);
  assert.doesNotMatch(job, /\[ "\$CLOSURE_SHA" = "\$GITHUB_SHA" \]/);
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
  assert.match(finalize, /\[ "\$#" -eq 5 \] \|\| \[ "\$#" -eq 6 \]/);
  assert.match(finalize, /FINALIZE_ACCEPTANCE_DIGEST=\$\{3:-\}/);
  assert.match(finalize, /FINALIZE_FINAL_SHA=\$\{6:-\$FINALIZE_CLOSURE_SHA\}/);
  assert.match(finalize, /! \[\[ "\$FINALIZE_FINAL_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.doesNotMatch(finalize, /UAT_ACTOR|UAT_FIXTURE_IDS|FIXTURE_CLEANUP_STATUS|UAT_STATUS/);
  assert.match(finalize, /verify_release_closure_and_final_ci/);
  assert.ok(finalize.indexOf("verify_release_closure_and_final_ci") < finalize.indexOf("finalize-deploy-evidence.sh"));
  assert.match(finalize, /"\$EVIDENCE_FILE" "\$FINALIZE_ACCEPTANCE_DIGEST" "\$FINALIZE_CLOSURE_SHA" "\$FINALIZE_RUN_ID" "\$\{FINALIZE_EVIDENCE_FINAL_ARGS\[@\]\}"/);
  assert.match(finalize, /mapfile -t FINALIZE_EVIDENCE_FINAL_ARGS < <\(finalize_final_sha_evidence_args\)/);

  const verifierStart = source.indexOf("verify_release_closure_and_final_ci() (");
  assert.ok(verifierStart >= 0 && verifierStart < finalizeStart);
  const verifier = source.slice(verifierStart, finalizeStart);
  assert.match(verifier, /\[ "\$FINALIZE_FINAL_SHA" = "\$main_sha" \]/);
  assert.doesNotMatch(verifier, /\[ "\$FINALIZE_CLOSURE_SHA" = "\$main_sha" \]/);
  assert.match(verifier, /\$FINALIZE_CLOSURE_SHA:infra\/release\/final-required-jobs\.json/);
  assert.match(verifier, /actions\/runs\/\$FINALIZE_RUN_ID\/jobs\?per_page=100&filter=latest/);
  assert.match(verifier, /actions\/workflows\/\$CANONICAL_CI_WORKFLOW_ID/);
  assert.match(verifier, /--release-sha "\$FINALIZE_RELEASE_SHA"/);
  assert.match(verifier, /--closure-sha "\$FINALIZE_CLOSURE_SHA"/);
  assert.match(verifier, /mapfile -t final_sha_args < <\(finalize_final_sha_checker_args\)/);
  assert.equal(verifier.split('"${final_sha_args[@]}"').length - 1, 2, "both checker invocations bind the final-run SHA only when it differs from the closure");
  assert.doesNotMatch(verifier, /--final-sha "\$FINALIZE_FINAL_SHA"/);
  assert.match(verifier, /--acceptance-digest "\$FINALIZE_ACCEPTANCE_DIGEST"/);
  assert.match(verifier, /--run-id "\$FINALIZE_RUN_ID"/);
  assert.match(verifier, /--workflow-json-file "\$workflow_file"/);
  const finalRevalidations = [...finalize.matchAll(/verify_release_closure_and_final_ci/g)].map((match) => match.index);
  assert.ok(finalRevalidations.length >= 2);
  assert.ok(finalRevalidations.at(-1) < finalize.indexOf("finalize-deploy-evidence.sh", finalRevalidations.at(-1)));
});
