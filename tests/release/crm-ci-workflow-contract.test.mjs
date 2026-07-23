import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/crm-ci.yml", import.meta.url), "utf8");

const shouldNotify = ({ eventName, upstreamEvent, branch, conclusion }) =>
  eventName === "workflow_run" &&
  upstreamEvent === "push" &&
  branch === "main" &&
  ["failure", "cancelled"].includes(conclusion);

test("crm-ci scopes workflow_run to main push CI and preserves manual diagnostics", () => {
  assert.match(workflow, /workflow_run:[\s\S]*branches:\s*\n\s+- main/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.doesNotMatch(workflow, /Require upstream ci success/);
});

test("PR and cancelled superseded runs do not enter the main-push notification path", () => {
  assert.equal(shouldNotify({ eventName: "workflow_run", upstreamEvent: "pull_request", branch: "main", conclusion: "failure" }), false);
  assert.equal(shouldNotify({ eventName: "workflow_run", upstreamEvent: "push", branch: "feature/x", conclusion: "cancelled" }), false);
  assert.equal(shouldNotify({ eventName: "workflow_dispatch", upstreamEvent: undefined, branch: undefined, conclusion: undefined }), false);
});

test("main success has no notification or follower failure, main failure has one notification path", () => {
  assert.equal(shouldNotify({ eventName: "workflow_run", upstreamEvent: "push", branch: "main", conclusion: "success" }), false);
  assert.equal((workflow.match(/- name: Notify Telegram/g) || []).length, 1);
  assert.match(workflow, /conclusion == 'failure'/);
  assert.match(workflow, /conclusion == 'cancelled'/);
  assert.match(workflow, /--retry 2 --retry-all-errors/);
  assert.match(workflow, /::error::Telegram notification delivery failed/);
  assert.equal(shouldNotify({ eventName: "workflow_run", upstreamEvent: "push", branch: "main", conclusion: "failure" }), true);
});
