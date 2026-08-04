import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("production rollback controller is immutable, atomic, and fail-closed", async () => {
  const source = await read("infra/systemd/newme-production-rollback.sh");

  assert.match(source, /newme-production-rollback must run as root/);
  assert.match(source, /exec 9>\/run\/lock\/newme-production-release\.lock/);
  assert.match(source, /flock -n 9/);
  assert.match(source, /another production release operation is active/);
  assert.match(source, /case "\$action" in[\s\S]*status\)[\s\S]*execute\)/);
  assert.match(source, /\/opt\/newme\/current\.rollback/);
  assert.match(source, /case "\$release" in[\s\S]*\/opt\/newme\/releases\/\*/);
  assert.match(source, /\.newme-protect/);
  assert.match(source, /\.next\/BUILD_ID/);
  assert.match(source, /current and rollback are identical/);
  assert.match(source, /trap 'rc=\$\?; if \[ \$rc -ne 0 \]; then restore; fi; exit \$rc' EXIT/);
  assert.ok((source.match(/mv -Tf/g) ?? []).length >= 4);
  assert.match(source, /newme-service-control restart "production rollback: \$reason"/);
  assert.match(source, /"\$health" = 200/);
  assert.match(source, /"\$auth" = 401/);
  assert.match(source, /systemctl is-active newme-platform\.service/);
  assert.match(source, /SYSLOG_IDENTIFIER=newme-production-rollback/);

  assert.doesNotMatch(source, /systemctl\s+(?:restart|start|stop)/);
  assert.doesNotMatch(source, /rm\s+-rf|eval\s|source\s+.*\.env|cat\s+.*\.env/);
  assert.doesNotMatch(source, /SUPABASE|SERVICE_ROLE|READINESS_TOKEN/);
});

test("production deploy and sudo policy require the versioned rollback boundary", async () => {
  const [deploy, rollback, sudoers, installer] = await Promise.all([
    read("infra/systemd/newme-deploy.sh"),
    read("infra/systemd/newme-production-rollback.sh"),
    read("infra/sudoers/newme-platform"),
    read("scripts/install-systemd-assets.sh"),
  ]);

  assert.match(deploy, /manual production deployment is disabled/);
  assert.match(deploy, /exec 9>\/run\/lock\/newme-production-release\.lock/);
  assert.match(deploy, /flock -n 9/);
  assert.match(deploy, /another production release operation is active/);
  const releaseLock = "exec 9>/run/lock/newme-production-release.lock";
  assert.equal([deploy, rollback].filter((source) => source.includes(releaseLock)).length, 2);
  assert.match(deploy, /run\.get\("head_sha"\) != expected_sha/);
  assert.match(deploy, /run\.get\("name"\) != "ci"/);
  assert.match(deploy, /run\.get\("conclusion"\) != "success"/);
  assert.match(deploy, /infra\/systemd\/newme-production-rollback\.sh/);
  assert.match(deploy, /main lacks the protected production rollback controller/);
  assert.match(deploy, /infra\/sudoers\/newme-platform/);
  assert.match(deploy, /NEWME_MANUAL_VERIFICATION=0/);
  assert.doesNotMatch(deploy, /manual_verified|CI_RUN_URL="manual"/);

  assert.match(sudoers, /NEWME_PRODUCTION_RECOVERY/);
  assert.match(sudoers, /newme-production-rollback status/);
  assert.match(sudoers, /newme-production-rollback execute \*/);
  assert.match(sudoers, /journalctl -t newme-production-rollback \*/);
  assert.doesNotMatch(sudoers, /newme-service-control (?:start|stop|try-restart) \*/);

  assert.match(installer, /\/usr\/local\/sbin\/newme-production-rollback/);
  assert.match(
    installer,
    /install -D -o root -g root -m 0755 "\$ROOT\/infra\/systemd\/newme-production-rollback\.sh" \/usr\/local\/sbin\/newme-production-rollback/,
  );
  assert.match(installer, /test -x \/usr\/local\/sbin\/newme-production-rollback/);
});
