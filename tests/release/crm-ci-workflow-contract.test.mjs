import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/crm-ci.yml", import.meta.url), "utf8");

const shouldNotify = ({ eventName, upstreamEvent, branch, conclusion }) =>
  eventName === "workflow_run" &&
  upstreamEvent === "push" &&
  branch === "main" &&
  ["failure", "cancelled"].includes(conclusion);

const shouldFailForUpstream = ({ eventName, conclusion }) =>
  eventName === "workflow_run" && conclusion !== "success";

test("crm-ci scopes workflow_run to main push CI and preserves manual diagnostics", () => {
  assert.match(workflow, /workflow_run/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /- name: Require upstream ci success/);
});

test("PR and non-main cancelled runs do not enter the main-push notification path", () => {
  assert.equal(shouldNotify({ eventName: "workflow_run", upstreamEvent: "pull_request", branch: "main", conclusion: "failure" }), false);
  assert.equal(shouldNotify({ eventName: "workflow_run", upstreamEvent: "push", branch: "feature/x", conclusion: "cancelled" }), false);
  assert.equal(shouldNotify({ eventName: "workflow_dispatch", upstreamEvent: undefined, branch: undefined, conclusion: undefined }), false);
});

test("main success stays quiet; main failure or cancellation notifies, and a failed delivery is fatal", () => {
  assert.equal(shouldNotify({ eventName: "workflow_run", upstreamEvent: "push", branch: "main", conclusion: "success" }), false);
  assert.equal((workflow.match(/- name: Notify Telegram/g) || []).length, 1);
  assert.match(workflow, /conclusion == 'failure'/);
  assert.match(workflow, /conclusion == 'cancelled'/);
  // The reviewed revision had continue-on-error: true here and this test
  // asserted it, which made the step's own `exit 1` unreachable as a job result.
  // An alerting path that cannot deliver is an outage, not a warning, so a
  // non-2xx Telegram response now fails the job.
  // Anchored to the YAML key: the comment above records the removed setting and
  // must not be what satisfies the assertion.
  assert.doesNotMatch(workflow, /^\s*continue-on-error\s*:/m);
  assert.match(workflow, /curl --fail-with-body --silent --show-error/);
  const notifyStep = workflow.slice(workflow.indexOf("      - name: Notify Telegram"));
  const notifyRun = notifyStep.slice(notifyStep.indexOf("        run: |"));
  assert.match(notifyStep, /UPSTREAM_MESSAGE:\s*\$\{\{ github\.event\.workflow_run\.head_commit\.message \}\}/);
  assert.doesNotMatch(notifyRun, /\$\{\{ github\.event\.workflow_run\.head_commit\.message \}\}/);
  assert.doesNotMatch(workflow, /--retry/);
  assert.match(workflow, /::error::Telegram notification delivery failed/);
  assert.equal(shouldNotify({ eventName: "workflow_run", upstreamEvent: "push", branch: "main", conclusion: "failure" }), true);
  assert.equal(shouldNotify({ eventName: "workflow_run", upstreamEvent: "push", branch: "main", conclusion: "cancelled" }), true);
});

test("every non-success upstream conclusion fails after the notification attempt", () => {
  const notifyIndex = workflow.indexOf("      - name: Notify Telegram");
  const verdictIndex = workflow.indexOf("      - name: Require upstream ci success");
  assert.ok(notifyIndex >= 0 && verdictIndex > notifyIndex);
  const verdictStep = workflow.slice(verdictIndex);
  assert.match(verdictStep, /\$\{\{ always\(\) &&/);
  assert.match(verdictStep, /github\.event_name == 'workflow_run'/);
  assert.match(verdictStep, /github\.event\.workflow_run\.conclusion != 'success'/);
  assert.match(verdictStep, /exit 1/);
  assert.doesNotMatch(verdictStep, /^\s*continue-on-error\s*:/m);

  assert.equal(shouldFailForUpstream({ eventName: "workflow_run", conclusion: "success" }), false);
  assert.equal(shouldFailForUpstream({ eventName: "workflow_dispatch", conclusion: undefined }), false);
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "skipped",
    "neutral",
    "action_required",
    "stale",
    "startup_failure",
  ]) {
    assert.equal(shouldFailForUpstream({ eventName: "workflow_run", conclusion }), true, conclusion);
  }
});
