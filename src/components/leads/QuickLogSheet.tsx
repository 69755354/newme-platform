"use client";

// S42 (recheck §2-14, F19): the cockpit "Log" button and the analytics overdue list used the browser's
// prompt()/alert() and wrote a bare `activities` row. They now open the same "记一笔" quick log as the lead page
// (method + optional note) and post to /api/leads/:id/contacts, so the entry counts as a contact and a new lead
// becomes "contacted". One bottom sheet, mounted once per page, opened for whichever lead was tapped.

import { useState } from "react";
import { toast } from "sonner";
import { quickLogBody } from "@/lib/lead-actions.mjs";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export interface QuickLogTarget {
  leadId: string;
  customerName: string;
}

interface Props {
  target: QuickLogTarget | null;
  onClose: () => void;
  onLogged?: (leadId: string) => void | Promise<void>;
  t: (key: string) => string;
}

export default function QuickLogSheet({ target, onClose, onLogged, t }: Props) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const close = () => {
    if (saving) return;
    setNote("");
    onClose();
  };

  const log = async (method: string) => {
    if (!target || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/leads/${target.leadId}/contacts`, {
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
      onClose();
      if (onLogged) await onLogged(target.leadId);
    } catch {
      toast.error(t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={target !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl p-4 pb-6" data-testid="quick-log-sheet">
        <SheetHeader className="p-0 text-left">
          <SheetTitle>{t("s39.actions.quickLog")}</SheetTitle>
          <SheetDescription>{target?.customerName ?? ""}</SheetDescription>
        </SheetHeader>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={1000}
          placeholder={t("s39.quickLog.notePlaceholder")}
          aria-label={t("s39.quickLog.notePlaceholder")}
          className="h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
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
      </SheetContent>
    </Sheet>
  );
}
