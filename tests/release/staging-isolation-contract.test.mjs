import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const run = promisify(execFile);
const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";

test("standalone output is opt-in and production builds remain unchanged", async () => {
  const config = await read("next.config.ts");
  assert.match(config, /NEWME_STANDALONE_BUILD/);
  assert.match(config, /output:\s*isStandaloneBuild \? "standalone" : undefined/);
  assert.match(config, /NEWME_STAGING_LOW_MEMORY/);
  assert.match(config, /webpackMemoryOptimizations:\s*true/);
});

test("staging refuses unsafe Supabase credentials and target drift", async () => {
  const guard = await read("scripts/check-staging-boundaries.sh");
  for (const token of [
    "NEWME_STAGING_PROJECT_REF",
    "NEWME_STAGING_BOUNDARY_MODE",
    "SUPABASE_PROJECT_REF",
    "NEXT_PUBLIC_SUPABASE_URL",
    "https://staging.newme.ae",
    "sb_secret_",
    "Supabase secret keys are forbidden on external builders",
    "SUPABASE_PAT",
    "SUPABASE_DB_PASSWORD",
    "supabase/.temp/project-ref",
  ]) assert.ok(guard.includes(token), `missing staging boundary: ${token}`);
});

test("external builders cannot receive the staging runtime secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newme-staging-boundary-"));
  const environmentPath = join(directory, "staging.env");
  const publicEnvironment = [
    "SUPABASE_PROJECT_REF=bfsiibofuzoglziltgyd",
    "NEXT_PUBLIC_SUPABASE_URL=https://bfsiibofuzoglziltgyd.supabase.co",
    "NEXT_PUBLIC_SITE_URL=https://staging.newme.ae",
    "",
  ].join("\n");
  const command = fileURLToPath(new URL("scripts/check-staging-boundaries.sh", root));
  const commonEnvironment = {
    ...process.env,
    NEWME_STAGING_PROJECT_REF: "bfsiibofuzoglziltgyd",
    NEWME_STAGING_ENV_FILE: environmentPath,
    SUPABASE_SERVICE_ROLE_KEY: "",
    SUPABASE_PAT: "",
    SUPABASE_DB_PASSWORD: "",
    SENTRY_AUTH_TOKEN: "",
    NEXT_PUBLIC_SENTRY_DSN: "",
    SENTRY_DSN: "",
  };

  try {
    await writeFile(environmentPath, publicEnvironment, "utf8");
    const build = await run(bash, [command], {
      env: { ...commonEnvironment, NEWME_STAGING_BOUNDARY_MODE: "build" },
    });
    assert.match(build.stdout, /staging build boundaries verified/);

    await writeFile(
      environmentPath,
      `${publicEnvironment}SUPABASE_SERVICE_ROLE_KEY=sb_secret_test_only\n`,
      "utf8",
    );
    await assert.rejects(
      run(bash, [command], {
        env: { ...commonEnvironment, NEWME_STAGING_BOUNDARY_MODE: "build" },
      }),
      /Supabase secret keys are forbidden on external builders/,
    );

    const runtime = await run(bash, [command], {
      env: { ...commonEnvironment, NEWME_STAGING_BOUNDARY_MODE: "runtime" },
    });
    assert.match(runtime.stdout, /staging runtime boundaries verified/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("external staging builder emits an immutable standalone artifact without runtime secrets", async () => {
  const build = await read("scripts/build-staging-artifact.sh");
  for (const pattern of [
    /NEWME_STAGING_BOUNDARY_MODE=build/,
    /NEWME_STANDALONE_BUILD=1/,
    /NEWME_STAGING_LOW_MEMORY=1/,
    /NEXT_PUBLIC_APP_VERSION="\$SHA"/,
    /NODE_OPTIONS=.*max_old_space_size=832/,
    /npm ci --no-audit --no-fund/,
    /\. "\$ENV_FILE"/,
    /npm run build -- --webpack/,
    /manifest\.json/,
    /sha256sum "\$ARTIFACT"/,
  ]) assert.match(build, pattern);
  assert.doesNotMatch(build, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(build, /vfopmpxlhwzpxqegayew/);
});

test("staging deploy only verifies prebuilt artifacts and atomically switches", async () => {
  const deploy = await read("scripts/deploy-staging.sh");
  for (const pattern of [
    /00\|01\|02\|03\|04\|05\|18\|19\|20\|21\|22\|23/,
    /flock -n/,
    /refs\/remotes\/origin\/\$BRANCH/,
    /INCOMING="\$ROOT\/incoming"/,
    /sha256sum "\$ARTIFACT"/,
    /artifact contains an unsafe path/,
    /artifact contains links or special files/,
    /release manifest SHA does not match requested SHA/,
    /NEWME_STAGING_BOUNDARY_MODE=runtime/,
    /127\.0\.0\.1:3001\/api\/health/,
    /PORT=3102/,
    /127\.0\.0\.1:3101\/api\/health/,
    /mv -Tf "\$CURRENT_NEXT" "\$CURRENT"/,
    /rollback/,
  ]) assert.match(deploy, pattern);
  assert.doesNotMatch(deploy, /npm ci/);
  assert.doesNotMatch(deploy, /npm run build/);
  assert.doesNotMatch(deploy, /supabase\s+(?:link|db|migration)/);
  assert.doesNotMatch(deploy, /vfopmpxlhwzpxqegayew/);
  assert.doesNotMatch(deploy, /SWitched/);
});

test("staging systemd units enforce separate identity, ports, and resource ceilings", async () => {
  const [runtime, deploy] = await Promise.all([
    read("infra/systemd/newme-staging.service"),
    read("infra/systemd/newme-staging-deploy@.service"),
  ]);
  assert.match(runtime, /^User=newme-staging$/m);
  assert.match(runtime, /^Environment=PORT=3101$/m);
  assert.match(runtime, /^MemoryMax=512M$/m);
  assert.match(runtime, /^MemorySwapMax=0$/m);
  assert.match(runtime, /^CPUQuota=50%$/m);
  assert.match(deploy, /^TimeoutStartSec=15min$/m);
  assert.match(deploy, /^MemoryHigh=384M$/m);
  assert.match(deploy, /^MemoryMax=512M$/m);
  assert.match(deploy, /^MemorySwapMax=0$/m);
  assert.match(deploy, /^CPUQuota=50%$/m);
});
