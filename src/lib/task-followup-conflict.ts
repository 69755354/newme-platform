export const TASK_FOLLOWUP_CONFLICT_CODE = "NEXT_FOLLOWUP_REQUIRED";

export const TASK_FOLLOWUP_CONFLICT_MESSAGE =
  "Create another pending follow-up task before completing or cancelling the final task.";

interface PostgrestErrorLike {
  code?: string | null;
  message?: string | null;
}

export type CanonicalTaskStatus = "pending" | "completed" | "cancelled";

export interface TaskMutationExpectation {
  status?: CanonicalTaskStatus;
  title?: string;
  description?: string | null;
  priority?: string | null;
  assignee_id?: string | null;
  due_at?: string;
}

interface TaskMutationReadback {
  status: string;
  title: string;
  description: string | null;
  priority: string | null;
  assignee_id: string | null;
  due_at: string;
  completed_at: string | null;
}

export interface TaskFollowupConflictResponse {
  status: 409;
  body: {
    error: typeof TASK_FOLLOWUP_CONFLICT_MESSAGE;
    code: typeof TASK_FOLLOWUP_CONFLICT_CODE;
  };
}

/**
 * The live database requires every active lead to retain a next follow-up.
 * Match the exact Postgres contract so unrelated P0001 errors remain 500s.
 */
export function isTaskFollowupConflict(error: PostgrestErrorLike | null | undefined): boolean {
  return error?.code === "P0001" && error.message === "Next follow-up date is required";
}

export function taskFollowupConflictResponse(
  error: PostgrestErrorLike | null | undefined,
): TaskFollowupConflictResponse | null {
  if (!isTaskFollowupConflict(error)) return null;
  return {
    status: 409,
    body: {
      error: TASK_FOLLOWUP_CONFLICT_MESSAGE,
      code: TASK_FOLLOWUP_CONFLICT_CODE,
    },
  };
}

export function taskMutationMatchesReadback(
  task: TaskMutationReadback,
  expected: TaskMutationExpectation,
): boolean {
  if (expected.status !== undefined) {
    if (task.status !== expected.status) return false;
    if (expected.status === "completed") {
      if (typeof task.completed_at !== "string" || Number.isNaN(new Date(task.completed_at).getTime())) return false;
    } else if (task.completed_at !== null) {
      return false;
    }
  }
  if (expected.title !== undefined && task.title !== expected.title) return false;
  if (expected.description !== undefined && task.description !== expected.description) return false;
  if (expected.priority !== undefined && task.priority !== expected.priority) return false;
  if (expected.assignee_id !== undefined && task.assignee_id !== expected.assignee_id) return false;
  if (expected.due_at !== undefined) {
    const actualDue = new Date(task.due_at).getTime();
    const expectedDue = new Date(expected.due_at).getTime();
    if (Number.isNaN(actualDue) || Number.isNaN(expectedDue) || actualDue !== expectedDue) return false;
  }
  return true;
}
