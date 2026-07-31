import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("SAM-52 versioned staging runner is synthetic, SHA-bound, and external-NO-GO explicit", async () => {
  const [runner, controller, readme] = await Promise.all([
    read("scripts/verify-staging-sam52-alert-bridge.mjs"),
    read("scripts/newme-staging-control.sh"),
    read("infra/staging/uat-runner/README.md"),
  ]);
  for (const pattern of [
    /SAM52_EXPECTED_RELEASE_SHA/,
    /\/opt\/newme-staging\/current\/manifest\.json/,
    /manifest\.git_sha !== expectedSha/,
    /invalidSignatureRejected/,
    /invalidSchemaRejected/,
    /duplicate\.duplicate === true/,
    /first\.attempts === 3/,
    /auditRedacted/,
    /third_party_configuration_not_authorized/,
    /sentry_alert_rule_owner/,
    /sentry_service_hook_secret/,
    /hermes_destination_owner/,
    /wecom_or_telegram_credentials/,
    /synthetic_in_memory_transport_and_replay_store/,
  ]) assert.match(runner, pattern);
  assert.doesNotMatch(runner, /fetch\(/);
  assert.doesNotMatch(runner, /process\.env\.(?:SENTRY|HERMES|WECHAT|TELEGRAM)/);

  for (const pattern of [
    /SAM52_RUNNER="scripts\/verify-staging-sam52-alert-bridge\.mjs"/,
    /SAM52_BRIDGE="src\/lib\/sentry-webhook-bridge\.mjs"/,
    /runner="\$run_dir\/scripts\/verify-staging-sam52-alert-bridge\.mjs"/,
    /bridge="\$run_dir\/src\/lib\/sentry-webhook-bridge\.mjs"/,
    /install -d -m 0700 -o root -g root "\$run_dir\/scripts" "\$run_dir\/src\/lib"/,
    /copy_commit_blob "\$SHA" "\$SAM52_RUNNER"/,
    /copy_commit_blob "\$SHA" "\$SAM52_BRIDGE"/,
    /SAM52_EXPECTED_RELEASE_SHA="\$SHA"/,
    /body\.linearId !== "SAM-52"/,
    /body\.releaseSha !== process\.argv\[2\]/,
    /body\.bridge\?\.signature !== "verified"/,
    /body\.bridge\?\.schema !== "strict"/,
    /body\.bridge\?\.replay !== "deduplicated"/,
    /body\.bridge\?\.retryAttempts !== 3/,
    /body\.bridge\?\.audit !== "redacted"/,
    /body\.external\?\.status !== "blocked"/,
    /body\.external\?\.reason !== "third_party_configuration_not_authorized"/,
    /body\.cleanup\?\.status !== "not_applicable"/,
    /SAM52_EVIDENCE="\$STATE_DIR\/last-uat-sam52\.json"/,
    /chmod 0600 "\$output"/,
    /mv -f "\$output" "\$SAM52_EVIDENCE"/,
  ]) assert.match(controller, pattern);
  assert.match(readme, /uat-sam52 <SHA>/);
  assert.doesNotMatch(controller, /cat "\$output"/);
});
