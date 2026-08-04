"use client";

import { FormEvent, useState } from "react";

type CommercialSummary = {
  organization_id: string;
  plan: { key: string; version: number; name: string; organization_limit: number | null };
  subscription: {
    state: string;
    invoice_mode: "manual";
    paid_seat_limit: number;
    trial_ends_at: string | null;
    grace_ends_at: string | null;
    period_start: string;
    period_end: string | null;
    version: number;
  };
  active_paid_seats: number;
  entitlements: Array<{ entitlement_key: string; enabled: boolean; numeric_limit: number | null }>;
  usage: Array<{ metric_key: string; quantity: number }>;
  invoices: Array<{ invoice_ref: string; status: string; amount_minor: number; currency: string }>;
};

function requestKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function CommercialControlPlane() {
  const [organizationId, setOrganizationId] = useState("");
  const [summary, setSummary] = useState<CommercialSummary | null>(null);
  const [pendingId, setPendingId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadSummary() {
    if (!organizationId.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/platform/commercial?organization_id=${encodeURIComponent(organizationId.trim())}`,
        { cache: "no-store" },
      );
      const result = await response.json() as CommercialSummary & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "commercial_summary_unavailable");
      setSummary(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "commercial_summary_unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function requestAction(actionKey: string, payload: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/platform/commercial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: organizationId.trim(),
          action_key: actionKey,
          payload,
          request_key: requestKey("commercial-request"),
        }),
      });
      const result = await response.json() as { request_id?: string; error?: string };
      if (!response.ok || !result.request_id) {
        throw new Error(result.error ?? "commercial_action_request_failed");
      }
      setPendingId(result.request_id);
      setMessage(`Approval required: ${result.request_id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "commercial_action_request_failed");
    } finally {
      setBusy(false);
    }
  }

  async function approve(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/platform/commercial", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: pendingId.trim(),
          approval_key: requestKey("commercial-approval"),
          execution_key: requestKey("commercial-execution"),
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "commercial_action_execution_failed");
      setMessage("Commercial action approved and executed.");
      await loadSummary();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "commercial_action_execution_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header>
        <p className="text-sm font-medium text-slate-500">V4 commercial control plane</p>
        <h1 className="text-2xl font-semibold text-slate-950">Subscription and entitlement administration</h1>
        <p className="mt-2 text-sm text-slate-600">
          Invoicing is manual. Every change requires a second independent platform approver.
        </p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <label className="block text-sm font-medium text-slate-700" htmlFor="organization-id">
          Organization ID
        </label>
        <div className="mt-2 flex gap-3">
          <input
            id="organization-id"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            placeholder="UUID"
          />
          <button
            className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={busy || !organizationId.trim()}
            onClick={loadSummary}
            type="button"
          >
            Load
          </button>
        </div>
      </section>

      {summary ? (
        <>
          <section className="grid gap-4 md:grid-cols-3">
            <article className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-sm text-slate-500">Plan</p>
              <p className="mt-1 text-xl font-semibold">{summary.plan.name} v{summary.plan.version}</p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-sm text-slate-500">Lifecycle</p>
              <p className="mt-1 text-xl font-semibold capitalize">{summary.subscription.state}</p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-sm text-slate-500">Paid seats</p>
              <p className="mt-1 text-xl font-semibold">
                {summary.active_paid_seats} / {summary.subscription.paid_seat_limit}
              </p>
            </article>
          </section>

          <section className="grid gap-6 lg:grid-cols-2">
            <article className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="font-semibold">Plan and lifecycle</h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {(["starter", "growth", "scale"] as const).map((plan) => (
                  <button
                    key={plan}
                    type="button"
                    disabled={busy || summary.plan.key === plan}
                    onClick={() => requestAction("subscription.plan.change", { plan_key: plan })}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
                  >
                    Request {plan}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {(["active", "grace", "read_only", "suspended"] as const).map((state) => (
                  <button
                    key={state}
                    type="button"
                    disabled={busy || summary.subscription.state === state}
                    onClick={() => requestAction("subscription.state.transition", {
                      to_state: state,
                      reason: "platform_admin_requested",
                      ...(state === "grace" ? { grace_ends_at: new Date(Date.now() + 7 * 86400000).toISOString() } : {}),
                    })}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
                  >
                    Request {state}
                  </button>
                ))}
              </div>
            </article>

            <article className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="font-semibold">Entitlements and usage</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {summary.entitlements.map((entitlement) => (
                  <li key={entitlement.entitlement_key} className="flex justify-between gap-4">
                    <span>{entitlement.entitlement_key}</span>
                    <span>{entitlement.enabled ? entitlement.numeric_limit ?? "enabled" : "disabled"}</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-4 border-t border-slate-100 pt-3 text-sm">
                {summary.usage.map((usage) => (
                  <li key={usage.metric_key}>{usage.metric_key}: {usage.quantity}</li>
                ))}
              </ul>
            </article>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Manual invoice references</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr><th>Reference</th><th>Status</th><th>Amount</th></tr></thead>
                <tbody>
                  {summary.invoices.map((invoice) => (
                    <tr key={invoice.invoice_ref}>
                      <td>{invoice.invoice_ref}</td>
                      <td>{invoice.status}</td>
                      <td>{invoice.currency} {(invoice.amount_minor / 100).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      <form className="rounded-xl border border-amber-200 bg-amber-50 p-5" onSubmit={approve}>
        <label className="block text-sm font-medium text-amber-950" htmlFor="approval-id">
          Independent approval request ID
        </label>
        <div className="mt-2 flex gap-3">
          <input
            id="approval-id"
            className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2"
            value={pendingId}
            onChange={(event) => setPendingId(event.target.value)}
          />
          <button
            className="rounded-lg bg-amber-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={busy || !pendingId.trim()}
            type="submit"
          >
            Approve and execute
          </button>
        </div>
      </form>

      {message ? <p role="status" className="text-sm text-slate-700">{message}</p> : null}
    </main>
  );
}
