"use client";

// Visit reports (S23). With a leadId it is the lead page card (list, plan form, report form, workflow buttons);
// without one it is the /visits list across the leads the signed-in user may see. Approving and reviewing show only
// for admin, boss and operator; the server and the database check the role again. The interface labels
// Show room, FB and ins are not touched here.
import { useEffect, useState } from "react";
import Link from "next/link";
import { fmtDubai } from "@/lib/utils";
import { canReviewVisits, dubaiLocalToIso, isoToDubaiLocal } from "@/lib/opportunity-visit.mjs";
import { buttonClass, callApi, errorText, fieldErrorText, inputClass, STATUS_TONE, textareaClass, type Translate } from "./shared";

interface Visit {
  id: string; visit_no: number; lead_id: string; opportunity_id: string | null; opportunity_name?: string | null;
  planned_at: string; location: string | null; person_to_meet: string | null; purpose: string;
  plan_approval: "pending" | "approved" | "rejected"; plan_note: string | null;
  actual_start: string | null; actual_finish: string | null; result: string | null; next_action: string | null;
  next_followup_date: string | null; evidence_link: string | null; submitted_at: string | null; report_due_at: string | null;
  review_status: "pending" | "accepted" | "needs_fix"; review_notes: string | null; action_done: boolean;
  status: "planned" | "approved" | "completed" | "reviewed" | "overdue";
  leads?: { id: string; customer_name: string | null } | null;
}
interface OpportunityOption { id: string; name: string }
interface Props { t: Translate; role: string; leadId?: string }
const PLAN_EMPTY = { planned_at: "", location: "", person_to_meet: "", purpose: "", opportunity_id: "" };
const STATUSES = ["planned", "approved", "completed", "reviewed", "overdue"];

