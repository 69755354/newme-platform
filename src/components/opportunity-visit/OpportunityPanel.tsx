"use client";

// Opportunities (S23). With a leadId it is the lead page card (list and create form); without one it is the
// /opportunities list across the leads the signed-in user may see. The interface labels Show room, FB and ins
// are not touched here.
import { useEffect, useState } from "react";
import Link from "next/link";
import { fmtDubai } from "@/lib/utils";
import { buttonClass, callApi, errorText, fieldErrorText, inputClass, textareaClass, type Translate } from "./shared";

interface Stage { key: string; label_en: string; label_zh: string; requires_quote: boolean; active: boolean }
interface Opportunity {
  id: string; opp_no: number; lead_id: string; name: string; confirmed_requirement: string; stage: string;
  quote_amount_aed: number | string | null; decision_target: string | null; quotation_link: string | null;
  leads?: { id: string; customer_name: string | null } | null;
}
interface Props { t: Translate; lang: string; leadId?: string }
const EMPTY = { name: "", confirmed_requirement: "", stage: "new", quote_amount_aed: "", decision_target: "", quotation_link: "" };

export default function OpportunityPanel({ t, lang, leadId }: Props) {
  const [rows, setRows] = useState<Opportunity[] | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [stageFilter, setStageFilter] = useState("");
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ limit: "100" });
    if (leadId) query.set("lead_id", leadId);
    if (stageFilter) query.set("stage", stageFilter);
    callApi<{ data: Opportunity[]; stages: Stage[] }>(`/api/opportunities?${query}`).then((result) => {
      if (cancelled) return;
      if (result.status === 503) { setState("unavailable"); return; }
      if (!result.ok) { setState("error"); return; }
      setRows(result.body.data ?? []);
      setStages(result.body.stages ?? []);
      setState("ready");
    });
    return () => { cancelled = true; };
  }, [leadId, stageFilter, reloadKey]);

  const stageLabel = (key: string) => {
    const stage = stages.find((s) => s.key === key);
    return stage ? (lang === "zh" ? stage.label_zh : stage.label_en) : key;
  };
  const chosen = stages.find((s) => s.key === form?.stage);

  const save = async () => {
    if (!form || !leadId) return;
    setSaving(true); setFieldErrors({}); setMessage("");
    const body: Record<string, unknown> = { lead_id: leadId, name: form.name, confirmed_requirement: form.confirmed_requirement, stage: form.stage };
    if (form.quote_amount_aed.trim()) body.quote_amount_aed = form.quote_amount_aed.trim();
    if (form.decision_target) body.decision_target = form.decision_target;
    if (form.quotation_link.trim()) body.quotation_link = form.quotation_link.trim();
    const result = await callApi("/api/opportunities", { method: "POST", body: JSON.stringify(body) });
    setSaving(false);
    if (result.ok) { setForm(null); reload(); return; }
    if (result.body.fields) setFieldErrors(result.body.fields);
    setMessage(errorText(t, "opportunities", result));
  };

  const archive = async (id: string) => {
    const result = await callApi(`/api/opportunities/${id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
    if (result.ok) reload(); else setMessage(errorText(t, "opportunities", result));
  };

  if (state === "loading") return <p className="text-xs text-muted-foreground">…</p>;
  if (state === "unavailable") return <p className="text-xs text-muted-foreground" data-testid="opportunities-unavailable">{t("opportunities.unavailable")}</p>;
  if (state === "error") return <p className="text-xs text-red-700">{t("opportunities.loadError")}</p>;

  const field = (name: keyof typeof EMPTY, label: string, input: React.ReactNode) => (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      {input}
      {fieldErrors[name] && <span className="block text-xs text-red-700">{fieldErrorText(t, "opportunities", fieldErrors[name])}</span>}
    </label>
  );

  return (
    <div className="space-y-2" data-testid="opportunity-panel">
      <div className="flex flex-wrap items-center gap-2">
        {!leadId && (
          <select aria-label={t("opportunities.stage")} className={`${inputClass} w-44`} value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
            <option value="">{t("opportunities.allStages")}</option>
            {stages.map((s) => <option key={s.key} value={s.key}>{stageLabel(s.key)}</option>)}
          </select>
        )}
        {leadId && !form && <button type="button" className={buttonClass} onClick={() => { setForm({ ...EMPTY }); setMessage(""); }}>{t("opportunities.add")}</button>}
      </div>
      {rows && rows.length === 0 && <p className="text-xs text-muted-foreground">{t("opportunities.empty")}</p>}
      <ul className="space-y-1.5">
        {(rows ?? []).map((o) => (
          <li key={o.id} className="rounded-md border border-border px-2 py-1.5 text-xs" data-testid="opportunity-row">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">O{String(o.opp_no).padStart(4, "0")} · {o.name}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{stageLabel(o.stage)}</span>
            </div>
            <div className="mt-0.5 text-muted-foreground">{o.confirmed_requirement}</div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-muted-foreground">
              {!leadId && o.leads && <Link className="underline" href={`/leads/${o.lead_id}`}>{o.leads.customer_name ?? t("opportunities.openLead")}</Link>}
              {o.quote_amount_aed !== null && <span>AED {Number(o.quote_amount_aed).toLocaleString("en-US")}</span>}
              {o.decision_target && <span>{fmtDubai(o.decision_target, { locale: t("locale.dateLocale") })}</span>}
              {o.quotation_link && <a className="underline" href={o.quotation_link} target="_blank" rel="noopener noreferrer">{t("opportunities.quotationLink")}</a>}
              {leadId && <button type="button" className="underline" onClick={() => archive(o.id)}>{t("opportunities.archive")}</button>}
            </div>
          </li>
        ))}
      </ul>
      {form && (
        <div className="space-y-2 rounded-md border border-border p-2" data-testid="opportunity-form">
          {field("name", t("opportunities.name"), <input className={inputClass} value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} />)}
          {field("confirmed_requirement", t("opportunities.requirement"), <textarea className={textareaClass} rows={2} maxLength={4000} value={form.confirmed_requirement} onChange={(e) => setForm({ ...form, confirmed_requirement: e.target.value })} />)}
          {field("stage", t("opportunities.stage"), (
            <select className={inputClass} value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
              {stages.filter((s) => s.active).map((s) => <option key={s.key} value={s.key}>{stageLabel(s.key)}</option>)}
            </select>
          ))}
          {chosen?.requires_quote && <p className="text-xs text-amber-700">{t("opportunities.quoteHint")}</p>}
          {field("quote_amount_aed", t("opportunities.amount"), <input className={inputClass} inputMode="decimal" value={form.quote_amount_aed} onChange={(e) => setForm({ ...form, quote_amount_aed: e.target.value })} />)}
          {field("decision_target", t("opportunities.decisionTarget"), <input type="date" min="2020-01-01" max="2100-12-31" className={inputClass} value={form.decision_target} onChange={(e) => setForm({ ...form, decision_target: e.target.value })} />)}
          {field("quotation_link", t("opportunities.quotationLink"), <input className={inputClass} placeholder="https://" value={form.quotation_link} onChange={(e) => setForm({ ...form, quotation_link: e.target.value })} />)}
          <div className="flex gap-2">
            <button type="button" className={buttonClass} disabled={saving} onClick={save}>{saving ? t("opportunities.saving") : t("opportunities.save")}</button>
            <button type="button" className={buttonClass} onClick={() => { setForm(null); setFieldErrors({}); setMessage(""); }}>{t("opportunities.cancel")}</button>
          </div>
        </div>
      )}
      {message && <p className="text-xs text-red-700" role="alert">{message}</p>}
    </div>
  );
}
