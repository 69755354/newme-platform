"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, CheckCircle2, Clock, XCircle, Loader2, AlertTriangle, Calendar } from "lucide-react";
import { fmtDubai } from "@/lib/utils";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

/* ─── Constants ─── */
const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  pending: { bg: "bg-amber-500/10", text: "text-amber-400", icon: <Clock className="size-3" /> },
  in_progress: { bg: "bg-blue-500/10", text: "text-blue-400", icon: <Loader2 className="size-3 animate-spin" /> },
  done: { bg: "bg-emerald-500/10", text: "text-emerald-400", icon: <CheckCircle2 className="size-3" /> },
  cancelled: { bg: "bg-gray-500/10", text: "text-muted-foreground", icon: <XCircle className="size-3" /> },
};

const PRIORITY_STYLES: Record<string, string> = {
  low: "bg-slate-500/10 text-slate-400",
  medium: "bg-blue-500/10 text-blue-400",
  high: "bg-orange-500/10 text-orange-400",
  urgent: "bg-rose-500/10 text-rose-400",
};

/* ─── Types ─── */
interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProfileInfo {
  id: string;
  full_name: string | null;
}

/* ─── Helpers ─── */
function formatDate(d: string | null): string {
  if (!d) return "—";
  return fmtDubai(new Date(d), { locale: "en-US", month: "short", day: "numeric", year: "numeric" });
}

function isOverdue(dueAt: string | null, status: string): boolean {
  if (!dueAt || status === "done" || status === "cancelled") return false;
  return new Date(dueAt) < new Date();
}

/* ─── Component ─── */
export default function TasksPage() {
  const supabase = createClient();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);

  // Filters
  const [statusFilter, setStatusFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");

  // Profile name lookup
  const profileNameMap: Record<string, string> = {};
  profiles.forEach((p) => {
    if (p.id && p.full_name) profileNameMap[p.id] = p.full_name;
  });

  /* ─── Fetch profiles for assignee filter ─── */
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name")
        .order("full_name");
      if (data) setProfiles(data as ProfileInfo[]);
    })();
  }, []);

  /* ─── Fetch tasks ─── */
  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);

    let q = supabase
      .from("tasks")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (statusFilter !== "all") {
      q = q.eq("status", statusFilter);
    }
    if (assigneeFilter !== "all") {
      q = q.eq("assigned_to", assigneeFilter);
    }

    const { data, error: err, count } = await q;

    if (err) {
      console.error("Failed to fetch tasks:", err);
      setError("Failed to load tasks. Please retry.");
      setLoading(false);
      return;
    }

    if (data) setTasks(data as Task[]);
    setTotalCount(count ?? 0);
    setLoading(false);
  }, [page, statusFilter, assigneeFilter]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [statusFilter, assigneeFilter]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    // T3-1: tasks 根容器 = <DashboardScrollContainer className="space-y-4 p-4">
    // → 走外层 viewport 滚动模式（与 payments / quotations 一致）。
    // sticky 元素 (page-title z-20) 直接锚定到 viewport 顶部。
    // tasks 没有批量选择功能 → 无 bulk-bar；filter 状态/Assignee 行不 sticky。
    // z-index 约定: page-title z-20 / dialog z-40 (z-modal) / toast z-50 (z-toast)
    <DashboardScrollContainer className="space-y-4 p-4">
      {/* ─── Header (page-title sticky) ───
          T2-4: 锚定功能卡片 — 整页滚动时标题永远可见。
          z-index 约定: page-title z-20 / dialog z-40 (z-modal) / toast z-50 (z-toast) */}
      <div
        data-sticky-region="page-title"
        className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b -mx-4 px-4 py-2"
      >
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Tasks</h1>
          <span className="text-sm text-muted-foreground">{totalCount} total</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Status filter */}
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? '')}>
          <SelectTrigger>
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Assignee filter */}
        <Select value={assigneeFilter} onValueChange={(v) => setAssigneeFilter(v ?? '')}>
          <SelectTrigger>
            <SelectValue placeholder="All Assignees" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Assignees</SelectItem>
            {profiles.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.full_name || p.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Error State */}
      {error && <ErrorState message={error} onRetry={fetchTasks} />}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Table */}
      {!loading && !error && (
        <Card>
          <CardContent className="p-0">
            {tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <AlertTriangle className="size-6 mb-2" />
                <p className="text-sm">No tasks found</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Assigned To</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Priority</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map((task) => {
                    const s = STATUS_STYLES[task.status] || STATUS_STYLES.pending;
                    const overdue = isOverdue(task.due_at, task.status);
                    return (
                      <TableRow
                        key={task.id}
                        className="cursor-pointer"
                        onClick={() => {
                          window.location.href = `/tasks/${task.id}`;
                        }}
                      >
                        <TableCell className="font-medium max-w-[280px] truncate">
                          {task.title}
                        </TableCell>
                        <TableCell>
                          {task.assigned_to
                            ? profileNameMap[task.assigned_to] || task.assigned_to.slice(0, 8)
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <span className={overdue ? "text-rose-400 font-medium" : ""}>
                            {overdue && <AlertTriangle className="size-3 inline mr-1" />}
                            {formatDate(task.due_at)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.bg} ${s.text}`}
                          >
                            {s.icon}
                            {task.status.replace("_", " ")}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[task.priority] || PRIORITY_STYLES.medium}`}
                          >
                            {task.priority}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <span className="text-sm text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="size-4" />
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* T2-4: z-modal z-40 / z-toast z-50 层级约定 — 此页无 Dialog / Toaster
          后续若添加：<Dialog ... /> 用 z-40；<Toaster position="top-center" richColors /> 用 z-50。
          page-title 在此文件顶部已锚 z-20。 */}
    </DashboardScrollContainer>
  );
}
