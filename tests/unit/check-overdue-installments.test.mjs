import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = new URL("../../src/app/api/cron/check-overdue-installments/route.ts", import.meta.url);
const migration = new URL(
  "../../supabase/migrations/20260724123000_add_overdue_notification_idempotency.sql",
  import.meta.url,
);

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
  const statusUpdate = source.indexOf('.update({ status: "overdue"');
  assert.ok(notificationCall >= 0 && statusUpdate > notificationCall);
  assert.match(source, /NextResponse\.json\(result, \{ status: 502 \}\)/);
});

test("uses a database uniqueness guard and treats a concurrent duplicate as idempotent", async () => {
  const [source, migrationSource] = await Promise.all([readFile(route, "utf8"), readFile(migration, "utf8")]);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS idempotency_key UUID/);
  assert.match(migrationSource, /CREATE UNIQUE INDEX IF NOT EXISTS notifications_payment_overdue_idempotency_uidx/);
  assert.match(migrationSource, /ON public\.notifications \(user_id, idempotency_key\)/);
  assert.match(migrationSource, /WHERE type = 'payment_overdue'[\s\S]*related_type = 'payment'/);
  assert.match(source, /idempotency_key: plan\.id/);
  assert.match(source, /insertError\.code !== "23505"/);
  assert.match(source, /every\(\(userId\) => deduplicatedRecipientIds\.has\(userId\)\)/);
  assert.match(source, /notification_deduplicated: deduplicated/);
});
