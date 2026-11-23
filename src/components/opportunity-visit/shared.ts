// Small client helpers shared by the opportunity and visit panels (S23).
export type Translate = (key: string) => string;

export const FIELD_ERROR_KEY: Record<string, string> = {
  required: "required", invalid: "invalid", too_long: "tooLong", out_of_range: "outOfRange", quote_required: "quoteRequired",
  unknown_stage: "unknownStage", inactive_stage: "inactiveStage", before_start: "beforeStart",
};

export const SERVER_ERROR_KEY: Record<string, string> = {
  duplicate: "duplicate", forbidden: "forbidden", visit_report_locked: "locked", visit_plan_not_approved: "notApproved",
  visit_report_incomplete: "incomplete", review_note_required: "noteRequired", opportunity_quote_required: "quoteRequired",
};

export interface ApiResult<T> { ok: boolean; status: number; body: T & { error?: string; fields?: Record<string, string> } }

export async function callApi<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init?.headers });
    const body = (await response.json().catch(() => ({}))) as ApiResult<T>["body"];
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: {} as ApiResult<T>["body"] };
  }
}

/** Message for a failed call, in the page language, from the namespace's `error` block. */
export function errorText(t: Translate, namespace: "opportunities" | "visits", result: ApiResult<unknown>): string {
  if (result.status === 503) return t(`${namespace}.unavailable`);
  const code = result.body.error ?? "";
  const key = SERVER_ERROR_KEY[code];
  if (key) return t(`${namespace}.error.${key}`);
  return t(`${namespace}.error.generic`);
}

export function fieldErrorText(t: Translate, namespace: "opportunities" | "visits", code: string): string {
  return t(`${namespace}.error.${FIELD_ERROR_KEY[code] ?? "invalid"}`);
}

export const inputClass = "h-8 w-full rounded-md border border-border bg-background px-2 text-xs";
export const textareaClass = "w-full rounded-md border border-border bg-background px-2 py-1 text-xs";
export const buttonClass = "inline-flex h-7 items-center rounded-md border border-border px-2 text-xs hover:bg-muted disabled:opacity-60";

export const STATUS_TONE: Record<string, string> = {
  planned: "bg-slate-500/15 text-slate-300",
  approved: "bg-sky-500/15 text-sky-700",
  completed: "bg-amber-500/15 text-amber-700",
  reviewed: "bg-emerald-500/15 text-emerald-700",
  overdue: "bg-red-500/15 text-red-700",
};
