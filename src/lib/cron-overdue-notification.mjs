const NOTIFICATION_TIMEOUT_MS = 10_000;

/**
 * /api/notify does not currently provide an idempotency contract. A retry after
 * an ambiguous POST result could create duplicate payment alerts, so this is
 * deliberately one bounded attempt rather than an unsafe automatic retry.
 */
export async function deliverOverdueNotification(plan, timeoutMs = NOTIFICATION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/notify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment_overdue",
          installment_id: plan.id,
          contract_id: plan.contract_id,
          installment_seq: plan.seq,
          amount: plan.amount,
          due_date: plan.due_date,
        }),
        signal: controller.signal,
      },
    );

    return response.ok ? { ok: true } : { ok: false, reason: `http_${response.status}` };
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network_error" };
  } finally {
    clearTimeout(timeout);
  }
}
