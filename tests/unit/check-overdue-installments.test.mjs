import assert from "node:assert/strict";
import test from "node:test";
import { deliverOverdueNotification } from "../../src/lib/cron-overdue-notification.mjs";
const plan = { id: "installment-1", contract_id: "contract-1", seq: 2, amount: 100, due_date: "2026-07-01" };

test("delivers an overdue notification with the installment id", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = init;
    return new Response(null, { status: 200 });
  };
  try {
    assert.deepEqual(await deliverOverdueNotification(plan), { ok: true });
    assert.equal(JSON.parse(request.body).installment_id, plan.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns a structured failure for a rejected notification", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try {
    assert.deepEqual(await deliverOverdueNotification(plan), { ok: false, reason: "http_401" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounds a stalled notification request by timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  try {
    assert.deepEqual(await deliverOverdueNotification(plan, 1), { ok: false, reason: "timeout" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
