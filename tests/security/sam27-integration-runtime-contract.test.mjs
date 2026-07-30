import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Meta routes have no implicit production callback or application id", async () => {
  const [start, callback, capi] = await Promise.all([
    read("src/app/api/meta/oauth-start/route.ts"),
    read("src/app/api/meta/oauth-callback/route.ts"),
    read("src/app/api/leads/meta-capi/route.ts"),
  ]);
  for (const source of [start, callback]) {
    assert.doesNotMatch(source, /1612447067166445/);
    assert.doesNotMatch(source, /https:\/\/app\.newme\.ae\/api\/meta\/oauth-callback/);
    assert.match(source, /status: "disabled"/);
    assert.match(source, /reason: "not_configured"/);
    assert.match(source, /status: 503/);
    assert.match(source, /no-store, max-age=0/);
  }
  assert.match(callback, /integrationFetch/);
  assert.match(callback, /operation: "short_token_exchange"/);
  assert.match(callback, /operation: "long_token_exchange"/);
  assert.doesNotMatch(callback, /using short token/);
  assert.match(capi, /status: "disabled"/);
  assert.match(capi, /integration: "meta_capi"/);
});

test("enabled webhook, notification, and cron paths emit audit and final alert contracts", async () => {
  const [capi, notify, notifications, overdue, cleanup] = await Promise.all([
    read("src/app/api/leads/meta-capi/route.ts"),
    read("src/app/api/notify/route.ts"),
    read("src/lib/notifications.ts"),
    read("src/app/api/cron/check-overdue-installments/route.ts"),
    read("src/app/api/cron/cleanup-notifications/route.ts"),
  ]);
  assert.match(capi, /sinks\.audit/);
  assert.match(capi, /sinks\.alert/);
  assert.match(notify, /integration: "in_app_notification"/);
  assert.match(notifications, /notification_insert_failed/);
  assert.match(notifications, /notification_recipient_lookup_failed/);
  assert.match(overdue, /integration: "cron_overdue_installments"/);
  assert.match(overdue, /sinks\.alert/);
  assert.match(cleanup, /integration: "cron_notification_cleanup"/);
  assert.match(cleanup, /Cleanup delete failed/);
  assert.doesNotMatch(cleanup, /deleteErr[\s\S]{0,120}\bbreak;/);
});

test("SAM-27 runner is loopback-only and cannot carry integration secrets", async () => {
  const [runner, controller] = await Promise.all([
    read("scripts/verify-staging-sam27-integrations.mjs"),
    read("scripts/newme-staging-control.sh"),
  ]);
  assert.match(runner, /http:\/\/127\.0\.0\.1:3101/);
  assert.doesNotMatch(runner, /https:\/\/app\.newme\.ae/);
  assert.match(runner, /meta_must_be_disabled_in_staging/);
  assert.match(runner, /productionCallbackContacted: false/);
  assert.match(controller, /SAM27_EXPECTED_RELEASE_SHA="\$SHA"/);
  assert.doesNotMatch(
    controller,
    /SAM27_EXPECTED_RELEASE_SHA[^\n]*(?:META_APP_SECRET|SUPABASE_SERVICE_ROLE_KEY)/,
  );
});
