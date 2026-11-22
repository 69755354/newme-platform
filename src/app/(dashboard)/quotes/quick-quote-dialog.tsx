"use client";

import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { saveQuoteViaServer } from "@/lib/quote-save-client";
import { logFetchFailure } from "@/lib/fetch-interruption";

interface QuickQuoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  onSaved?: () => void;
}

/** "Only the amount" quotation for one lead: no device list. Saved through the server route like every quotation. */
export default function QuickQuoteDialog({ open, onOpenChange, leadId, onSaved }: QuickQuoteDialogProps) {
  const { lang } = useLanguage();
  const zh = lang === "zh";
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const value = Number(amount.replace(/,/g, ""));
  const valid = Number.isFinite(value) && value > 0;

  const handleSave = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const saved = await saveQuoteViaServer({ lead_id: leadId, manual: { subtotal: value, currency: "AED" }, notes: notes.trim() || undefined }, lang);
      if (!saved.ok) { logFetchFailure("Quick quote error:", new Error(saved.message)); toast.error(saved.message); return; }
      void import("@/lib/notify")
        .then(({ notify }) => notify({ type: "quote_created", quote_id: saved.quoteId, lead_id: leadId, quote_no: saved.quoteNo }))
        .catch((notifyError) => logFetchFailure("quote_notification_failed", notifyError));
      toast.success(zh ? `报价已保存 #${saved.quoteNo}` : `Quotation saved #${saved.quoteNo}`);
      setAmount(""); setNotes("");
      onSaved?.();
      onOpenChange(false);
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{zh ? "只填金额报价" : "Quick quote (amount only)"}</DialogTitle>
          <DialogDescription>
            {zh ? "没有设备清单也可以：填写报给客户的总金额（AED）。会记入时间线，并把金额回传给 Meta。" : "No device list needed: enter the total you quoted the customer (AED). It is logged on the timeline and the amount is reported to Meta."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="quick-quote-amount" className="text-xs font-medium text-foreground mb-1.5 block">
              {zh ? "报价总金额 (AED)" : "Total quoted (AED)"} *
            </label>
            <Input id="quick-quote-amount" type="number" min="0" step="0.01" inputMode="decimal" value={amount}
              onChange={(e) => setAmount(e.target.value)} className="h-9" autoFocus />
          </div>
          <div>
            <label htmlFor="quick-quote-notes" className="text-xs font-medium text-foreground mb-1.5 block">{zh ? "备注（可选）" : "Note (optional)"}</label>
            <textarea id="quick-quote-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full min-h-[60px] rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none resize-none" />
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{zh ? "取消" : "Cancel"}</DialogClose>
          <Button onClick={handleSave} disabled={!valid || saving}>{saving ? (zh ? "保存中…" : "Saving…") : (zh ? "保存报价" : "Save quotation")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
