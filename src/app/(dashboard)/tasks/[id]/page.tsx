"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ErrorState } from "@/components/ui/error-state";
import { updateTask, updateTaskStatus } from "@/app/actions/tasks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Calendar, Clock, User, CheckCircle2, XCircle, Loader2, Save, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { fmtDubai } from "@/lib/utils";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

/* ─── Types ─── */
interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigned_to: string | null;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProfileInfo {
  id: string;
  full_name: string | null;
}

/* ─── Constants ─── */
const STATUS_OPTIONS = [
  { value: "pending", label: "Pending", icon: Clock, color: "text-amber-400" },
  { value: "in_progress", label: "In Progress", icon: Loader2, color: "text-blue-400" },
  { value: "done", label: "Done", icon: CheckCircle2, color: "text-emerald-400" },
  { value: "cancelled", label: "Cancelled", icon: XCircle, color: "text-muted-foreground" },
];

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low", color: "bg-slate-500/10 text-slate-400" },
  { value: "medium", label: "Medium", color: "bg-blue-500/10 text-blue-400" },
  { value: "high", label: "High", color: "bg-orange-500/10 text-orange-400" },
  { value: "urgent", label: "Urgent", color: "bg-rose-500/10 text-rose-400" },
];

/* ─── Helpers ─── */
function formatDateTime(d: string | null): string {
  if (!d) return "—";
  return fmtDubai(new Date(d), { locale: "en-US", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDateForInput(d: string | null): string {
  if (!d) return "";
  const date = new Date(d);
  return date.toISOString().slice(0, 16);
}

/* ─── Component ─── */
export default function TaskDetailPage() {
  const params = useParams();
  const taskId = params.id as string;

  const [task, setTask] = useState<Task | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit form state
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState("");
  const [editAssignedTo, setEditAssignedTo] = useState("");
  const [editDueAt, setEditDueAt] = useState("");

  // Save state
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Profile name lookup
  const profileNameMap: Record<string, string> = {};
  profiles.forEach((p) => {
    if (p.id && p.full_name) profileNameMap[p.id] = p.full_name;
  });

  /* ─── Fetch profiles and task from BFF API ─── */
  const fetchTask = async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch profiles from BFF
      const profilesRes = await fetch("/api/tasks/list?page=0");
      if (profilesRes.ok) {
        const json = await profilesRes.json();
        setProfiles((json.profiles ?? []) as ProfileInfo[]);
      }

      // Fetch single task detail
      const taskRes = await fetch(`/api/tasks/${taskId}`);
      if (!taskRes.ok) {
        const err = await taskRes.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load task");
      }

      const taskJson = await taskRes.json();
      const t = taskJson.data as Task;

      if (!t) {
        setError("Task not found");
        setLoading(false);
        return;
      }

      setTask(t);
      setEditTitle(t.title);
      setEditDescription(t.description || "");
      setEditPriority(t.priority);
      setEditAssignedTo(t.assigned_to || "");
      setEditDueAt(formatDateForInput(t.due_at));
    } catch (err) {
      console.error("Failed to fetch task:", err);
      setError("Failed to load task. Please retry.");
    }
    setLoading(false);
  };

  useEffect(() => {
    if (taskId) fetchTask();
  }, [taskId]);

  /* ─── Save task ─── */
  const handleSave = async () => {
    if (!task) return;

    setSaveState("saving");

    try {
      await updateTask(task.id, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        priority: editPriority,
        assigned_to: editAssignedTo || null,
        due_at: editDueAt ? new Date(editDueAt).toISOString() : null,
      });

      setSaveState("saved");
      toast.success("Task saved successfully");
    } catch (err: any) {
      console.error("Failed to save task:", err);
      setSaveState("error");
      toast.error(err.message || "Failed to save task");
      return;
    }

    // Refresh task data
    await fetchTask();

    setTimeout(() => setSaveState("idle"), 2000);
  };

  /* ─── Change status ─── */
  const handleStatusChange = async (newStatus: string) => {
    if (!task || task.status === newStatus) return;

    setSaveState("saving");

    try {
      await updateTaskStatus(task.id, newStatus);

      setSaveState("saved");
      toast.success(`Status changed to ${newStatus.replace("_", " ")}`);
    } catch (err: any) {
      console.error("Failed to update status:", err);
      setSaveState("error");
      toast.error(err.message || "Failed to update status");
      return;
    }

    await fetchTask();

    setTimeout(() => setSaveState("idle"), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="p-4">
        <ErrorState message={error || "Task not found"} onRetry={fetchTask} />
      </div>
    );
  }

  const currentStatus = STATUS_OPTIONS.find((s) => s.value === task.status);
  const StatusIcon = currentStatus?.icon || Clock;

  return (
    <DashboardScrollContainer className="space-y-4 p-4 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            window.location.href = "/tasks";
          }}
        >
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <h1 className="text-xl font-semibold flex-1">Task Details</h1>
        <Button
          onClick={handleSave}
          disabled={saveState === "saving"}
        >
          {saveState === "saving" ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Saving...
            </>
          ) : saveState === "saved" ? (
            <>
              <CheckCircle2 className="size-4" />
              Saved
            </>
          ) : (
            <>
              <Save className="size-4" />
              Save
            </>
          )}
        </Button>
      </div>

      {/* Status display */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <StatusIcon className={`size-5 ${currentStatus?.color || "text-muted-foreground"}`} />
            <span className={currentStatus?.color || ""}>
              {task.status.replace("_", " ").toUpperCase()}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Created:</span>
              <span className="ml-2">{formatDateTime(task.created_at)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Updated:</span>
              <span className="ml-2">{formatDateTime(task.updated_at)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Due:</span>
              <span className="ml-2">{formatDateTime(task.due_at)}</span>
            </div>
            {task.completed_at && (
              <div>
                <span className="text-muted-foreground">Completed:</span>
                <span className="ml-2">{formatDateTime(task.completed_at)}</span>
              </div>
            )}
          </div>

          {/* Status change buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <span className="text-sm text-muted-foreground self-center">Change status:</span>
            {STATUS_OPTIONS.map((s) => {
              const Icon = s.icon;
              return (
                <Button
                  key={s.value}
                  variant={task.status === s.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => handleStatusChange(s.value)}
                  disabled={task.status === s.value || saveState === "saving"}
                >
                  <Icon className="size-3.5" />
                  {s.label}
                </Button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Edit form */}
      <Card>
        <CardHeader>
          <CardTitle>Edit Task</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Task title"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="Task description (optional)"
              rows={4}
            />
          </div>

          {/* Priority */}
          <div className="space-y-2">
            <Label>Priority</Label>
            <Select value={editPriority} onValueChange={(v) => setEditPriority(v ?? '')}>
              <SelectTrigger>
                <SelectValue placeholder="Select priority" />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${p.color}`}>
                      {p.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Assigned To */}
          <div className="space-y-2">
            <Label>Assigned To</Label>
            <Select value={editAssignedTo || "unassigned"} onValueChange={(v) => setEditAssignedTo((v ?? '') === "unassigned" ? "" : (v ?? ''))}>
              <SelectTrigger>
                <SelectValue placeholder="Select assignee" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.full_name || p.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Due Date */}
          <div className="space-y-2">
            <Label htmlFor="due_at">Due Date & Time</Label>
            <Input
              id="due_at"
              type="datetime-local"
              value={editDueAt}
              onChange={(e) => setEditDueAt(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>
    </DashboardScrollContainer>
  );
}
