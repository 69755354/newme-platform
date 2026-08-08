import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Nginx trusts only versioned Cloudflare ranges and limits per real client", async () => {
  const [nginx, installer] = await Promise.all([
    read("infra/nginx/newme-platform.conf"),
    read("scripts/install-systemd-assets.sh"),
  ]);
  assert.equal((nginx.match(/^set_real_ip_from /gm) || []).length, 22);
  assert.match(nginx, /^real_ip_header CF-Connecting-IP;$/m);
  assert.match(nginx, /^real_ip_recursive on;$/m);
  assert.match(nginx, /zone=api:10m rate=10r\/s/);
  assert.match(nginx, /zone=login:10m rate=30r\/m/);
  assert.match(
    nginx,
    /location = \/api\/auth\/session \{[\s\S]*?limit_req zone=login burst=10 nodelay;[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3001;[\s\S]*?\n    \}/,
  );
  assert.doesNotMatch(nginx, /codex_uat_key|astrbot_qr|location = \/qr\.png/);
  for (const route of ["/webhooks/", "/api/", "/hermes/", "/bridge/", "location / {"]) {
    assert.ok(nginx.includes(route), `missing preserved route ${route}`);
  }
  assert.match(installer, /nginx -t/);
  assert.match(installer, /systemctl reload nginx/);
  assert.match(installer, /restore_path "\$NGINX_AVAILABLE"/);
  assert.match(installer, /real_ip_header CF-Connecting-IP/);
});

test("deployment validates runtime and both Supabase keys before switching", async () => {
  const [deploy, validator, installer] = await Promise.all([
    read("scripts/deploy-immutable.sh"),
    read("scripts/validate-production-config.py"),
    read("scripts/install-systemd-assets.sh"),
  ]);
  assert.match(deploy, /validate-production-config\.py[\s\S]*--network/);
  assert.match(deploy, /candidate production Origin boundary/);
  assert.match(deploy, /dependency-probe\.sh/);
  assert.match(deploy, /login-probe\.sh/);
  assert.match(deploy, /reset-before-switch/);
  assert.match(validator, /vfopmpxlhwzpxqegayew/);
  assert.match(validator, /NETWORK_\{label\.upper\(\)\}=200/);
  assert.match(installer, /NEXT_PUBLIC_SITE_URL=https:\/\/app\.newme\.ae/);
  assert.match(installer, /validate-production-config\.py/);
});

