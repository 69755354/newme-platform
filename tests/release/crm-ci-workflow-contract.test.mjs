import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

test("repository CI remains manual-only to protect hosted-runner quota", () => {
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|workflow_run):/m);
  assert.doesNotMatch(workflow, /Notify Telegram|TELEGRAM_BOT_TOKEN/);
});

test("manual CI preserves quick and full validation levels", () => {
  assert.match(workflow, /validation_level:/);
  assert.match(workflow, /^\s+- quick$/m);
  assert.match(workflow, /^\s+- full$/m);
  assert.match(workflow, /inputs\.validation_level == 'full'/);
});

test("the removed automatic crm-ci workflow does not return", async () => {
  await assert.rejects(
    readFile(new URL("../../.github/workflows/crm-ci.yml", import.meta.url)),
    { code: "ENOENT" },
  );
});
