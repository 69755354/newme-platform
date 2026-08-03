import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  completeContractApproval,
  ContractApprovalResultError,
  hasNotificationWarning,
  requireContractApprovalSuccess,
  withContractNotificationWarning,
} from "../../src/lib/contract-approval-result.ts";
import {
  dailyReminderBusinessDate,
  dailyReminderDeliveryResult,
  dailyReminderEventKey,
  deliverDailyReminderNotifications,
} from "../../src/lib/daily-reminder-result.ts";
import { buildContractRevocationNotifications } from "../../src/lib/contract-revocation-notification.ts";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("approval JSON business failures are non-success and notification failure preserves commit", async () => {
  assert.throws(
    () => requireContractApprovalSuccess({ error: "Contract not in approvable state" }),
    (error) => error instanceof ContractApprovalResultError
      && error.status === 409 && error.code === "contract_approval_conflict",
  );
  assert.throws(
    () => requireContractApprovalSuccess({ error: "Role not authorized to approve" }),
    (error) => error instanceof ContractApprovalResultError
      && error.status === 403 && error.code === "contract_approval_forbidden",
  );
  let warningObserved = false;
  const result = await completeContractApproval(
    { success: true, new_status: "pending_ceo" },
    async () => { throw new Error("notification_bulk_insert_failed"); },
    () => { warningObserved = true; },
  );
  assert.deepEqual(result, {
    success: true,
    new_status: "pending_ceo",
    notification_warning: "notification_delivery_failed",
  });
  assert.equal(warningObserved, true);
});

test("approval route/action consume JSON errors and decouple notification delivery", async () => {
  const [route, action] = await Promise.all([
    read("src/app/api/contracts/[id]/approve/route.ts"),
    read("src/app/actions/contracts.ts"),
  ]);
  for (const source of [route, action]) {
    assert.match(source, /completeContractApproval\(\s*rpcResult/);
    assert.doesNotMatch(source, /if \(rpcErr\)[\s\S]*?return rpcResult/);
  }
  assert.match(route, /ContractApprovalResultError/);
  assert.match(route, /status: resultError\.status/);
  assert.match(route, /contract_approval_unavailable/);
  assert.doesNotMatch(route, /error: rpcErr\.message/);
  assert.match(route, /Approval committed but notification delivery failed/);
});

test("daily reminder fails the HTTP operation when any notification write fails", async () => {
  assert.deepEqual(dailyReminderDeliveryResult(5, 3, 2), {
    status: 502,
    body: {
      error: "notification_delivery_failed",
      checked: 5,
      notificationsCreated: 3,
      notificationFailures: 2,
    },
  });
  assert.deepEqual(dailyReminderDeliveryResult(5, 2, 0), {
    status: 200,
    body: { checked: 5, notificationsCreated: 2, notificationFailures: 0 },
  });
  const route = await read("src/app/api/cron/daily-reminder/route.ts");
  assert.match(route, /deliverDailyReminderNotifications/);
  assert.match(route, /\.upsert\(notification/);
  assert.match(route, /onConflict: "organization_id,user_id,event_key"/);
  assert.match(route, /ignoreDuplicates: true/);
  assert.match(route, /dailyReminderDeliveryResult/);
  assert.match(route, /status: outcome\.status/);
});

test("daily reminder partial failure retry is task-scoped and does not duplicate success", async () => {
  const businessDate = dailyReminderBusinessDate(new Date(2026, 7, 3, 12, 0, 0));
  assert.equal(businessDate, "2026-08-03");
  const tasks = [
    {
      id: "task-a",
      organizationId: "organization-a",
      assigneeId: "user-a",
      title: "Call customer A",
    },
    {
      id: "task-b",
      organizationId: "organization-a",
      assigneeId: "user-a",
      title: "Call customer B",
    },
  ];
  const rows = new Map();
  let failTaskBOnce = true;
  const idempotentWrite = async (notification) => {
    if (notification.related_id === "task-b" && failTaskBOnce) {
      failTaskBOnce = false;
      throw new Error("injected_partial_failure");
    }
    if (rows.has(notification.event_key)) return false;
    rows.set(notification.event_key, notification);
    return true;
  };

  assert.deepEqual(
    await deliverDailyReminderNotifications(tasks, businessDate, idempotentWrite),
    { notificationsCreated: 1, notificationFailures: 1 },
  );
  assert.deepEqual(
    await deliverDailyReminderNotifications(tasks, businessDate, idempotentWrite),
    { notificationsCreated: 1, notificationFailures: 0 },
  );
  assert.equal(rows.size, 2);
  assert.deepEqual([...rows.keys()].sort(), [
    dailyReminderEventKey("task-a", businessDate),
    dailyReminderEventKey("task-b", businessDate),
  ]);
  for (const row of rows.values()) {
    assert.equal(row.type, "followup_reminder");
    assert.equal(row.related_type, null);
  }
});

test("contract revocation route and action share idempotent notifications and warning contract", async () => {
  const context = {
    contractId: "contract-1",
    contractNo: "CN-001",
    salesId: "sales-1",
    status: "revoking",
    reason: "Customer request",
  };
  const first = buildContractRevocationNotifications(context, ["admin-1", "sales-1"]);
  const retry = buildContractRevocationNotifications(
    { ...context, reason: "Changed retry body" },
    ["sales-1", "admin-1"],
  );
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((notification) => notification.userId).sort(), ["admin-1", "sales-1"]);
  assert.deepEqual(
    first.map((notification) => notification.eventKey),
    retry.map((notification) => notification.eventKey),
  );
  assert.equal(first[0].eventKey, "contract:contract-1:status:revoking");

  const result = await withContractNotificationWarning(
    { success: true, contract_id: "contract-1", status: "revoking" },
    async () => { throw new Error("notification_bulk_insert_failed"); },
  );
  assert.equal(hasNotificationWarning(result), true);

  const [route, action, detailPage, listPage] = await Promise.all([
    read("src/app/api/contracts/[id]/revoke/route.ts"),
    read("src/app/actions/contracts.ts"),
    read("src/app/(dashboard)/contracts/[id]/page.tsx"),
    read("src/app/(dashboard)/contracts/page.tsx"),
  ]);
  for (const source of [route, action]) {
    assert.match(source, /withContractNotificationWarning/);
    assert.match(source, /buildContractRevocationNotifications/);
    assert.match(source, /createNotificationsBulk/);
  }
  assert.match(route, /return NextResponse\.json\(result\)/);
  assert.match(action, /return withContractNotificationWarning/);
  assert.match(detailPage, /const responseBody: unknown = await res\.json\(\)\.catch/);
  assert.match(detailPage, /hasNotificationWarning\(responseBody\)/);
  assert.match(detailPage, /Action saved; notification delivery failed\./);
  assert.match(listPage, /const result = await revokeContract/);
  assert.match(listPage, /hasNotificationWarning\(result\)/);
  assert.match(listPage, /Revocation saved; notification delivery failed\./);
});
