"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ErrorState } from "@/components/ui/error-state";
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
import { ArrowLeft, Clock, CheckCircle2, XCircle, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { fmtDubai } from "@/lib/utils";
import {
  taskMutationMatchesReadback,
  TASK_FOLLOWUP_CONFLICT_CODE,
  type CanonicalTaskStatus,
  type TaskMutationExpectation,
} from "@/lib/task-followup-conflict";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

/* ─── Types ─── */
interface Task {
  id: string;
  lead_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  assignee_id: string | null;
  due_at: string;
  completed_at: string | null;
  created_at: string;
}

interface ProfileInfo {
  id: string;
  full_name: string | null;
}

/* ─── Constants ─── */
const STATUS_OPTIONS: ReadonlyArray<{
  value: CanonicalTaskStatus;
  label: string;
  icon: typeof Clock;
  color: string;
}> = [
  { value: "pending", label: "Pending", icon: Clock, color: "text-amber-400" },
  { value: "completed", label: "Done", icon: CheckCircle2, color: "text-emerald-400" },
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

interface TaskMutationPayload {
  data?: Task;
  error?: string;
  code?: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function futureDateTimeLocal(): string {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function isTaskStatus(value: string): value is CanonicalTaskStatus {
  return STATUS_OPTIONS.some((option) => option.value === value);
}

async function patchTask(taskId: string, body: TaskMutationExpectation) {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as TaskMutationPayload;
  return { response, payload };
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
  const [blockedMutation, setBlockedMutation] = useState<TaskMutationExpectation | null>(null);
  const [successorId, setSuccessorId] = useState("");
  const [successorTitle, setSuccessorTitle] = useState("Follow up");
  const [successorDueAt, setSuccessorDueAt] = useState(futureDateTimeLocal);

  /* ─── Fetch profiles and task from BFF API ─── */
  const fetchTask = useCallback(async () => {
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
        const err = await taskRes.json().catch(() => ({})) as { error?: string };
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
      setEditPriority(t.priority ?? "");
      setEditAssignedTo(t.assignee_id || "");
      setEditDueAt(formatDateForInput(t.due_at));
    } catch (err) {
      console.error("Failed to fetch task:", err);
      setError("Failed to load task. Please retry.");
    }
    setLoading(false);
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    const timer = window.setTimeout(() => {
      void fetchTask();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchTask, taskId]);

  /* ─── Save task ─── */
  const handleSave = async () => {
    if (!task) return;

    if (!editDueAt) {
      setSaveState("error");
      toast.error("Due date is required");
      return;
    }

    setSaveState("saving");

    try {
      const mutation = {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        priority: editPriority || null,
        assignee_id: editAssignedTo || null,
        due_at: new Date(editDueAt).toISOString(),
      } satisfies TaskMutationExpectation;
      const { response, payload } = await patchTask(task.id, mutation);
      if (!response.ok) {
        if (response.status === 409 && payload.code === TASK_FOLLOWUP_CONFLICT_CODE) {
          setBlockedMutation(mutation);
          setSuccessorId((current) => current || window.crypto.randomUUID());
        }
        throw new Error(payload.error || "Failed to save task");
      }
      if (!payload.data || payload.data.id !== task.id || !taskMutationMatchesReadback(payload.data, mutation)) {
        throw new Error("Task save readback failed");
      }

      setTask(payload.data);
      setSaveState("saved");
      toast.success("Task saved successfully");
    } catch (err: unknown) {
      console.error("Failed to save task:", err);
      setSaveState("error");
      toast.error(errorMessage(err, "Failed to save task"));
      return;
    }

    setTimeout(() => setSaveState("idle"), 2000);
  };

  /* ─── Change status ─── */
  const handleStatusChange = async (newStatus: string) => {
    if (!task || task.status === newStatus) return;

    setSaveState("saving");

    try {
      if (!isTaskStatus(newStatus)) {
        throw new Error("Invalid task status");
      }
      const mutation = { status: newStatus } satisfies TaskMutationExpectation;
      const { response, payload } = await patchTask(task.id, mutation);
      if (!response.ok) {
        if (response.status === 409 && payload.code === TASK_FOLLOWUP_CONFLICT_CODE) {
          setBlockedMutation(mutation);
          setSuccessorId((current) => current || window.crypto.randomUUID());
        }
        throw new Error(payload.error || "Failed to update task status");
      }
      if (!payload.data || payload.data.id !== task.id || !taskMutationMatchesReadback(payload.data, mutation)) {
        throw new Error("Task status readback failed");
      }

      setTask(payload.data);
      setBlockedMutation(null);
      setSaveState("saved");
      toast.success(`Status changed to ${newStatus.replace("_", " ")}`);
    } catch (err: unknown) {
      console.error("Failed to update status:", err);
      setSaveState("error");
      toast.error(errorMessage(err, "Failed to update status"));
      return;
    }

    setTimeout(() => setSaveState("idle"), 2000);
  };

  const handleCreateSuccessorAndRetry = async () => {
    if (!task?.lead_id || !blockedMutation) return;
    if (!successorTitle.trim() || !successorDueAt) {
      toast.error("Follow-up title and due date are required");
      return;
    }

    const taskId = successorId || window.crypto.randomUUID();
    setSuccessorId(taskId);
    setSaveState("saving");
    try {
      const createResponse = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: taskId,
          lead_id: task.lead_id,
          title: successorTitle.trim(),
          due_at: new Date(successorDueAt).toISOString(),
        }),
      });
      const created = await createResponse.json().catch(() => ({})) as TaskMutationPayload;
      if (!createResponse.ok || created.data?.id !== taskId || created.data.status !== "pending") {
        throw new Error(created.error || "Failed to create follow-up task");
      }

      const retry = await patchTask(task.id, blockedMutation);
      if (
        !retry.response.ok
        || retry.payload.data?.id !== task.id
        || !taskMutationMatchesReadback(retry.payload.data, blockedMutation)
      ) {
        throw new Error(retry.payload.error || "Follow-up was created, but the original update must be retried");
      }

      setTask(retry.payload.data);
      setBlockedMutation(null);
      setSuccessorId("");
      setSuccessorTitle("Follow up");
      setSuccessorDueAt(futureDateTimeLocal());
      setSaveState("saved");
      toast.success("Follow-up created and task updated");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch (err: unknown) {
      console.error("Failed to create successor task:", err);
      setSaveState("error");
      toast.error(errorMessage(err, "Failed to create follow-up task"));
    }
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

      {blockedMutation && (
        <Card className="border-amber-500/50">
          <CardHeader>
            <CardTitle className="text-base text-amber-300">A pending follow-up is required</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Create the next follow-up before applying this task update. The new task stays pending for this lead.
            </p>
            <div className="space-y-2">
              <Label htmlFor="successor_title">Next follow-up</Label>
              <Input
                id="successor_title"
                value={successorTitle}
                onChange={(event) => setSuccessorTitle(event.target.value)}
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="successor_due_at">Due date & time</Label>
              <Input
                id="successor_due_at"
                type="datetime-local"
                value={successorDueAt}
                onChange={(event) => setSuccessorDueAt(event.target.value)}
              />
            </div>
            <Button onClick={handleCreateSuccessorAndRetry} disabled={saveState === "saving"}>
              {saveState === "saving" && <Loader2 className="size-4 animate-spin" />}
              Create follow-up and retry
            </Button>
          </CardContent>
        </Card>
      )}

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
