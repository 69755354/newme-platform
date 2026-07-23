import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = new URL("../../src/app/api/cron/check-overdue-installments/route.ts", import.meta.url);

test("creates payment-overdue notifications for admins and the contract salesperson", async () => {
  const source = await readFile(route, "utf8");
  assert.match(source, /from\("profiles"\).*\.in\("role", \["admin", "boss"\]\).*\.eq\("is_active", true\)/s);
  assert.match(source, /recipientIds\.add\(contract\.sales_id\)/);
  assert.match(source, /from\("notifications"\)\.insert/);
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
