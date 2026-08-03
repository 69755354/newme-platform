import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = new URL("../../src/app/api/cron/check-overdue-installments/route.ts", import.meta.url);
const notificationHelper = new URL("../../src/lib/notifications.ts", import.meta.url);

test("creates payment-overdue notifications only for active members in the contract organization", async () => {
  const [source, helper] = await Promise.all([
    readFile(route, "utf8"),
    readFile(notificationHelper, "utf8"),
  ]);
  assert.match(source, /getAdminUserIds\(plan\.organization_id\)/);
  assert.match(source, /getAllActiveUserIds\(plan\.organization_id\)/);
  assert.match(helper, /from\("memberships"\)/);
  assert.match(helper, /\.eq\("organization_id", organizationId\)/);
  assert.match(helper, /\.eq\("status", "active"\)/);
  assert.match(helper, /\.not\("accepted_at", "is", null\)/);
  assert.match(helper, /\.eq\("is_active", true\)/);
  assert.match(helper, /from\("membership_roles"\)/);
  assert.match(helper, /\.in\("role_key", \["org_owner", "org_admin"\]\)/);
  assert.doesNotMatch(helper, /profile\.role === "admin" \|\| profile\.role === "boss"/);
  assert.match(
    source,
    /contract\.sales_id && activeProfileIds\.has\(contract\.sales_id\)/,
  );
  assert.match(source, /from\("notifications"\)\.insert/);
  assert.match(source, /organization_id: plan\.organization_id/);
  assert.match(source, /type: "payment_overdue"/);
});

test("a notification failure leaves the installment eligible for the next cron run", async () => {
  const source = await readFile(route, "utf8");
  assert.match(source, /reason: "notification_insert_failed"/);
  const notificationCall = source.indexOf("createOverdueNotifications(plan)");
  const statusUpdate = source.indexOf(".update({ status: \"overdue\"");
  assert.ok(notificationCall >= 0 && statusUpdate > notificationCall);
  assert.match(source, /notification_failures: notificationFailures\.length/);
  assert.match(source, /NextResponse\.json\(result, \{ status: 502 \}\)/);
});

test("existing recipient notifications are not inserted again before status update", async () => {
  const source = await readFile(route, "utf8");
  assert.match(source, /existingNotifications/);
  assert.match(source, /missingRecipientIds/);
  assert.match(source, /if \(missingRecipientIds\.length === 0\) return \{ ok: true \}/);
  assert.match(source, /do not retry[\s\S]*duplicate payment alerts/);
});
