"use client";

// Dispatch workbench (S24): the administrator's queue, one tab per dispatch state with its count, a row per lead and
// a small panel for the allowed decisions. It only calls the dispatch and duplicate APIs; the server and the
// database check the role again. "Check new leads" evaluates the last seven days only (never a backfill).
// The interface labels Show room, FB and ins are not touched here.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ATTENTION_STATUSES, DISPATCH_STATUSES, DUPLICATE_DECISIONS, buildQueueAssignRequest, canAssignFromQueue } from "@/lib/lead-dispatch.mjs";
import { reassignFailureKey } from "@/lib/lead-reassign-feedback.mjs";
import { buttonClass, callApi, errorText, inputClass, STATUS_TONE, textareaClass, type Translate } from "./shared";

interface LeadFacts { id: string; customer_name: string | null; phone: string | null; email: string | null; source: string | null; source_channel: string | null; assigned_to: string | null; created_at: string | null; updated_at?: string | null }
interface Rep { id: string; name: string }
interface DuplicateInfo { review_id: string; decision: string; notes: string | null; matched_on: string[]; candidates: number; original: LeadFacts | null }
interface Row {
  lead_id: string; status: string; missing_fields: string[]; phone_flag: string; routing_note: string | null; admin_note: string | null;
  release_reason: string | null; lead: LeadFacts | null; allowed_actions: string[]; duplicate: DuplicateInfo | null;
}
interface QueueBody { status: string; counts: Record<string, number>; data: Row[]; pagination: { limit: number; offset: number; total: number; has_more: boolean } }
const PAGE_SIZE = 50;
// An action opens a small form for its reason; these run at once.
const IMMEDIATE = new Set(["confirm_phone", "revoke_release", "reevaluate"]);

function Facts({ t, lead, title }: { t: Translate; lead: LeadFacts | null; title: string }) {
  if (!lead) return <div className="text-xs text-muted-foreground">—</div>;
  return (
    <div className="space-y-0.5 text-xs">
      <div className="font-medium text-muted-foreground">{title}</div>
      <Link href={`/leads/${lead.id}`} className="font-medium underline-offset-2 hover:underline">{lead.customer_name || "—"}</Link>
      <div>{lead.phone || "—"}</div>
      <div className="text-muted-foreground">{lead.email || "—"}</div>
      <div className="text-muted-foreground">{t("dispatch.sourceLabel")}: {lead.source_channel || lead.source || "—"}</div>
      <div className="text-muted-foreground">{lead.assigned_to ? t("dispatch.hasOwner") : t("dispatch.noOwner")}</div>
    </div>
  );
}

