import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const ciUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);
const crmCiUrl = new URL("../../.github/workflows/crm-ci.yml", import.meta.url);
const workflow = await readFile(ciUrl, "utf8");

test("repository CI is manual-only with explicit quick and full validation", () => {
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|workflow_run):/m);
  assert.match(workflow, /validation_level:/);
  assert.match(workflow, /- quick/);
  assert.match(workflow, /- full/);
  assert.match(workflow, /inputs\.validation_level == 'full'/);
});

test("removed crm-ci notifier cannot consume hosted runners or deliver stale alerts", async () => {
  await assert.rejects(access(crmCiUrl), (error) => error?.code === "ENOENT");
  assert.doesNotMatch(workflow, /workflow_run|Notify Telegram|TELEGRAM_/);
});
