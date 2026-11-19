export const STAFF_ROLES: ReadonlySet<string>;
export function isUuid(value: unknown): value is string;
export function canWorkOnLead(role: string | undefined, userId: string | undefined, lead: { assigned_to?: string | null } | null | undefined): boolean;
export function canReviewVisits(role: string | undefined): boolean;
export function nextWorkingDay0930(value: string | number | Date): string | null;
export type VisitStatus = "planned" | "approved" | "completed" | "reviewed" | "overdue";
export function visitReportStatus(visit: { plan_approval?: string | null; submitted_at?: string | null; review_status?: string | null; report_due_at?: string | null }, now?: string | number | Date): VisitStatus;
export interface OpportunityStage { key: string; requires_quote: boolean; active: boolean; label_en?: string; label_zh?: string; sort_order?: number; is_closed?: boolean }
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };
export function parseOpportunityInput(input: unknown, options?: { stages?: OpportunityStage[]; partial?: boolean; existing?: Record<string, unknown> | null }): ParseResult<Record<string, unknown>>;
export function parseVisitInput(input: unknown, options?: { partial?: boolean }): ParseResult<Record<string, unknown>>;
export function mapDbError(error: { code?: string; message?: string } | null | undefined): { status: number; code: string };
export function dubaiLocalToIso(value: string): string | null;
export function isoToDubaiLocal(value: string | null | undefined): string;
