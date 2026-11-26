"use client";

// S43 (B13): leave cover. Admin / boss name a colleague who, for a date range, also receives the
// new-lead assignment notifications and reminders of a person on leave. Kept in its own component so the
// team page (reshaped by S41) only needs one mount line. Writes go through POST /api/team/leave-cover.

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { activeCoverId } from "@/lib/leave-cover-dates.mjs";

export interface LeaveCoverUser {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  is_active: boolean | null;
  cover_user_id?: string | null;
  cover_start?: string | null;
  cover_end?: string | null;
}

interface Props {
  users: LeaveCoverUser[];
  t: (key: string) => string;
  onSaved?: () => void;
}

export default function LeaveCoverPanel({ users, t, onSaved }: Props) {
  const [userId, setUserId] = useState("");
  const [coverId, setCoverId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/team/leave-cover", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { enabled?: boolean } | null) => { if (!cancelled && json) setEnabled(Boolean(json.enabled)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const active = useMemo(() => users.filter((u) => u.is_active !== false), [users]);
  const nameOf = (id: string | null | undefined) => {
    const u = users.find((x) => x.id === id);
    return u ? (u.full_name || u.email || id) : (id ?? "—");
  };
  const covers = useMemo(() => users.filter((u) => u.cover_user_id && u.cover_start && u.cover_end), [users]);

  const selected = users.find((u) => u.id === userId);
  // Choosing a person loads their current cover into the form (an event handler, not an effect).
  const choosePerson = (id: string) => {
    setUserId(id);
    const person = users.find((u) => u.id === id);
    setCoverId(person?.cover_user_id ?? "");
    setStart(person?.cover_start ?? "");
    setEnd(person?.cover_end ?? "");
  };

  const submit = async (clear: boolean) => {
    if (!userId) return;
    if (!clear) {
      if (!coverId) return;
      if (coverId === userId) { toast.error(t("s43.leaveCover.selfCover")); return; }
      if (!start || !end || end < start) { toast.error(t("s43.leaveCover.datesRequired")); return; }
    }
    setSaving(true);
    try {
      const res = await fetch("/api/team/leave-cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clear ? { userId, coverUserId: null } : { userId, coverUserId: coverId, start, end }),
      });
      if (!res.ok) throw new Error("failed");
      toast.success(clear ? t("s43.leaveCover.cleared") : t("s43.leaveCover.saved"));
      if (clear) { setCoverId(""); setStart(""); setEnd(""); }
      onSaved?.();
    } catch {
      toast.error(t("s43.leaveCover.failed"));
    } finally {
      setSaving(false);
    }
  };

  const selectClass = "w-full bg-muted border border-border text-foreground rounded-md h-9 px-2 text-sm";

  return (
    <section data-testid="leave-cover-panel" className="rounded-xl border border-border/50 bg-card/50 p-4 space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CalendarDays className="w-4 h-4 text-copper-700" />
          {t("s43.leaveCover.title")}
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">{t("s43.leaveCover.subtitle")}</p>
        {enabled === false && (
          <p data-testid="leave-cover-switch-off" className="text-xs text-amber-700 mt-1">{t("s43.leaveCover.switchOff")}</p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("s43.leaveCover.person")}</Label>
          <select aria-label={t("s43.leaveCover.person")} className={selectClass} value={userId} onChange={(e) => choosePerson(e.target.value)}>
            <option value="">{t("s43.leaveCover.choose")}</option>
            {active.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email || u.id}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("s43.leaveCover.cover")}</Label>
          <select aria-label={t("s43.leaveCover.cover")} className={selectClass} value={coverId} onChange={(e) => setCoverId(e.target.value)} disabled={!userId}>
            <option value="">{t("s43.leaveCover.choose")}</option>
            {active.filter((u) => u.id !== userId).map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email || u.id}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("s43.leaveCover.start")}</Label>
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={!userId} className="h-9 bg-muted border-border" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("s43.leaveCover.end")}</Label>
          <Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} disabled={!userId} className="h-9 bg-muted border-border" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="bg-copper-500 text-foreground hover:bg-copper-600" disabled={saving || !userId || !coverId} onClick={() => submit(false)}>
          {t("s43.leaveCover.save")}
        </Button>
        <Button size="sm" variant="outline" disabled={saving || !userId || !selected?.cover_user_id} onClick={() => submit(true)}>
          {t("s43.leaveCover.clear")}
        </Button>
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">{t("s43.leaveCover.current")}</p>
        {covers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("s43.leaveCover.none")}</p>
        ) : (
          <ul data-testid="leave-cover-list" className="space-y-1 text-xs">
            {covers.map((u) => {
              const now = activeCoverId(u) !== null;
              return (
                <li key={u.id} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium text-foreground">{u.full_name || u.email}</span>
                  <span className="text-muted-foreground">→ {nameOf(u.cover_user_id)}</span>
                  <span className="text-muted-foreground">{u.cover_start} – {u.cover_end}</span>
                  <span className={now ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-700" : "rounded-full bg-muted px-2 py-0.5 text-muted-foreground"}>
                    {now ? t("s43.leaveCover.activeNow") : t("s43.leaveCover.scheduled")}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
