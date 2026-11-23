"use client";

// S39: the three big actions at the top of a lead: Call (tel:), WhatsApp (wa.me with the greeting already typed, in the
// customer's language, with the salesperson's name) and "记一笔" (quick log: one tap on the method + an optional note;
// it counts as the contact, and a new lead becomes "contacted").

import { useState } from "react";
import { MessageCircle, NotebookPen, Phone } from "lucide-react";
import { toast } from "sonner";
import { telHref } from "@/lib/lead-contact.mjs";
import { quickLogBody, whatsappLinkWithGreeting } from "@/lib/lead-actions.mjs";
import type { Lead } from "./types";

interface Props {
  lead: Lead;
  repName: string | null;
  canLog: boolean;
  onLogged: () => void | Promise<void>;
  t: (key: string) => string;
}

const BIG = "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-sm font-semibold transition-colors";

export default function LeadActionBar({ lead, repName, canLog, onLogged, t }: Props) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const tel = telHref(lead.phone);
  const wa = whatsappLinkWithGreeting(lead, repName);

  const log = async (method: string) => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/leads/${lead.id}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(quickLogBody(method, note)),
      });
      if (!response.ok) {
        toast.error(t("common.saveFailed"));
        return;
      }
      toast.success(t("s39.quickLog.saved"));
      setNote("");
      setOpen(false);
      await onLogged();
    } catch {
      toast.error(t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="lead-action-bar" aria-label={t("s39.actions.title")} className="space-y-2 rounded-xl border border-border bg-card p-2 shadow-sm">
      <div className="flex gap-2">
        {tel ? (
          <a data-testid="action-call" href={tel} className={`${BIG} border-copper-500/40 bg-copper-500/10 text-copper-400 hover:bg-copper-500/20`}>
            <Phone className="h-5 w-5" />{t("s39.actions.call")}
          </a>
        ) : (
          <span data-testid="action-call" aria-disabled="true" className={`${BIG} border-border text-muted-foreground opacity-50`}>
            <Phone className="h-5 w-5" />{t("s39.actions.call")}
          </span>
        )}
        {wa ? (
          <a data-testid="action-whatsapp" href={wa} target="_blank" rel="noopener noreferrer" className={`${BIG} border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20`}>
            <MessageCircle className="h-5 w-5" />WhatsApp
          </a>
        ) : (
          <span data-testid="action-whatsapp" aria-disabled="true" className={`${BIG} border-border text-muted-foreground opacity-50`}>
            <MessageCircle className="h-5 w-5" />WhatsApp
          </span>
        )}
        {canLog && (
          <button type="button" data-testid="action-quick-log" aria-expanded={open} onClick={() => setOpen((v) => !v)}
            className={`${BIG} border-border bg-muted/40 text-foreground hover:bg-muted`}>
            <NotebookPen className="h-5 w-5" />{t("s39.actions.quickLog")}
          </button>
        )}
      </div>
      {open && canLog && (
        <div data-testid="quick-log-panel" className="space-y-2 rounded-lg bg-muted/30 p-2">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={1000}
            placeholder={t("s39.quickLog.notePlaceholder")}
            aria-label={t("s39.quickLog.notePlaceholder")}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          />
          <div className="flex gap-2">
            {(["phone", "whatsapp", "other"] as const).map((method) => (
              <button key={method} type="button" data-testid={`quick-log-${method}`} disabled={saving} onClick={() => void log(method)}
                className="min-h-11 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
                {saving ? "…" : t(`s39.quickLog.method.${method}`)}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("s39.quickLog.hint")}</p>
        </div>
      )}
    </section>
  );
}
