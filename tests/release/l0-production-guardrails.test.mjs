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
