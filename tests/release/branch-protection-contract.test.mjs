// ============================================================================
// Contract test for the applied main-branch protection (round-3 P1-13)
// ============================================================================
// P1-13 originally observed no required status checks or reviews. The rule was
// applied and read back on 2026-08-15. This file keeps the intended fields, the
// recorded readback, and the workflow topology mutually consistent.
//
// This file is that guarantee:
//
//   * every required context is a job that exists in ci.yml AND can run on a
//     pull_request. A context that never reports blocks every merge forever,
//     which is how a protection rule gets turned back off again.
//   * the dispatch-only taskboard job is NOT required here, and IS required by
//     the deploy manifest. Getting that backwards either deadlocks pull requests
//     or lets an incomplete taskboard reach production.
//   * `test-ci`'s echo-only job is excluded by name, with a reason. The review is
//     explicit that it must not be used as evidence.
//   * nothing in the repository writes branch protection.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const PROTECTION = JSON.parse(read("infra/release/branch-protection.json"));
const DEPLOY_MANIFEST = JSON.parse(read("infra/release/required-jobs.json"));
const CI = read(".github/workflows/ci.yml");

/**
 * Job name -> its `if:` condition (empty string when unconditional), read from
 * ci.yml as text. A YAML parse would be tidier; the indentation walk is here
 * because tests/release/deploy-release-claim-validation.test.mjs already reads
 * the file this way and the two must agree about what a job is.
 */
function ciJobs() {
  const lines = CI.split(/\r?\n/);
  const jobs = new Map();
  lines.forEach((line, index) => {
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (!name || !/^ {2}\S+:\s*$/.test(lines[index - 1] ?? "")) return;
    let condition = "";
    for (let i = index + 1; i < lines.length; i += 1) {
      if (/^ {2}\S/.test(lines[i])) break;
      const match = /^\s{4}if:\s*(.*)$/.exec(lines[i]);
      if (match) condition = match[1];
    }
    jobs.set(name[1], condition);
  });
  return jobs;
}

const JOBS = ciJobs();

test("ci.yml still triggers on pull_request, or none of this means anything", () => {
  assert.match(CI, /^on:\s*$/m);
  assert.match(CI, /^ {2}pull_request:\s*$/m);
  assert.ok(JOBS.size >= 5, `expected ci.yml to define at least 5 named jobs, found ${JOBS.size}`);
});

test("the rule is declared for main, with the fields that make it real", () => {
  assert.equal(PROTECTION.branch, "main");
  const p = PROTECTION.protection;
  assert.equal(p.required_status_checks.strict, true, "stale branches must not satisfy the checks");
  assert.equal(p.enforce_admins, true, "a rule admins can walk past is not a rule");
  assert.equal(p.allow_force_pushes, false);
  assert.equal(p.allow_deletions, false);
  assert.ok(
    p.required_pull_request_reviews.required_approving_review_count >= 1,
    "P1-13 names missing required reviews as part of the finding",
  );
});

test("every required context is a ci.yml job that a pull request can actually run", () => {
  const contexts = PROTECTION.protection.required_status_checks.contexts;
  assert.ok(contexts.length >= 4, `expected the substantive gates to be required, saw ${contexts.length}`);
  assert.equal(new Set(contexts).size, contexts.length, "duplicate contexts");

  for (const context of contexts) {
    assert.ok(JOBS.has(context), `no job in ci.yml is named "${context}"`);
    const condition = JOBS.get(context);
    if (condition) {
      assert.match(
        condition,
        /pull_request/,
        `"${context}" is gated on ${condition}, so it can never report on a pull request and would block every merge`,
      );
    }
  }
});

test("predeploy and release-final taskboard jobs are distinct boundaries", () => {
  const contexts = PROTECTION.protection.required_status_checks.contexts;
  const finalJob = "Release-final taskboard completion";
  const predeployJob = "Predeploy taskboard readiness";

  assert.match(
    JOBS.get(finalJob) ?? "",
    /workflow_dispatch/,
    "the release-final taskboard job must stay dispatch-gated",
  );
  assert.ok(!contexts.includes(finalJob), "a dispatch-only final job as a required context deadlocks pull requests");
  assert.ok(
    !DEPLOY_MANIFEST.required_jobs.some((job) => job.name === finalJob),
    "postdeploy completion cannot gate the deployment that creates its evidence",
  );
  assert.ok(
    DEPLOY_MANIFEST.required_jobs.some((job) => job.name === predeployJob),
    "the deploy manifest must require the predeploy taskboard milestone",
  );

  // And the other direction: everything required of a pull request is also
  // required of the release-final run the deploy wrapper measures.
  const deployNames = new Set(DEPLOY_MANIFEST.required_jobs.map((job) => job.name));
  for (const context of contexts) {
    assert.ok(deployNames.has(context), `${context} gates pull requests but not the deployment`);
  }
});

