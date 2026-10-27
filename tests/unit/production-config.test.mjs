import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/validate-production-config.py", import.meta.url));
const publishableKey = `sb_publishable_${"a".repeat(40)}`;
const serviceKey = `sb_secret_${"b".repeat(40)}`;
const sentryPublicKey = "d".repeat(32);

function legacyKey(role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role })}.signature`;
}

function fixture({
  site = "https://app.newme.ae",
  duplicate = false,
  publishable = publishableKey,
  service = serviceKey,
  releaseService = null,
  sentryDsn = `https://${sentryPublicKey}@o1.ingest.sentry.io/12345`,
  sentryLine,
  metaPixel = "4476894535908766",
  metaToken = `EAA${"m".repeat(40)}`,
  metaVersion = "v25.0",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "newme-production-config-"));
  const release = join(dir, ".env.local");
  const runtime = join(dir, "newme-runtime.env");
  writeFileSync(release, [
    "NEXT_PUBLIC_SUPABASE_URL=https://vfopmpxlhwzpxqegayew.supabase.co",
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${publishable}`,
    ...(releaseService === null ? [] : [`SUPABASE_SERVICE_ROLE_KEY=${releaseService}`]),
    sentryLine ?? `NEXT_PUBLIC_SENTRY_DSN=${sentryDsn}`,
    "",
  ].join("\n"));
  writeFileSync(runtime, [
    `NEWME_READINESS_TOKEN=${"c".repeat(64)}`,
    `NEXT_PUBLIC_SITE_URL=${site}`,
    ...(metaPixel === null ? [] : [`META_PIXEL_ID=${metaPixel}`]),
    ...(metaToken === null ? [] : [`META_CAPI_ACCESS_TOKEN=${metaToken}`]),
    ...(metaVersion === null ? [] : [`META_GRAPH_API_VERSION=${metaVersion}`]),
    ...(service === null ? [] : [`SUPABASE_SERVICE_ROLE_KEY=${service}`]),
    ...(duplicate ? ["NEXT_PUBLIC_SITE_URL=https://app.newme.ae"] : []),
    "",
  ].join("\n"));
  return { release, runtime };
}

function run(files, extraArgs = []) {
  return spawnSync("python3", [
    script,
    "--release-env",
    files.release,
    "--runtime-env",
    files.runtime,
    ...extraArgs,
  ], {
    encoding: "utf8",
  });
}

test("production config validator accepts only the exact production boundaries", () => {
  const result = run(fixture(), [
    "--require-runtime-service-key",
    "--require-no-release-service-key",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CONFIG_VALIDATION=PASS$/m);
  assert.doesNotMatch(result.stdout, new RegExp(`${publishableKey}|${serviceKey}`));
});

test("production config validator confines bootstrap fallback to non-strict validation", () => {
  const legacyLayout = fixture({ service: null, releaseService: serviceKey });
  const fallback = run(legacyLayout);
  assert.equal(fallback.status, 0, fallback.stderr);

  const strict = run(legacyLayout, ["--require-runtime-service-key"]);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /runtime SUPABASE_SERVICE_ROLE_KEY is missing or malformed/);

  const duplicated = fixture({ releaseService: serviceKey });
  const isolated = run(duplicated, [
    "--require-runtime-service-key",
    "--require-no-release-service-key",
  ]);
  assert.equal(isolated.status, 1);
  assert.match(isolated.stderr, /must be absent/);
  assert.doesNotMatch(
    `${strict.stdout}\n${strict.stderr}\n${isolated.stdout}\n${isolated.stderr}`,
    new RegExp(serviceKey),
  );
});

test("production config validator rejects a wrong site URL and duplicate managed keys", () => {
  for (const files of [fixture({ site: "https://wrong.example" }), fixture({ duplicate: true })]) {
    const result = run(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /production config validation failed/);
    assert.doesNotMatch(result.stderr, new RegExp(`${publishableKey}|${serviceKey}`));
  }
});

test("production config validator requires well-formed Meta CAPI runtime settings", () => {
  for (const files of [
    fixture({ metaPixel: null }),
    fixture({ metaPixel: "not-a-pixel" }),
    fixture({ metaToken: null }),
    fixture({ metaToken: "short" }),
    fixture({ metaVersion: null }),
    fixture({ metaVersion: "latest" }),
  ]) {
    const result = run(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runtime META_(?:PIXEL_ID|CAPI_ACCESS_TOKEN|GRAPH_API_VERSION)/);
  }
});

test("production config validator rejects swapped browser and service credentials", () => {
  for (const files of [
    fixture({ publishable: serviceKey, service: publishableKey }),
    fixture({ publishable: legacyKey("service_role"), service: legacyKey("anon") }),
  ]) {
    const result = run(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not publishable|is not server-only/);
    assert.doesNotMatch(result.stderr, /sb_(?:publishable|secret)_|eyJ/);
  }
});

test("production config validator accepts correctly placed legacy Supabase JWT roles", () => {
  const result = run(fixture({ publishable: legacyKey("anon"), service: legacyKey("service_role") }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CONFIG_VALIDATION=PASS$/m);
});

test("production config validator accepts public and private Sentry DSNs but rejects malformed project keys", () => {
  const privateSecret = "e".repeat(32);
  const privateDsn = `https://${sentryPublicKey}:${privateSecret}@o1.ingest.de.sentry.io/12345`;
  const accepted = run(fixture({ sentryDsn: privateDsn }));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.doesNotMatch(`${accepted.stdout}\n${accepted.stderr}`, new RegExp(privateSecret));

  const quotedExport = run(fixture({
    sentryLine: ` export SENTRY_DSN = '${privateDsn}' `,
  }));
  assert.equal(quotedExport.status, 0, quotedExport.stderr);
  assert.doesNotMatch(`${quotedExport.stdout}\n${quotedExport.stderr}`, new RegExp(privateSecret));

  const malformedSecret = "f".repeat(32);
  for (const sentryDsn of [
    "https://not-a-project-key@o1.ingest.sentry.io/12345",
    `https://${sentryPublicKey}@example.test/12345`,
    `https://${sentryPublicKey}@o1.ingest.sentry.io/not-numeric`,
    `https://${sentryPublicKey}@o1.ingest.sentry.io:443/12345`,
    `https://${sentryPublicKey}@o1.ingest.sentry.io/\u0661\u0662\u0663\u0664\u0665`,
    `https://${sentryPublicKey}:${malformedSecret}@o1.ingest.sentry.io\uFF0F12345`,
  ]) {
    const rejected = run(fixture({ sentryDsn }));
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /release Sentry DSN is missing or malformed/);
    assert.doesNotMatch(
      `${rejected.stdout}\n${rejected.stderr}`,
      new RegExp(`${sentryPublicKey}|${privateSecret}|${malformedSecret}`),
    );
  }
});
