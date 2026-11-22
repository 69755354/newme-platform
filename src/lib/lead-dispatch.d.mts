export type DispatchStatus = "missing_intake_data" | "review_phone" | "duplicate_review" | "unassigned" | "delivered" | "duplicate_not_dispatched" | "excluded_test";
export type DuplicateDecision = "merged" | "kept_separate" | "invalid";
export type DecisionAction = "confirm_phone" | "release_missing" | "revoke_release" | "mark_test" | "unmark_test" | "note" | "reevaluate";
export const STAFF_ROLES: ReadonlySet<string>;
export const DISPATCH_STATUSES: readonly DispatchStatus[];
export const ATTENTION_STATUSES: readonly DispatchStatus[];
export const DUPLICATE_DECISIONS: readonly DuplicateDecision[];
export const DECISION_ACTIONS: readonly DecisionAction[];
export const SWEEP_WINDOW_DAYS: number;
export function isUuid(value: unknown): value is string;
export function canDecide(role: string | null | undefined): boolean;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };
export function parseDecideInput(input: unknown): ParseResult<{ action: DecisionAction; reason: string | null }>;
export function parseResolveInput(input: unknown): ParseResult<{ decision: DuplicateDecision; notes: string | null }>;
export function parseReopenInput(input: unknown): ParseResult<{ reason: string }>;
export function allowedActions(row: { status?: string | null; phone_flag?: string | null; missing_fields?: string[] | null; release_reason?: string | null } | null | undefined): DecisionAction[];
export function sweepWindowStart(now?: string | number | Date): string;
export function mapDbError(error: { code?: string; message?: string } | null | undefined): { status: number; code: string };
export function canAssignFromQueue(row: { status?: string; lead?: { assigned_to?: string | null } | null } | null | undefined): boolean;
export function buildQueueAssignRequest(
  row: { lead_id: string; status?: string; lead?: { assigned_to?: string | null; updated_at?: string | null } | null },
  assigneeId: string, idempotencyKey: string,
): { url: string; body: { assignedTo: string; expectedUpdatedAt: string | null; idempotencyKey: string; reason: string } } | null;
