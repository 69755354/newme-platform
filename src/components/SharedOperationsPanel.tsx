"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type RecordItem = Record<string, unknown>;
type Summary = {
  open_work_items: number;
  pending_approvals: number;
  unread_notifications: number;
  active_jobs: number;
  dead_letters: number;
};

async function loadData(path: string) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error("operations_load_failed");
  return response.json() as Promise<{ data: RecordItem[] | Summary | null }>;
}

export function SharedOperationsPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [workItems, setWorkItems] = useState<RecordItem[]>([]);
  const [approvals, setApprovals] = useState<RecordItem[]>([]);
  const [jobs, setJobs] = useState<RecordItem[]>([]);
  const [notifications, setNotifications] = useState<RecordItem[]>([]);
  const [timeline, setTimeline] = useState<RecordItem[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [summaryResult, work, approval, job, notification, event] = await Promise.all([
        loadData("/api/operations/summary"), loadData("/api/operations/work-items?limit=20"),
        loadData("/api/operations/approvals?limit=20"), loadData("/api/operations/jobs?limit=20"),
        loadData("/api/operations/notifications?limit=20"), loadData("/api/operations/timeline?limit=20"),
      ]);
      setSummary(summaryResult.data as Summary | null);
      setWorkItems((work.data as RecordItem[]) ?? []);
      setApprovals((approval.data as RecordItem[]) ?? []);
      setJobs((job.data as RecordItem[]) ?? []);
      setNotifications((notification.data as RecordItem[]) ?? []);
      setTimeline((event.data as RecordItem[]) ?? []);
      setError(null);
    } catch {
      setError("Select an active organization or ask an administrator for module access.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function createWorkItem(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const response = await fetch("/api/operations/work-items", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), priority: "normal", idempotency_key: crypto.randomUUID() }),
    });
    setBusy(false);
    if (!response.ok) return setError("Work item creation was rejected.");
    setTitle("");
    await refresh();
  }

  async function decide(id: string, decision: "approved" | "rejected") {
    setBusy(true);
    const response = await fetch(`/api/operations/approvals/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason_code: `operator_${decision}` }),
    });
    setBusy(false);
    if (!response.ok) return setError("Approval decision was rejected.");
    await refresh();
  }

  const cards: Array<[string, number]> = [
    ["Open work", summary?.open_work_items ?? 0],
    ["Pending approvals", summary?.pending_approvals ?? 0],
    ["Unread", summary?.unread_notifications ?? 0],
    ["Active jobs", summary?.active_jobs ?? 0],
    ["Dead letters", summary?.dead_letters ?? 0],
  ];

  return <section className="space-y-5" aria-labelledby="shared-operations-title">
    <div><h2 id="shared-operations-title" className="text-xl font-semibold">Shared operations</h2><p className="text-sm text-muted-foreground">Tenant-scoped tasks, approvals, notifications and durable jobs.</p></div>
    {error && <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</div>}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{cards.map(([label, value]) => <Card key={label}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="text-2xl font-semibold">{value}</p></CardContent></Card>)}</div>
    <div className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>Work items</CardTitle></CardHeader><CardContent className="space-y-3"><form onSubmit={createWorkItem} className="flex gap-2"><Input aria-label="Work item title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="Add a work item"/><Button disabled={busy || !title.trim()}>Add</Button></form>{workItems.map((item) => <div className="flex items-center justify-between border-b py-2 text-sm" key={String(item.id)}><span>{String(item.title)}</span><Badge variant="outline">{String(item.status)}</Badge></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>Approvals</CardTitle></CardHeader><CardContent className="space-y-3">{approvals.map((item) => <div className="border-b py-2 text-sm" key={String(item.id)}><div className="flex justify-between"><span>{String(item.action_key)}</span><Badge variant="outline">{String(item.status)}</Badge></div>{item.status === "pending" && <div className="mt-2 flex gap-2"><Button size="sm" disabled={busy} onClick={() => decide(String(item.id), "approved")}>Approve</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => decide(String(item.id), "rejected")}>Reject</Button></div>}</div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>Jobs</CardTitle></CardHeader><CardContent>{jobs.map((item) => <div className="flex justify-between border-b py-2 text-sm" key={String(item.id)}><span>{String(item.kind)}</span><Badge variant="outline">{String(item.state)}</Badge></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>Notifications</CardTitle></CardHeader><CardContent>{notifications.map((item) => <div className="flex justify-between border-b py-2 text-sm" key={String(item.id)}><span>{String(item.template_key)}</span><Badge variant="outline">{item.read_at ? "read" : "unread"}</Badge></div>)}</CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle>Immutable timeline</CardTitle></CardHeader><CardContent>{timeline.map((item) => <div className="flex justify-between border-b py-2 text-sm" key={String(item.id)}><span>{String(item.event_type)}</span><span className="text-muted-foreground">{String(item.created_at)}</span></div>)}</CardContent></Card>
  </section>;
}
