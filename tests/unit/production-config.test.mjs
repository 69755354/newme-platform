import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/validate-production-config.py", import.meta.url));
const publishableKey = `anon_${"a".repeat(40)}`;
const serviceKey = `service_${"b".repeat(40)}`;

function fixture({ site = "https://app.newme.ae", duplicate = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "newme-production-config-"));
  const release = join(dir, ".env.local");
  const runtime = join(dir, "newme-runtime.env");
  writeFileSync(release, [
    "NEXT_PUBLIC_SUPABASE_URL=https://vfopmpxlhwzpxqegayew.supabase.co",
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${publishableKey}`,
    `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
    "NEXT_PUBLIC_SENTRY_DSN=https://publickey@o1.ingest.sentry.io/12345",
    "",
  ].join("\n"));
  writeFileSync(runtime, [
    `NEWME_READINESS_TOKEN=${"c".repeat(64)}`,
    `NEXT_PUBLIC_SITE_URL=${site}`,
    ...(duplicate ? ["NEXT_PUBLIC_SITE_URL=https://app.newme.ae"] : []),
    "",
  ].join("\n"));
  return { release, runtime };
}

function run(files) {
  return spawnSync("python3", [script, "--release-env", files.release, "--runtime-env", files.runtime], {
    encoding: "utf8",
  });
}

test("production config validator accepts only the exact production boundaries", () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CONFIG_VALIDATION=PASS$/m);
  assert.doesNotMatch(result.stdout, new RegExp(`${publishableKey}|${serviceKey}`));
});

test("production config validator rejects a wrong site URL and duplicate managed keys", () => {
  for (const files of [fixture({ site: "https://wrong.example" }), fixture({ duplicate: true })]) {
    const result = run(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /production config validation failed/);
    assert.doesNotMatch(result.stderr, new RegExp(`${publishableKey}|${serviceKey}`));
  }
});