test("the echo-only test-ci job is excluded by name, with a reason", () => {
  const contexts = PROTECTION.protection.required_status_checks.contexts;
  const excluded = new Map(PROTECTION.not_required.map((entry) => [entry.context, entry]));

  const testCi = read(".github/workflows/test-ci.yml");
  assert.match(testCi, /run:\s*echo ok/, "test-ci is still the echo-only workflow this exclusion is about");

  assert.ok(!contexts.some((c) => /test-ci|^test$/.test(c)), "the echo-only check must not be a required context");
  const entry = excluded.get("test");
  assert.ok(entry, "test-ci's job must be named in not_required rather than silently omitted");
  assert.equal(entry.workflow, ".github/workflows/test-ci.yml");
  assert.ok(entry.why.join(" ").length > 80, "an exclusion without a reason is an oversight with a name");

  for (const name of DEPLOY_MANIFEST.required_jobs.map((job) => job.name)) {
    assert.notEqual(name, "test", "the deploy manifest must not require the echo-only job either");
  }
});

test("crm-ci is excluded because workflow_run cannot report on a pull request head", () => {
  const crm = read(".github/workflows/crm-ci.yml");
  assert.match(crm, /workflow_run:/);
  const excluded = PROTECTION.not_required.find((entry) => entry.workflow === ".github/workflows/crm-ci.yml");
  assert.ok(excluded, "crm-ci's job must be accounted for");
  assert.match(excluded.why.join(" "), /workflow_run|default branch/);
});

test("nothing in the repository silently auto-applies the protection", () => {
  assert.match(PROTECTION._comment.join(" "), /NOT AUTO-APPLIED BY ANYTHING IN THIS REPOSITORY/);
  assert.match(PROTECTION.authorization, /repository-admin control-plane operation/i);

  const writes = [];
  const skip = new Set(["node_modules", ".git", ".next", "coverage", "dist", "build", "playwright-report"]);
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(mjs|js|ts|sh|yml|yaml)$/.test(entry)) continue;
      if (full === import.meta.filename) continue; // this scanner quotes the pattern it looks for
      const text = readFileSync(full, "utf8");
      // A write is `gh api -X PUT/PATCH/DELETE .../branches/<x>/protection` or the
      // same URL through a REST client. Reading it back is allowed and expected.
      if (/branches\/[^\s"'`]*\/protection/.test(text)
          && /(-X|--method)\s*(PUT|PATCH|POST|DELETE)|method:\s*['"](PUT|PATCH|POST|DELETE)/i.test(text)) {
        writes.push(path.relative(ROOT, full));
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(writes, [], `these files would mutate branch protection: ${writes.join(", ")}`);
});

test("the recorded live readback exposes the exact CodeQL protection blocker", () => {
  const declared = PROTECTION.protection;
  const live = PROTECTION.live_readback;

  assert.equal(live.verified_on, "2026-08-15");
  assert.match(live.endpoint, /branches\/main\/protection$/);
  assert.equal(live.status, "blocked_pending_codeql_analysis_and_protection");
  assert.deepEqual(live.missing_required_contexts, ["CodeQL analysis"]);
  assert.deepEqual(
    declared.required_status_checks.contexts.filter(
      (context) => !live.required_status_checks.contexts.includes(context),
    ),
    live.missing_required_contexts,
  );
  assert.deepEqual(
    live.required_status_checks.contexts.filter(
      (context) => !declared.required_status_checks.contexts.includes(context),
    ),
    [],
  );
  assert.equal(live.required_status_checks.strict, declared.required_status_checks.strict);
  assert.equal(live.enforce_admins, declared.enforce_admins);
  assert.equal(live.required_linear_history, declared.required_linear_history);
  assert.equal(live.required_conversation_resolution, declared.required_conversation_resolution);
  assert.equal(live.allow_force_pushes, declared.allow_force_pushes);
  assert.equal(live.allow_deletions, declared.allow_deletions);
  assert.equal(
    live.required_pull_request_reviews.required_approving_review_count,
    declared.required_pull_request_reviews.required_approving_review_count,
  );
  assert.equal(live.required_pull_request_reviews.dismiss_stale_reviews, true);
  assert.equal(live.required_pull_request_reviews.require_last_push_approval, true);

  assert.match(PROTECTION.verification.join(" "), /branches\/\{owner\}|branches\/main\/protection|\/protection/);
  assert.match(PROTECTION.verification.join(" "), /blocks the release/);
});
