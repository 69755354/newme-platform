"use client";

// S3 #6 — deactivating a member asks who takes over their leads (a named
// active colleague, or the unassigned admin queue) instead of silently handing
// them to the lowest-UUID user. It is also the second confirmation for the
// deactivation itself.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createClient } from "@/lib/supabase";
import { isLeadTransferCandidate } from "@/lib/lead-transfer-candidates.mjs";
import { UNASSIGNED_QUEUE } from "@/lib/member-lead-handover.mjs";

interface Member {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  is_active: boolean | null;
}

interface Props {
  /** Render with key={member.id} so each opening starts fresh. */
  member: { id: string; name: string };
  users: Member[];
  t: (key: string) => string;
  onCancel: () => void;
  /** Resolves true when the member was deactivated. */
  onConfirm: (memberId: string, transferTo: string, batchKey: string) => Promise<boolean>;
}

export default function MemberHandoverDialog({ member, users, t, onCancel, onConfirm }: Props) {
  const [transferTo, setTransferTo] = useState<string>("");
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per dialog opening, so a retry after a partial failure replays the
  // leads already moved instead of moving them again.
  const [batchKey] = useState<string>(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    void createClient()
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("assigned_to", member.id)
      .then(({ count }) => { if (!cancelled) setLeadCount(count ?? 0); });
    return () => { cancelled = true; };
  }, [member.id]);

  const candidates = useMemo(
    () => users.filter((u) => u.id !== member.id && isLeadTransferCandidate(u)),
    [users, member],
  );

  const submit = async () => {
    if (!transferTo || busy) return;
    setBusy(true);
    try {
      await onConfirm(member.id, transferTo, batchKey);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("leadFlow.team.handoverTitle")}</DialogTitle>
          <DialogDescription>
            {t("leadFlow.team.handoverDescription")
              .replace("{name}", member.name)
              .replace("{count}", leadCount === null ? "…" : String(leadCount))}
          </DialogDescription>
        </DialogHeader>
        <div className="py-3 space-y-2">
          <Label className="text-xs">{t("leadFlow.team.handoverTarget")}</Label>
          <Select value={transferTo} onValueChange={(value) => setTransferTo(value ?? "")}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("leadFlow.team.handoverChoose")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED_QUEUE}>{t("leadFlow.team.handoverUnassigned")}</SelectItem>
              {candidates.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.full_name || u.email || u.id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>{t("common.cancel")}</Button>
          <Button
            className="bg-rose-600 hover:bg-rose-700 text-white"
            onClick={submit}
            disabled={!transferTo || busy}
          >
            {busy ? t("common.loading") : t("leadFlow.team.handoverConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