export default function DispatchWorkbench({ t }: { t: Translate }) {
  // S42 (F09): the cockpit links straight to a tab (/dispatch?tab=unassigned); an unknown value keeps the default.
  const [status, setStatus] = useState<string>(() => {
    const wanted = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
    return wanted && (DISPATCH_STATUSES as readonly string[]).includes(wanted) ? wanted : ATTENTION_STATUSES[0];
  });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [open, setOpen] = useState<{ key: string; kind: "action" | "decision" | "reopen"; value: string } | null>(null);
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);
  // S35: salespeople a lead can be handed to (the same list the lead page uses: sales, operator, boss; no QA accounts).
  const [reps, setReps] = useState<Rep[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await callApi<{ data?: Array<{ id: string; full_name: string | null; email: string | null }> }>("/api/dispatch/reps");
      if (cancelled || !result.ok || !result.body.data) return;
      setReps(result.body.data.map((p) => ({ id: p.id, name: p.full_name || p.email || p.id })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await callApi<QueueBody>(`/api/dispatch/queue?status=${status}&limit=${PAGE_SIZE}&offset=${offset}`);
      if (cancelled) return;
      if (result.status === 503) { setState("unavailable"); return; }
      if (!result.ok) { setState("error"); return; }
      setCounts(result.body.counts ?? {});
      setRows(result.body.data ?? []);
      setTotal(result.body.pagination?.total ?? 0);
      setHasMore(Boolean(result.body.pagination?.has_more));
      setState("ready");
    })();
    return () => { cancelled = true; };
  }, [status, offset, reloadKey]);

  const finish = async (call: () => Promise<{ ok: boolean; status: number; body: { error?: string } }>) => {
    setBusy(true); setMessage("");
    const result = await call();
    setBusy(false);
    if (result.ok) { setOpen(null); setText(""); reload(); return; }
    setMessage(errorText(t, result));
  };

  const decide = (leadId: string, action: string, reason: string | null) => finish(() =>
    callApi(`/api/dispatch/${leadId}/decide`, { method: "POST", body: JSON.stringify({ action, reason }) }));
  const resolve = (reviewId: string, decision: string, notes: string | null) => finish(() =>
    callApi(`/api/duplicates/${reviewId}/resolve`, { method: "POST", body: JSON.stringify({ decision, notes }) }));
  const reopen = (reviewId: string, reason: string) => finish(() =>
    callApi(`/api/duplicates/${reviewId}/reopen`, { method: "POST", body: JSON.stringify({ reason }) }));
  // S35: hand an unassigned lead to a salesperson with the ordinary assignment API, then re-check the lead so it leaves "Unassigned".
  const assign = async (row: Row) => {
    const request = buildQueueAssignRequest(row, pick[row.lead_id] ?? "", crypto.randomUUID());
    if (!request) return;
    setBusy(true); setMessage("");
    const result = await callApi<{ code?: string }>(request.url, { method: "POST", body: JSON.stringify(request.body) });
    if (result.ok) await callApi(`/api/dispatch/${row.lead_id}/decide`, { method: "POST", body: JSON.stringify({ action: "reevaluate", reason: null }) });
    setBusy(false);
    if (!result.ok) {
      setMessage(t(reassignFailureKey(result.status, result.body.code ?? result.body.error)));
      if (result.status === 409) reload();
      return;
    }
    setPick((current) => { const next = { ...current }; delete next[row.lead_id]; return next; });
    setMessage(t("dispatch.assign.done"));
    reload();
  };
  const refresh = async () => {
    setBusy(true); setMessage("");
    const result = await callApi<{ evaluated?: number }>("/api/dispatch/refresh", { method: "POST", body: "{}" });
    setBusy(false);
    if (!result.ok) { setMessage(errorText(t, result)); return; }
    setMessage(t("dispatch.refreshed").replace("{n}", String(result.body.evaluated ?? 0)));
    reload();
  };

  const form = (row: Row) => {
    if (!open || open.key !== row.lead_id) return null;
    const submit = () => {
      if (open.kind === "action") return decide(row.lead_id, open.value, text.trim() || null);
      if (open.kind === "decision" && row.duplicate) return resolve(row.duplicate.review_id, open.value, text.trim() || null);
      if (open.kind === "reopen" && row.duplicate) return reopen(row.duplicate.review_id, text.trim());
    };
    return (
      <div className="mt-2 space-y-1 rounded-md border border-border p-2">
        <label className="text-xs text-muted-foreground">{open.kind === "decision" ? t("dispatch.notesLabel") : t("dispatch.reasonLabel")}</label>
        <textarea className={textareaClass} rows={2} value={text} placeholder={t("dispatch.reasonPlaceholder")} onChange={(e) => setText(e.target.value)} />
        <div className="flex gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={submit}>{busy ? t("dispatch.working") : t("dispatch.confirm")}</button>
          <button type="button" className={buttonClass} onClick={() => { setOpen(null); setText(""); }}>{t("dispatch.cancel")}</button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3" data-testid="dispatch-workbench">
      <div className="flex flex-wrap items-center gap-2">
        {DISPATCH_STATUSES.map((name) => (
          <button key={name} type="button" onClick={() => { if (name === status) return; setStatus(name); setOffset(0); setOpen(null); setState("loading"); }}
            className={`${buttonClass} ${status === name ? "bg-muted font-medium" : ""}`} data-testid={`dispatch-tab-${name}`}>
            {t(`dispatch.status.${name}`)} <span className="ml-1 text-muted-foreground">{counts[name] ?? 0}</span>
          </button>
        ))}
        <button type="button" className={`${buttonClass} ml-auto`} disabled={busy} onClick={refresh}>{busy ? t("dispatch.refreshing") : t("dispatch.refresh")}</button>
      </div>
      <p className="text-xs text-muted-foreground">{t(`dispatch.statusHelp.${status}`)}</p>
      {message ? <p role="status" className="text-xs">{message}</p> : null}
      {state === "loading" ? <p className="text-xs text-muted-foreground">{t("dispatch.loading")}</p> : null}
      {state === "unavailable" ? <p className="text-xs text-muted-foreground">{t("dispatch.unavailable")}</p> : null}
      {state === "error" ? <p className="text-xs text-red-400">{t("dispatch.loadError")}</p> : null}
      {state === "ready" && rows.length === 0 ? <p className="text-xs text-muted-foreground">{t("dispatch.empty")}</p> : null}
      <ul className="space-y-2">
        {state === "ready" ? rows.map((row) => (
          <li key={row.lead_id} className="rounded-md border border-border p-3" data-testid="dispatch-row">
            <div className="flex flex-wrap items-start gap-4">
              <Facts t={t} lead={row.lead} title={t("dispatch.thisLead")} />
              {row.duplicate ? <Facts t={t} lead={row.duplicate.original} title={t("dispatch.original")} /> : null}
              <div className="min-w-[12rem] flex-1 space-y-1 text-xs">
                <span className={`inline-flex rounded px-1.5 py-0.5 ${STATUS_TONE[row.status] ?? ""}`}>{t(`dispatch.status.${row.status}`)}</span>
                {row.missing_fields.length ? <div>{t("dispatch.missingLabel")}: {row.missing_fields.map((f) => t(`dispatch.field.${f}`)).join(", ")}</div> : null}
                {row.phone_flag === "invalid" || row.phone_flag === "suspect" ? <div>{t("dispatch.phoneLabel")}: {t(`dispatch.phoneFlag.${row.phone_flag}`)}</div> : null}
                {row.duplicate ? <div>{t("dispatch.matchedOnLabel")}: {row.duplicate.matched_on.map((m) => t(`dispatch.matchedOn.${m}`)).join(", ")}</div> : null}
                {row.duplicate && row.duplicate.decision !== "pending" ? <div>{t("dispatch.decidedAs")}: {t(`dispatch.decision.${row.duplicate.decision === "merged" ? "merged" : "invalid"}`)}{row.duplicate.notes ? ` — ${row.duplicate.notes}` : ""}</div> : null}
                {row.release_reason ? <div className="text-muted-foreground">{row.release_reason}</div> : null}
                {row.admin_note ? <div className="text-muted-foreground">{row.admin_note}</div> : null}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {row.status === "duplicate_review" && row.duplicate ? DUPLICATE_DECISIONS.map((d) => (
                <button key={d} type="button" className={buttonClass} disabled={busy} title={t(`dispatch.decisionHelp.${d}`)}
                  onClick={() => (d === "merged" ? resolve(row.duplicate!.review_id, d, null) : (setOpen({ key: row.lead_id, kind: "decision", value: d }), setText("")))}>
                  {t(`dispatch.decision.${d}`)}
                </button>
              )) : null}
              {row.status === "duplicate_not_dispatched" && row.duplicate ? (
                <button type="button" className={buttonClass} disabled={busy} onClick={() => { setOpen({ key: row.lead_id, kind: "reopen", value: "reopen" }); setText(""); }}>{t("dispatch.reopen")}</button>
              ) : null}
              {row.allowed_actions.map((action) => (
                <button key={action} type="button" className={buttonClass} disabled={busy}
                  onClick={() => (IMMEDIATE.has(action) ? decide(row.lead_id, action, null) : (setOpen({ key: row.lead_id, kind: "action", value: action }), setText("")))}>
                  {t(`dispatch.action.${action}`)}
                </button>
              ))}
              {canAssignFromQueue(row) ? (
                <span className="inline-flex items-center gap-1" data-testid="dispatch-assign">
                  <select className="h-7 rounded-md border border-border bg-background px-1 text-xs" aria-label={t("dispatch.assign.label")} value={pick[row.lead_id] ?? ""}
                    onChange={(e) => setPick((current) => ({ ...current, [row.lead_id]: e.target.value }))} disabled={busy}>
                    <option value="">{t("dispatch.assign.pick")}</option>
                    {reps.map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
                  </select>
                  <button type="button" className={buttonClass} disabled={busy || !pick[row.lead_id]} onClick={() => assign(row)}>{t("dispatch.assign.button")}</button>
                </span>
              ) : null}
              <Link href={`/leads/${row.lead_id}`} className={buttonClass}>{t("dispatch.openLead")}</Link>
            </div>
            {form(row)}
          </li>
        )) : null}
      </ul>
      {state === "ready" && (offset > 0 || hasMore) ? (
        <div className="flex items-center gap-2 text-xs" data-testid="dispatch-pagination">
          <button type="button" className={buttonClass} disabled={offset === 0} data-testid="dispatch-prev"
            onClick={() => { setOpen(null); setState("loading"); setOffset(Math.max(0, offset - PAGE_SIZE)); }}>{t("dispatch.prev")}</button>
          <span className="text-muted-foreground">{t("dispatch.pageRange").replace("{from}", String(offset + 1)).replace("{to}", String(offset + rows.length)).replace("{total}", String(total))}</span>
          <button type="button" className={buttonClass} disabled={!hasMore} data-testid="dispatch-next"
            onClick={() => { setOpen(null); setState("loading"); setOffset(offset + PAGE_SIZE); }}>{t("dispatch.next")}</button>
        </div>
      ) : null}
    </div>
  );
}
