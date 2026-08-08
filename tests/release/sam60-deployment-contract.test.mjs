import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("SAM-60/SAM-68 contracts", async () => {
  const [deploy, installer, rollback, productionRollback, health, ready, helper, unit] = await Promise.all([
    read("scripts/deploy-immutable.sh"),
    read("scripts/install-systemd-assets.sh"),
    read("scripts/rollback-systemd-assets.sh"),
    read("infra/systemd/newme-production-rollback.sh"),
    read("src/app/api/health/route.ts"),
    read("src/app/api/ready/route.ts"),
    read("infra/systemd/newme-readiness.sh"),
    read("infra/systemd/newme-platform.service"),
  ]);

  for (const pattern of [/flock -n/, /npm ci/, /git -C .* archive/, /FragmentPath/, /opt\/newme\/releases/, /mv -Tf/, /rollback_release/]) {
    assert.match(deploy, pattern);
  }
  assert.doesNotMatch(deploy, /shared\/node_modules|fuser\s+-k|pkill/);
  for (const token of ["BACKUP", "manifest.sha256", "present.list", "forensic.conf", "restart-always.conf", "newme-runtime.env", "hermes-alert-v1.env", "newme-forensic", "daemon-reload", "EXPECTED_MIRROR_ORIGIN", "repository.git.invalid"]) {
    assert.match(installer, new RegExp(token));
  }
  assert.match(rollback, /manifest\.sha256/);
  assert.match(productionRollback, /\/opt\/newme\/current\.rollback/);
  assert.match(productionRollback, /\.newme-protect/);
  assert.match(productionRollback, /newme-service-control restart/);
  assert.doesNotMatch(health, /fs|BUILD_ID|database|checks|responseTime/);
  assert.match(health, /export const dynamic = "force-dynamic"/);
  assert.match(health, /export const revalidate = 0/);
  assert.match(health, /Cache-Control": "no-store, max-age=0"/);
  assert.match(ready, /401|AbortController/);
  assert.match(ready, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(ready, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(ready, /error\.message|responseTime|writeFileSync|readFileSync/);
  assert.match(ready, /export const dynamic = "force-dynamic"/);
  assert.match(ready, /export const revalidate = 0/);
  assert.match(ready, /Cache-Control": "no-store, max-age=0"/);
  assert.match(helper, /x-newme-readiness-token/);
  assert.match(helper, /mktemp|chmod 600|--config/);
  assert.doesNotMatch(helper, /curl[^\n]*-H[^\n]*x-newme-readiness-token/);
  assert.doesNotMatch(deploy, /curl[^\n]*-H[^\n]*x-newme-readiness-token/);
  assert.match(unit, /EnvironmentFile=\/etc\/newme\/newme-runtime\.env/);
  assert.equal((unit.match(/^ExecStopPost=/gm) || []).length, 1);
  assert.match(unit, /WorkingDirectory=\/opt\/newme\/current/);
});
