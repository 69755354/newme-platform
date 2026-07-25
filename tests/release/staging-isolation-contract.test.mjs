import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("standalone output is opt-in and production builds remain unchanged", async () => {
  const config = await read("next.config.ts");
  assert.match(config, /NEWME_STANDALONE_BUILD/);
  assert.match(config, /output:\s*isStandaloneBuild \? "standalone" : undefined/);
});

test("staging refuses unsafe Supabase credentials and target drift", async () => {
  const guard = await read("scripts/check-staging-boundaries.sh");
  for (const token of [
    "NEWME_STAGING_PROJECT_REF",
    "SUPABASE_PROJECT_REF",
    "NEXT_PUBLIC_SUPABASE_URL",
    "https://staging.newme.ae",
    "sb_secret_",
    "SUPABASE_PAT",
    "SUPABASE_DB_PASSWORD",
    "supabase/.temp/project-ref",
  ]) assert.ok(guard.includes(token), `missing staging boundary: ${token}`);
});

test("staging deploy is isolated, low-peak, canonical, and production-aware", async () => {
  const deploy = await read("scripts/deploy-staging.sh");
  for (const pattern of [
    /00\|01\|02\|03\|04\|05/,
    /flock -n/,
    /refs\/remotes\/origin\/\$BRANCH/,
    /NEWME_STANDALONE_BUILD=1/,
    /NODE_OPTIONS=--max_old_space_size=1152/,
    /127\.0\.0\.1:3001\/api\/health/,
    /PORT=3102/,
    /127\.0\.0\.1:3101\/api\/health/,
    /mv -Tf "\$CURRENT_NEXT" "\$CURRENT"/,
    /rollback/,
  ]) assert.match(deploy, pattern);
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
  assert.match(deploy, /^MemoryMax=1536M$/m);
  assert.match(deploy, /^MemorySwapMax=0$/m);
  assert.match(deploy, /^CPUQuota=75%$/m);
});
