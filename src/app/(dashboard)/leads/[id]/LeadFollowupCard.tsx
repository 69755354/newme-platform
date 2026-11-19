"use client";

// Follow-up status of a WhatsApp lead (S21): first response, contacts in the first 5 working days, state,
// and the fields suggested from the customer's messages (a draft the owner confirms; nothing is written to
// the lead automatically). The labels Show room, FB and ins elsewhere on the page are not touched.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Activity } from "lucide-react";
import { fmtDubai } from "@/lib/utils";
import { durationParts } from "@/lib/whatsapp-ad-display.mjs";
import { followupStateTone, formatSuggestedValue } from "@/lib/followup-display.mjs";
import type { Lead } from "./types";

interface Props { lead: Lead; t: (key: string) => string }
interface FollowupPayload {
  has_conversation: boolean;
  state: null | {
    first_inbound_at: string | null; first_reply_at: string | null; first_response_minutes: number | null;
    contact_count_5wd: number; last_outbound_at: string | null; state: "normal" | "at_risk" | "overdue";
    state_since: string; abandon_risk: boolean;
  };
  fields: Array<{ field: string; value: string | number; confidence: number; source_message_id: string }>;
}

export default function LeadFollowupCard({ lead, t }: Props) {
  const [data, setData] = useState<FollowupPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const isWhatsApp = Boolean(lead.wa_first_inbound_at || lead.ctwa_clid || (lead.source_channel ?? "").startsWith("whatsapp"));

  useEffect(() => {
    if (!isWhatsApp) return;
    let cancelled = false;
    fetch(`/api/leads/${lead.id}/followup`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("followup_unavailable"))))
      .then((payload: FollowupPayload) => { if (!cancelled) setData(payload); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [isWhatsApp, lead.id]);

  if (!isWhatsApp || failed || !data || !data.has_conversation) return null;
  const when = (value: string | null | undefined) => value
    ? fmtDubai(value, { locale: t("locale.dateLocale"), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
  const state = data.state;
  const minutes = state?.first_response_minutes ?? null;
  const parts = minutes === null ? null : durationParts(minutes * 60);
  const duration = parts ? t(`whatsappAds.${parts.unit}`).replace("{n}", String(parts.n)) : t("followup.noReplyYet");
  const tone = followupStateTone(state?.state ?? "normal");

  const saveDraft = async () => {
    setSaving("saving");
    try {
      const response = await fetch(`/api/leads/${lead.id}/followup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_draft" }) });
      setSaving(response.ok ? "saved" : "error");
    } catch { setSaving("error"); }
  };

  return (
    <Card data-testid="followup-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4 text-copper-400" />
          {t("followup.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="followup-state" className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{t(`followup.state.${state?.state ?? "normal"}`)}</span>
          {state?.abandon_risk && <span data-testid="followup-abandon" className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400">{t("followup.abandonRisk")}</span>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t("followup.firstResponse")}</Label>
            <div className="mt-0.5 text-xs">{duration}</div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("followup.contacts5wd")}</Label>
            <div className="mt-0.5 text-xs">{state ? state.contact_count_5wd : "—"}</div>
          </div>
          <div className="col-span-2">
            <Label className="text-xs text-muted-foreground">{t("followup.lastOutbound")}</Label>
            <div className="mt-0.5 text-xs">{when(state?.last_outbound_at)}</div>
          </div>
        </div>
        {data.fields.length > 0 && (
          <div data-testid="followup-fields">
            <Label className="text-xs text-muted-foreground">{t("followup.suggestedFields")}</Label>
            <ul className="mt-1 space-y-0.5 text-xs">
              {data.fields.map((f) => (
                <li key={f.field}>{t(`followup.field.${f.field}`)}: <span className="font-medium">{formatSuggestedValue(f.field, f.value)}</span> <span className="text-muted-foreground">({Math.round(f.confidence * 100)}%)</span></li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("followup.draftHint")}</p>
            <button type="button" onClick={saveDraft} disabled={saving === "saving" || saving === "saved"}
              className="mt-1 inline-flex h-7 items-center rounded-md border border-border px-2 text-xs hover:bg-muted disabled:opacity-60">
              {saving === "saved" ? t("followup.draftSaved") : saving === "error" ? t("followup.draftError") : t("followup.saveDraft")}
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
