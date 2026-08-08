import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bashPath = (value) => {
  const path = value instanceof URL ? fileURLToPath(value) : String(value);
  if (process.platform !== "win32") return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
};

const transport = bashPath(new URL("../../infra/observability/sentry-cron-checkin.sh", import.meta.url));

function runTransport({ httpCode = 202, credentialDsn, releaseDsn, releaseLine, xtrace = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "newme-sentry-cron-"));
  const bin = join(root, "bin");
  const events = join(root, "curl-events.log");
  mkdirSync(bin);
  writeFileSync(events, "", "utf8");
  const curl = join(bin, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash
printf '%s\\n' '---' >> "$CURL_EVENTS"
if [ "\${SENTRY_DSN+x}" = x ]; then
  printf '%s\\n' 'curl inherited SENTRY_DSN' >&2
  exit 90
fi
printf '%s\\n' "$@" >> "$CURL_EVENTS"
printf '%s' "$FAKE_HTTP_CODE"
`, "utf8");
  chmodSync(curl, 0o755);
  const uuidgen = join(bin, "uuidgen");
  writeFileSync(uuidgen, "#!/usr/bin/env bash\nprintf '11111111-1111-4111-8111-111111111111\\n'\n", "utf8");
  chmodSync(uuidgen, 0o755);

  const credentialFile = join(root, "sentry-dsn");
  if (credentialDsn) writeFileSync(credentialFile, `${credentialDsn}\n`, { encoding: "utf8", mode: 0o600 });
  const envFile = join(root, "release.env");
  if (releaseLine) writeFileSync(envFile, `${releaseLine}\n`, "utf8");
  else if (releaseDsn) writeFileSync(envFile, `SENTRY_DSN=${releaseDsn}\n`, "utf8");

  const result = spawnSync("bash", [
    ...(xtrace ? ["-x"] : []),
    "-c",
    'PATH="$FAKE_BIN:$PATH"; export PATH; source "$1"; sentry_checkin_start newme-health-check && sentry_checkin_finish newme-health-check 0',
    "sentry-cron-fixture",
    transport,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      CURL_EVENTS: bashPath(events),
      FAKE_BIN: bashPath(bin),
      FAKE_HTTP_CODE: String(httpCode),
      SENTRY_DSN: "",
      SENTRY_DSN_FILE: bashPath(credentialFile),
      SENTRY_ENV_FILE: bashPath(envFile),
    },
  });

  return {
    result,
    events: readFileSync(events, "utf8"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("Sentry Cron transport strips a private DSN password and uses the singular ingest endpoint", () => {
  const publicKey = "a".repeat(32);
  const privateSecret = "b".repeat(32);
  const releaseKey = "c".repeat(32);
  const run = runTransport({
    credentialDsn: `https://${publicKey}:${privateSecret}@o123.ingest.de.sentry.io/4511552277512272`,
    releaseDsn: `https://${releaseKey}@o123.ingest.de.sentry.io/4511552277512272`,
  });
  const publicRun = runTransport({
    releaseDsn: `https://${publicKey}@o123.ingest.de.sentry.io/4511552277512272`,
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(publicRun.result.status, 0, publicRun.result.stderr);
    assert.equal((run.events.match(/^---$/gm) || []).length, 2);
    assert.match(
      run.events,
      new RegExp(`https://o123\\.ingest\\.de\\.sentry\\.io/api/4511552277512272/cron/newme-health-check/${publicKey}/`),
    );
    assert.doesNotMatch(run.events, new RegExp(`${publicKey}:${privateSecret}|${privateSecret}|${releaseKey}`));
    assert.doesNotMatch(run.events, /\/crons\//);
    const privateUrls = run.events.match(/https:\/\/[^\s]+/g);
    const publicUrls = publicRun.events.match(/https:\/\/[^\s]+/g);
    assert.deepEqual(privateUrls, publicUrls);
    assert.match(run.events, /"status":"in_progress"/);
    assert.match(run.events, /"status":"ok"/);
    assert.doesNotMatch(
      `${run.events}\n${run.result.stdout}\n${run.result.stderr}`,
      new RegExp(`${privateSecret}|${releaseKey}|curl inherited SENTRY_DSN`),
    );
  } finally {
    run.cleanup();
    publicRun.cleanup();
  }
});

test("Sentry Cron transport fails closed on a non-202 response", () => {
  const run = runTransport({
    httpCode: 404,
    releaseDsn: `https://${"d".repeat(32)}@o123.ingest.sentry.io/4511552277512272`,
  });
  try {
    assert.equal(run.result.status, 1);
    assert.match(run.result.stderr, /sentry check-in delivery failed: HTTP 404/);
    assert.equal((run.events.match(/^---$/gm) || []).length, 1);
  } finally {
    run.cleanup();
  }
});

test("Sentry Cron transport accepts the same quoted export syntax as production validation", () => {
  const publicKey = "f".repeat(32);
  const run = runTransport({
    releaseLine: ` export SENTRY_DSN = 'https://${publicKey}@o123.ingest.sentry.io/4511552277512272' `,
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.events, new RegExp(`/cron/newme-health-check/${publicKey}/`));
  } finally {
    run.cleanup();
  }
});

test("Sentry Cron transport does not expose a private DSN under Bash xtrace", () => {
  const publicKey = "1".repeat(32);
  const privateSecret = "2".repeat(32);
  const run = runTransport({
    credentialDsn: `https://${publicKey}:${privateSecret}@o123.ingest.sentry.io/4511552277512272`,
    xtrace: true,
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.doesNotMatch(
      `${run.events}\n${run.result.stdout}\n${run.result.stderr}`,
      new RegExp(`${privateSecret}|${publicKey}:${privateSecret}`),
    );
  } finally {
    run.cleanup();
  }
});

test("Sentry Cron transport rejects a malformed public key before curl", () => {
  for (const credentialDsn of [
    `https://not-a-project-key:${"e".repeat(32)}@o123.ingest.sentry.io/4511552277512272`,
    `https://${"a".repeat(32)}@o123.ingest.sentry.io:443/4511552277512272`,
  ]) {
    const run = runTransport({ credentialDsn });
    try {
      assert.equal(run.result.status, 1);
      assert.match(run.result.stderr, /sentry check-in DSN is malformed/);
      assert.equal(run.events, "");
    } finally {
      run.cleanup();
    }
  }
});