test("canonical asset installation is rollback-safe across installer and deploy failures", async () => {
  const [installer, rollback, canonicalDeploy, immutableDeploy] = await Promise.all([
    read("scripts/install-systemd-assets.sh"),
    read("scripts/rollback-systemd-assets.sh"),
    read("infra/systemd/newme-deploy.sh"),
    read("scripts/deploy-immutable.sh"),
  ]);

  assert.match(installer, /mktemp -d "\/var\/backups\/newme-systemd-assets\/\$\{STAMP\}\.XXXXXX"/);
  assert.match(installer, /symlink\.sha256/);
  assert.match(installer, /readlink -- "\$dest"/);
  assert.match(installer, /trap rollback_on_error EXIT/);
  assert.match(installer, /rollback-systemd-assets\.sh" "\$BACKUP"/);
  assert.match(installer, /STATE_ROOT=\/var\/lib\/newme\/deploy-state/);
  assert.match(installer, /PENDING_RECORD="\$STATE_ROOT\/systemd-assets\.pending"/);
  assert.match(installer, /printf 'sha=%s\\nbackup=%s\\nprevious=%s\\nprevious_rollback=%s\\ncandidate_preexisting=0\\n'/);
  assert.match(installer, /recovering unresolved versioned assets/);
  assert.match(installer, /candidate release active; protected asset pointer retained/);
  assert.match(installer, /ln -- "\$PENDING_TMP" "\$PENDING_RECORD"/);
  assert.doesNotMatch(installer, /mv -f "\$PENDING_TMP" "\$PENDING_RECORD"/);
  const pendingPublish = installer.indexOf('ln -- "$PENDING_TMP" "$PENDING_RECORD"');
  const firstLiveInstall = installer.indexOf('install -D -o root -g root -m 0644 "$UNIT" /etc/systemd/system/newme-platform.service');
  assert.ok(pendingPublish >= 0 && firstLiveInstall > pendingPublish, "recovery pointer must exist before live asset mutation");
  const probeInstall = installer.indexOf('install -D -o root -g root -m 0755 "$ROOT/infra/observability/$a" "$OBS/$a"');
  const cronInstall = installer.indexOf('install -D -o root -g root -m 0644 "$ROOT/infra/observability/newme-observability.cron" /etc/cron.d/newme-observability');
  assert.ok(probeInstall >= 0 && cronInstall > probeInstall, "cron must be published after all referenced probes");

  assert.match(rollback, /symlink\.sha256/);
  assert.match(rollback, /readlink -- "\$BACKUP\/rootfs\/\$rel"/);
  assert.match(rollback, /nginx -t/);
  assert.match(rollback, /systemctl reload nginx/);
  assert.match(rollback, /systemctl is-active --quiet nginx/);
  assert.match(rollback, /NGINX_SNAPSHOT=.*mktemp -d \/run\/newme-nginx-current/);
  assert.match(rollback, /restore_nginx_snapshot/);
  assert.match(rollback, /prior live files restored/);
  assert.match(rollback, /NGINX_TRANSACTION_COMMITTED/);
  assert.match(rollback, /snapshot retained at \$NGINX_SNAPSHOT/);

  assert.match(canonicalDeploy, /NEWME_ASSET_BACKUP_RECORD=/);
  assert.match(canonicalDeploy, /load_asset_backup_from_record/);
  assert.match(canonicalDeploy, /load_deploy_state/);
  assert.match(canonicalDeploy, /complete="\$SHA"/);
  assert.match(canonicalDeploy, /candidate release active; versioned assets retained for consistency/);
  assert.match(canonicalDeploy, /could not validate its asset backup record/);
  assert.match(canonicalDeploy, /canonical deploy failed; restoring versioned assets/);
  assert.match(canonicalDeploy, /rollback-systemd-assets\.sh" "\$ASSET_BACKUP"/);
  assert.match(canonicalDeploy, /deploy:asset-rollback:canonical-failure/);
  assert.match(canonicalDeploy, /application verification failed after asset rollback/);
  assert.match(canonicalDeploy, /RESTART_AFTER_ASSET_ROLLBACK/);
  assert.match(canonicalDeploy, /PRESERVE_ASSET_BACKUP_RECORD/);
  assert.match(canonicalDeploy, /canonical deploy asset rollback failed[\s\S]*PRESERVE_ASSET_BACKUP_RECORD=1/);
  assert.match(canonicalDeploy, /clear_matching_pending_asset_record/);
  assert.match(canonicalDeploy, /restore_pending_rollback_link/);
  assert.match(canonicalDeploy, /prior rollback release pointer could not be restored/);
  assert.match(canonicalDeploy, /rollback SHA must equal the current immutable production release/);
  assert.match(canonicalDeploy, /STATE_ROOT=\/var\/lib\/newme\/deploy-state/);
  assert.match(canonicalDeploy, /matching pending asset pointer could not be cleared after rollback/);
  assert.match(canonicalDeploy, /completed deployment pending asset pointer could not be cleared/);
  assert.match(canonicalDeploy, /app_rollback_pending/);
  assert.match(canonicalDeploy, /NEWME_ASSET_BACKUP="\$ASSET_BACKUP"/);
  assert.match(canonicalDeploy, /NEWME_DEPLOY_STATE_RECORD="\$DEPLOY_STATE_RECORD"/);
  assert.match(immutableDeploy, /versioned asset backup is missing/);
  assert.match(immutableDeploy, /write_deploy_state "complete=\$SHA"/);
  assert.match(immutableDeploy, /deploy_state_is_complete/);
  assert.match(immutableDeploy, /write_deploy_state switch_pending/);
  assert.match(immutableDeploy, /write_deploy_state switched/);
  assert.match(immutableDeploy, /write_deploy_state app_rolled_back/);
  assert.match(immutableDeploy, /write_deploy_state app_rollback_pending/);
  assert.match(immutableDeploy, /write_deploy_state assets_rolled_back/);
  assert.match(immutableDeploy, /load_pending_asset_backup/);
  assert.match(immutableDeploy, /OWN_DEPLOY_STATE_RECORD/);
  assert.match(immutableDeploy, /PENDING_ASSET_CLEARED/);
  assert.match(immutableDeploy, /STATE_ROOT=\/var\/lib\/newme\/deploy-state/);
  assert.match(immutableDeploy, /completed deployment pending asset pointer could not be cleared/);
  assert.match(immutableDeploy, /early_asset_cleanup/);
  const earlyTrap = immutableDeploy.indexOf("trap early_asset_cleanup EXIT");
  const pendingLoad = immutableDeploy.indexOf('load_pending_asset_backup || { fail "pending versioned asset backup is missing or stale"');
  const ownStateRecord = immutableDeploy.indexOf('mktemp "$STATE_ROOT/deploy-state.XXXXXX"');
  assert.ok(earlyTrap >= 0 && pendingLoad > earlyTrap, "bootstrap asset rollback must cover pending-record validation");
  assert.ok(earlyTrap >= 0 && ownStateRecord > earlyTrap, "bootstrap asset rollback must cover child state setup");
  assert.match(immutableDeploy, /write_deploy_state app_rollback_pending \|\| return 1/);
  assert.match(immutableDeploy, /expected rollback SHA does not match current/);
  assert.match(immutableDeploy, /restart "deploy:\$ID:asset-rollback" \|\| return 1/);
  assert.match(immutableDeploy, /rollback-systemd-assets\.sh" "\$ASSET_BACKUP" \|\| return 1[\s\S]*restore_rollback_link \|\| return 1[\s\S]*write_deploy_state assets_rolled_back/);
  assert.match(immutableDeploy, /refusing to restore prior assets while the candidate release remains active/);
  assert.match(immutableDeploy, /rollback_assets/);
  const deployTrap = immutableDeploy.indexOf("trap cleanup EXIT");
  const deployPreflight = immutableDeploy.indexOf("verify-release-preflight.sh");
  assert.ok(deployTrap >= 0 && deployPreflight > deployTrap, "asset rollback trap must cover release preflight");
  assert.match(immutableDeploy, /trap cleanup EXIT/);
  assert.match(immutableDeploy, /trap 'exit 129' HUP/);
  assert.match(immutableDeploy, /trap 'exit 130' INT/);
  assert.match(immutableDeploy, /trap 'exit 143' TERM/);
  assert.doesNotMatch(immutableDeploy, /trap cleanup EXIT INT TERM/);
  assert.match(immutableDeploy, /"asset_backup": os\.environ\["NEWME_ASSET_BACKUP"\]/);
});

test("the no-cost composite Sentry monitor preserves independent Hermes alerts", async () => {
  const [dependency, login, composite, sentry, cron, alertState] = await Promise.all([
    read("infra/observability/dependency-probe.sh"),
    read("infra/observability/login-probe.sh"),
    read("infra/observability/l0-composite-probe.sh"),
    read("infra/observability/sentry-cron-checkin.sh"),
    read("infra/observability/newme-observability.cron"),
    read("infra/observability/hermes-alert-state-v1.sh"),
  ]);
  assert.match(dependency, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(dependency, /sb_publishable_/);
  assert.match(dependency, /sb_secret_/);
  assert.match(dependency, /"publishable": "anon"/);
  assert.match(dependency, /"service": "service_role"/);
  assert.match(dependency, /line\.startswith\("export "\)/);
  assert.match(dependency, /value\[0\] == value\[-1\]/);
  assert.match(dependency, /rest\/v1\/profiles\?select=id&limit=1/);
  assert.match(dependency, /--config "\$CURL_CONFIG"/);
  assert.match(dependency, /could not create a protected curl config/);
  assert.match(login, /429\/5xx/);
  assert.match(dependency, /record_alert failure/);
  assert.match(login, /record_alert failure/);
  assert.doesNotMatch(dependency, /sentry_checkin_/);
  assert.doesNotMatch(login, /sentry_checkin_/);
  assert.match(composite, /MONITOR_SLUG=newme-health-check/);
  assert.match(composite, /HEALTH_PROBE=.*health-check\.sh/);
  assert.match(composite, /LOGIN_PROBE=.*login-probe\.sh/);
  assert.match(composite, /DEPENDENCY_PROBE=.*dependency-probe\.sh/);
  assert.match(composite, /sentry_checkin_start "\$MONITOR_SLUG"/);
  assert.match(composite, /sentry_checkin_finish "\$MONITOR_SLUG" "\$probe_status"/);
  assert.match(sentry, /\/api\/\$\{SENTRY_PROJECT_ID\}\/cron\/\$\{monitor_slug\}\/\$\{SENTRY_KEY\}\//);
  assert.match(sentry, /SENTRY_KEY="\$\{BASH_REMATCH\[1\]\}"/);
  assert.match(sentry, /\[ "\$http_code" != 202 \]/);
  assert.doesNotMatch(sentry, /Authorization: DSN/);
  assert.match(cron, /^\*\/2 .*l0-composite-probe\.sh$/m);
  assert.doesNotMatch(cron, /^\*\/2 .*login-probe\.sh$/m);
  assert.doesNotMatch(cron, /^\*\/2 .*dependency-probe\.sh$/m);
  assert.match(alertState, /login-probe\|dependency-probe\|l0-composite-sentry/);
  assert.match(alertState, /HERMES_L0_ALERT_THRESHOLD:-1/);
});

test("server errors are forwarded to Sentry with release identity", async () => {
  const [logger, monitoring, deploy] = await Promise.all([
    read("src/lib/logger.ts"),
    read("src/app/api/monitoring/report/route.ts"),
    read("scripts/deploy-immutable.sh"),
  ]);
  assert.match(logger, /Sentry\.captureException/);
  assert.match(logger, /Sentry\.captureMessage/);
  assert.match(logger, /process\.env\.SENTRY_RELEASE/);
  assert.match(monitoring, /Sentry\.captureMessage/);
  assert.match(monitoring, /sanitizeValue/);
  assert.match(deploy, /NEXT_PUBLIC_APP_VERSION="\$SHA" SENTRY_RELEASE="\$SHA"/);
});