export default function VisitPanel({ t, role, leadId }: Props) {
  const [rows, setRows] = useState<Visit[] | null>(null);
  const [options, setOptions] = useState<OpportunityOption[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [statusFilter, setStatusFilter] = useState("");
  const [plan, setPlan] = useState<typeof PLAN_EMPTY | null>(null);
  const [planErrors, setPlanErrors] = useState<Record<string, string>>({});
  const [report, setReport] = useState<{ id: string; values: Record<string, string> } | null>(null);
  const [reportErrors, setReportErrors] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const staff = canReviewVisits(role);

  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ limit: "100" });
    if (leadId) query.set("lead_id", leadId);
    if (statusFilter) query.set("status", statusFilter);
    (async () => {
      const result = await callApi<{ data: Visit[] }>(`/api/visits?${query}`);
      if (cancelled) return;
      if (result.status === 503) { setState("unavailable"); return; }
      if (!result.ok) { setState("error"); return; }
      setRows(result.body.data ?? []);
      setState("ready");
      if (leadId) {
        const opps = await callApi<{ data: OpportunityOption[] }>(`/api/opportunities?lead_id=${leadId}&limit=100`);
        if (!cancelled && opps.ok) setOptions(opps.body.data ?? []);
      }
    })();
    return () => { cancelled = true; };
  }, [leadId, statusFilter, reloadKey]);

  const when = (value: string | null) => value
    ? fmtDubai(value, { locale: t("locale.dateLocale"), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";

  const run = async (action: () => Promise<{ ok: boolean; status: number; body: { error?: string; fields?: Record<string, string> } }>, onFields?: (f: Record<string, string>) => void) => {
    setBusy(true); setMessage("");
    const result = await action();
    setBusy(false);
    if (result.ok) { reload(); return true; }
    if (result.body.fields) onFields?.(result.body.fields);
    setMessage(errorText(t, "visits", result));
    return false;
  };

  const createPlan = async () => {
    if (!plan || !leadId) return;
    setPlanErrors({});
    const iso = dubaiLocalToIso(plan.planned_at);
    const body: Record<string, unknown> = { lead_id: leadId, planned_at: iso ?? plan.planned_at, purpose: plan.purpose };
    if (plan.location.trim()) body.location = plan.location;
    if (plan.person_to_meet.trim()) body.person_to_meet = plan.person_to_meet;
    if (plan.opportunity_id) body.opportunity_id = plan.opportunity_id;
    if (await run(() => callApi("/api/visits", { method: "POST", body: JSON.stringify(body) }), setPlanErrors)) setPlan(null);
  };

  const openReport = (v: Visit) => setReport({
    id: v.id,
    values: {
      actual_start: isoToDubaiLocal(v.actual_start), actual_finish: isoToDubaiLocal(v.actual_finish), result: v.result ?? "",
      next_action: v.next_action ?? "", next_followup_date: v.next_followup_date ?? "", evidence_link: v.evidence_link ?? "",
    },
  });

  const reportBody = (values: Record<string, string>) => ({
    actual_start: values.actual_start ? dubaiLocalToIso(values.actual_start) : null,
    actual_finish: values.actual_finish ? dubaiLocalToIso(values.actual_finish) : null,
    result: values.result, next_action: values.next_action,
    next_followup_date: values.next_followup_date || null, evidence_link: values.evidence_link,
  });

  const saveReport = async (submit: boolean) => {
    if (!report) return;
    setReportErrors({});
    const saved = await run(() => callApi(`/api/visits/${report.id}`, { method: "PATCH", body: JSON.stringify(reportBody(report.values)) }), setReportErrors);
    if (!saved) return;
    if (submit && await run(() => callApi(`/api/visits/${report.id}/submit`, { method: "POST", body: "{}" }))) setReport(null);
    if (!submit) setReport(null);
  };

  if (state === "loading") return <p className="text-xs text-muted-foreground">…</p>;
  if (state === "unavailable") return <p className="text-xs text-muted-foreground" data-testid="visits-unavailable">{t("visits.unavailable")}</p>;
  if (state === "error") return <p className="text-xs text-red-400">{t("visits.loadError")}</p>;

  const planField = (name: keyof typeof PLAN_EMPTY, label: string, input: React.ReactNode) => (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>{input}
      {planErrors[name] && <span className="block text-[11px] text-red-400">{fieldErrorText(t, "visits", planErrors[name])}</span>}
    </label>
  );

  return (
    <div className="space-y-2" data-testid="visit-panel">
      <div className="flex flex-wrap items-center gap-2">
        {!leadId && (
          <select aria-label={t("visits.title")} className={`${inputClass} w-44`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">{t("visits.allStatuses")}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`visits.status.${s}`)}</option>)}
          </select>
        )}
        {leadId && !plan && <button type="button" className={buttonClass} onClick={() => { setPlan({ ...PLAN_EMPTY }); setMessage(""); }}>{t("visits.plan")}</button>}
      </div>
      {rows && rows.length === 0 && <p className="text-xs text-muted-foreground">{t("visits.empty")}</p>}
      <ul className="space-y-1.5">
        {(rows ?? []).map((v) => (
          <li key={v.id} className="rounded-md border border-border px-2 py-1.5 text-xs" data-testid="visit-row">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">V{String(v.visit_no).padStart(4, "0")} · {when(v.planned_at)}</span>
              <span data-testid="visit-status" className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[v.status] ?? ""}`}>{t(`visits.status.${v.status}`)}</span>
            </div>
            <div className="mt-0.5">{v.purpose}</div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-muted-foreground">
              {!leadId && v.leads && <Link className="underline" href={`/leads/${v.lead_id}`}>{v.leads.customer_name ?? t("visits.openLead")}</Link>}
              {v.location && <span>{v.location}</span>}
              {v.person_to_meet && <span>{v.person_to_meet}</span>}
              {v.opportunity_name && <span>{v.opportunity_name}</span>}
              <span>{t(`visits.planApproval.${v.plan_approval}`)}</span>
              {!v.submitted_at && <span>{t("visits.reportDue")}: {when(v.report_due_at)}</span>}
              {v.submitted_at && <span>{t(`visits.reviewStatus.${v.review_status}`)}</span>}
            </div>
            {v.submitted_at && (
              <dl className="mt-1 space-y-0.5 rounded-md bg-muted/30 px-2 py-1" data-testid="visit-report-readonly">
                {([["visits.actualStart", when(v.actual_start)], ["visits.actualFinish", when(v.actual_finish)], ["visits.result", v.result],
                  ["visits.nextAction", v.next_action], ["visits.nextFollowup", v.next_followup_date]] as const).map(([label, value]) => (
                  <div key={label} className="flex gap-2"><dt className="shrink-0 text-muted-foreground">{t(label)}</dt><dd className="whitespace-pre-wrap break-words">{value || "—"}</dd></div>
                ))}
                <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">{t("visits.evidenceLink")}</dt>
                  <dd className="break-all">{v.evidence_link && /^https?:\/\//i.test(v.evidence_link)
                    ? <a className="underline" href={v.evidence_link} target="_blank" rel="noopener noreferrer">{v.evidence_link}</a> : v.evidence_link || "—"}</dd></div>
              </dl>
            )}
            {v.review_notes && v.review_status !== "pending" && <div className="mt-0.5 text-amber-300">{v.review_notes}</div>}
            <div className="mt-1 flex flex-wrap gap-2">
              {staff && !v.submitted_at && v.plan_approval !== "approved" && (
                <button type="button" className={buttonClass} disabled={busy} onClick={() => run(() => callApi(`/api/visits/${v.id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approved" }) }))}>{t("visits.approve")}</button>
              )}
              {staff && !v.submitted_at && v.plan_approval === "pending" && (
                <button type="button" className={buttonClass} disabled={busy} onClick={() => run(() => callApi(`/api/visits/${v.id}/approve`, { method: "POST", body: JSON.stringify({ decision: "rejected" }) }))}>{t("visits.reject")}</button>
              )}
              {(!v.submitted_at || v.review_status === "needs_fix") && v.plan_approval === "approved" && report?.id !== v.id && (
                <button type="button" className={buttonClass} onClick={() => openReport(v)}>{t("visits.report")}</button>
              )}
            </div>
            {report?.id === v.id && (
              <div className="mt-2 space-y-2 rounded-md border border-border p-2" data-testid="visit-report-form">
                {([["actual_start", "visits.actualStart", "datetime-local"], ["actual_finish", "visits.actualFinish", "datetime-local"]] as const).map(([key, label, type]) => (
                  <label key={key} className="block text-xs"><span className="text-muted-foreground">{t(label)}</span>
                    <input type={type} className={inputClass} value={report.values[key]} onChange={(e) => setReport({ ...report, values: { ...report.values, [key]: e.target.value } })} />
                    {reportErrors[key] && <span className="block text-[11px] text-red-400">{fieldErrorText(t, "visits", reportErrors[key])}</span>}
                  </label>
                ))}
                <label className="block text-xs"><span className="text-muted-foreground">{t("visits.result")}</span>
                  <textarea className={textareaClass} rows={3} maxLength={4000} value={report.values.result} onChange={(e) => setReport({ ...report, values: { ...report.values, result: e.target.value } })} />
                  {reportErrors.result && <span className="block text-[11px] text-red-400">{fieldErrorText(t, "visits", reportErrors.result)}</span>}
                </label>
                <label className="block text-xs"><span className="text-muted-foreground">{t("visits.nextAction")}</span>
                  <input className={inputClass} maxLength={2000} value={report.values.next_action} onChange={(e) => setReport({ ...report, values: { ...report.values, next_action: e.target.value } })} />
                </label>
                <label className="block text-xs"><span className="text-muted-foreground">{t("visits.nextFollowup")}</span>
                  <input type="date" min="2020-01-01" max="2100-12-31" className={inputClass} value={report.values.next_followup_date} onChange={(e) => setReport({ ...report, values: { ...report.values, next_followup_date: e.target.value } })} />
                </label>
                <label className="block text-xs"><span className="text-muted-foreground">{t("visits.evidenceLink")}</span>
                  <input className={inputClass} placeholder="https://" value={report.values.evidence_link} onChange={(e) => setReport({ ...report, values: { ...report.values, evidence_link: e.target.value } })} />
                  {reportErrors.evidence_link && <span className="block text-[11px] text-red-400">{fieldErrorText(t, "visits", reportErrors.evidence_link)}</span>}
                </label>
                <div className="flex gap-2">
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => saveReport(false)}>{t("visits.saveReport")}</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => saveReport(true)}>{t("visits.submit")}</button>
                  <button type="button" className={buttonClass} onClick={() => setReport(null)}>{t("visits.cancel")}</button>
                </div>
              </div>
            )}
            {staff && v.submitted_at && v.review_status !== "accepted" && (
              <div className="mt-2 space-y-1" data-testid="visit-review">
                <textarea className={textareaClass} rows={2} placeholder={t("visits.reviewNotes")} value={reviewNotes[v.id] ?? ""} onChange={(e) => setReviewNotes({ ...reviewNotes, [v.id]: e.target.value })} />
                <div className="flex gap-2">
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => run(() => callApi(`/api/visits/${v.id}/review`, { method: "POST", body: JSON.stringify({ decision: "accepted", notes: reviewNotes[v.id] ?? "" }) }))}>{t("visits.accept")}</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => run(() => callApi(`/api/visits/${v.id}/review`, { method: "POST", body: JSON.stringify({ decision: "needs_fix", notes: reviewNotes[v.id] ?? "" }) }))}>{t("visits.requestFix")}</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {plan && (
        <div className="space-y-2 rounded-md border border-border p-2" data-testid="visit-plan-form">
          {planField("planned_at", t("visits.plannedAt"), <input type="datetime-local" className={inputClass} value={plan.planned_at} onChange={(e) => setPlan({ ...plan, planned_at: e.target.value })} />)}
          {planField("location", t("visits.location"), <input className={inputClass} maxLength={300} value={plan.location} onChange={(e) => setPlan({ ...plan, location: e.target.value })} />)}
          {planField("person_to_meet", t("visits.personToMeet"), <input className={inputClass} maxLength={300} value={plan.person_to_meet} onChange={(e) => setPlan({ ...plan, person_to_meet: e.target.value })} />)}
          {planField("purpose", t("visits.purpose"), <textarea className={textareaClass} rows={2} maxLength={2000} value={plan.purpose} onChange={(e) => setPlan({ ...plan, purpose: e.target.value })} />)}
          {options.length > 0 && planField("opportunity_id", t("visits.opportunity"), (
            <select className={inputClass} value={plan.opportunity_id} onChange={(e) => setPlan({ ...plan, opportunity_id: e.target.value })}>
              <option value="">{t("visits.noOpportunity")}</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          ))}
          <div className="flex gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={createPlan}>{busy ? t("visits.saving") : t("visits.save")}</button>
            <button type="button" className={buttonClass} onClick={() => { setPlan(null); setPlanErrors({}); }}>{t("visits.cancel")}</button>
          </div>
        </div>
      )}
      {message && <p className="text-xs text-red-400" role="alert">{message}</p>}
    </div>
  );
}
