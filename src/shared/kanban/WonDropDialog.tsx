"use client";

import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type { WonPrompt } from "@/shared/hooks/usePipelineDragDrop";

interface WonDropDialogProps {
  prompt: WonPrompt | null;
  saving: boolean;
  onConfirm: (note: string, amount: string) => void;
  onCancel: () => void;
}

/** Shown when a lead is dropped on Won: the same note + deal amount the lead page asks for, sent through the same server route. */
export function WonDropDialog({ prompt, saving, onConfirm, onCancel }: WonDropDialogProps) {
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        {/* keyed by lead so a new drop starts with an empty form */}
        {prompt && <WonDropForm key={prompt.leadId} prompt={prompt} saving={saving} onConfirm={onConfirm} onCancel={onCancel} />}
      </DialogContent>
    </Dialog>
  );
}

function WonDropForm({ prompt, saving, onConfirm, onCancel }: Omit<WonDropDialogProps, "prompt"> & { prompt: WonPrompt }) {
  const { lang } = useLanguage();
  const zh = lang === "zh";
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const amountOk = Number(amount.replace(/,/g, "")) > 0;
  const canSave = !!note.trim() && (!prompt.needsAmount || amountOk) && !saving;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{zh ? "标记赢单" : "Mark as won"}{prompt.name ? ` · ${prompt.name}` : ""}</DialogTitle>
        <DialogDescription>
          {zh ? "赢单需要备注和成交金额；已有报价或合同时金额会自动带上。" : "A won deal needs a note and an amount; an existing quotation or contract supplies the amount."}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <label htmlFor="won-drop-note" className="text-xs font-medium text-foreground mb-1.5 block">{zh ? "备注（必填）" : "Note (required)"} *</label>
          <textarea id="won-drop-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} rows={2} autoFocus
            className="w-full min-h-[60px] rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none resize-none" />
        </div>
        {prompt.needsAmount && (
          <div>
            <label htmlFor="won-drop-amount" className="text-xs font-medium text-foreground mb-1.5 block">
              {zh ? "成交金额 AED（还没有报价或合同，必填）" : "Deal amount AED (required: no quotation or contract yet)"} *
            </label>
            <Input id="won-drop-amount" type="number" min="0" step="0.01" inputMode="decimal" value={amount}
              onChange={(e) => setAmount(e.target.value)} className="h-9" />
          </div>
        )}
        {prompt.error && <p role="alert" className="text-xs text-destructive">{prompt.error}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>{zh ? "取消" : "Cancel"}</Button>
        <Button onClick={() => onConfirm(note, amount)} disabled={!canSave}>{saving ? (zh ? "保存中…" : "Saving…") : (zh ? "确认赢单" : "Confirm won")}</Button>
      </DialogFooter>
    </>
  );
}
