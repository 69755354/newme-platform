// Small client helpers for the dispatch workbench and the lead-page label (S24).
export type Translate = (key: string) => string;

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

const SERVER_ERROR_KEY: Record<string, string> = {
  forbidden: "forbidden", reason_required: "reasonRequired", review_note_required: "noteRequired", validation_failed: "reasonRequired",
  review_already_decided: "conflict", pending_review_exists: "conflict", nothing_to_release: "conflict", phone_not_confirmable: "conflict",
  lead_has_no_dispatch_state: "conflict", unknown_lead: "notFound", unknown_review: "notFound", not_found: "notFound",
};

/** Message for a failed call, in the page language. */
export function errorText(t: Translate, result: ApiResult<unknown>): string {
  if (result.status === 503) return t("dispatch.unavailable");
  const key = SERVER_ERROR_KEY[result.body.error ?? ""];
  return t(`dispatch.error.${key ?? "generic"}`);
}

export const inputClass = "h-8 w-full rounded-md border border-border bg-background px-2 text-xs";
export const textareaClass = "w-full rounded-md border border-border bg-background px-2 py-1 text-xs";
export const buttonClass = "inline-flex h-7 items-center rounded-md border border-border px-2 text-xs hover:bg-muted disabled:opacity-60";

export const STATUS_TONE: Record<string, string> = {
  missing_intake_data: "bg-amber-500/15 text-amber-300",
  review_phone: "bg-amber-500/15 text-amber-300",
  duplicate_review: "bg-orange-500/15 text-orange-300",
  unassigned: "bg-sky-500/15 text-sky-300",
  delivered: "bg-emerald-500/15 text-emerald-300",
  duplicate_not_dispatched: "bg-slate-500/15 text-slate-300",
  excluded_test: "bg-slate-500/15 text-slate-300",
};
