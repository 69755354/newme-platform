"use client";

// S6 · the one shared pattern for user-initiated writes (see
// mutation-feedback-core.mjs for the classification rules).
//
//   const result = await runMutation(() => requestJson(url, init), { t, successMessage: t("…") });
//   if (!result.ok) return;          // input stays where it is
//
// What every caller gets for free:
//   * a "Saving…" toast if the write is still running after SLOW_MUTATION_MS
//     (slow networks used to show nothing for 7 s);
//   * exactly ONE outcome toast — the pending toast is replaced in place;
//   * a localized message instead of "TypeError: Failed to fetch" or raw API
//     English, chosen by failure kind;
//   * on an ended session (other tab signed out, token revoked): "please sign
//     in again" and a redirect to /login that returns here afterwards, instead
//     of a generic "Failed to create lead".

import { toast } from "sonner";
import { readSessionIdentity } from "@/lib/session-identity";
import * as Sentry from "@sentry/nextjs";
import {
  SESSION_REDIRECT_DELAY_MS,
  SLOW_MUTATION_MS,
  classifyMutationFailure,
  mutationFailureMessage,
  type MutationFailureKind,
} from "@/lib/mutation-feedback-core.mjs";

export type { MutationFailureKind };

export class MutationFailure extends Error {
  status?: number;
  body?: unknown;
  original?: unknown;
  constructor(init: { status?: number; body?: unknown; original?: unknown }) {
    super(typeof (init.body as { error?: unknown })?.error === "string"
      ? String((init.body as { error: string }).error)
      : init.original instanceof Error ? init.original.message : "mutation failed");
    this.name = "MutationFailure";
    this.status = init.status;
    this.body = init.body;
    this.original = init.original;
  }
}

/** fetch + JSON for a write; throws MutationFailure on network error or non-2xx. */
export async function requestJson<T = unknown>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (original) {
    throw new MutationFailure({ original });
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new MutationFailure({ status: response.status, body });
  return body as T;
}

/**
 * Unwrap a supabase-js result. supabase-js reports a dropped connection as
 * `{ error: { message: "TypeError: Failed to fetch" } }`; RLS rejections can
 * come back as success with no row, so `requireData` treats that as refused.
 */
export function checkSupabase<T>(
  result: { data: T | null; error: { message?: string; code?: string } | null },
  options: { requireData?: boolean } = {},
): T {
  if (result.error) {
    throw new MutationFailure({
      body: result.error.code ? { code: result.error.code } : undefined,
      original: result.error,
    });
  }
  if (options.requireData && (result.data === null || result.data === undefined)) {
    throw new MutationFailure({ status: 403, body: { code: "42501" } });
  }
  return result.data as T;
}

/**
 * Keep the cause of a failed save visible to us. Network and validation
 * failures are expected; anything else is logged with the error object only
 * (no form values, no response body, which may contain customer data).
 */
function logFailure(kind: MutationFailureKind, failure: MutationFailure) {
  if (kind === "network" || kind === "validation" || kind === "session") return;
  const original = failure.original ?? failure;
  console.error("[mutation] save failed", kind, failure.status ?? "", original);
  if (kind === "unexpected" || kind === "server") {
    try {
      Sentry.captureException(original instanceof Error ? original : new Error(`mutation ${kind}`), {
        tags: { area: "mutation", kind },
        extra: { status: failure.status ?? null },
      });
    } catch { /* never let reporting break the UI */ }
  }
}

let redirecting = false;
/** Send the user to sign in, coming back to the current page afterwards. */
export function redirectToLogin(delayMs = SESSION_REDIRECT_DELAY_MS) {
  if (redirecting || typeof window === "undefined") return;
  redirecting = true;
  const back = `${window.location.pathname}${window.location.search}`;
  window.setTimeout(() => {
    window.location.assign(`/login?redirect=${encodeURIComponent(back)}`);
  }, delayMs);
}

async function sessionStillValid(): Promise<boolean> {
  try {
    // Shared live reader (the only client caller of the session endpoint).
    return (await readSessionIdentity()).status !== "unauthenticated";
  } catch {
    return true; // cannot tell; do not force a sign-in
  }
}

export interface RunMutationOptions {
  t: (key: string) => string;
  /** Shown only after the write has been running for SLOW_MUTATION_MS. */
  pendingMessage?: string;
  /** Toast on success; omit or null for no toast. */
  successMessage?: string | null;
  /** Dictionary key used when the failure has no more specific message. */
  fallbackErrorKey?: string;
  /** Suppress the error toast (caller renders the message inline). */
  silentError?: boolean;
}

export type MutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: MutationFailureKind; message: string };

export async function runMutation<T>(
  action: () => Promise<T>,
  options: RunMutationOptions,
): Promise<MutationResult<T>> {
  const { t } = options;
  const toastId = `mutation-${Math.random().toString(36).slice(2)}`;
  let pendingShown = false;
  const timer = setTimeout(() => {
    pendingShown = true;
    toast.loading(options.pendingMessage ?? t("mutation.saving"), { id: toastId });
  }, SLOW_MUTATION_MS);

  try {
    const value = await action();
    clearTimeout(timer);
    if (options.successMessage) toast.success(options.successMessage, { id: toastId });
    else if (pendingShown) toast.dismiss(toastId);
    return { ok: true, value };
  } catch (error) {
    clearTimeout(timer);
    const failure = error instanceof MutationFailure ? error : new MutationFailure({ original: error });
    let kind = classifyMutationFailure({
      status: failure.status,
      body: failure.body,
      error: failure.original ?? failure,
    });
    // A 403 after the session ended elsewhere looks like a permission error;
    // ask the server who we are before deciding which one it was.
    if (kind === "forbidden" && !(await sessionStillValid())) kind = "session";
    logFailure(kind, failure);
    const message = mutationFailureMessage(
      { kind, body: failure.body, error: failure.original },
      t,
      options.fallbackErrorKey,
    );
    if (kind === "session") {
      toast.error(message, { id: toastId });
      redirectToLogin();
    } else if (!options.silentError) {
      toast.error(message, { id: toastId });
    } else if (pendingShown) {
      toast.dismiss(toastId);
    }
    return { ok: false, kind, message };
  }
}

/**
 * For code paths that already handle their own result (no runMutation
 * wrapper): show the ONE localized failure toast for a caught error or a
 * supabase-js error object, and send the user to sign in if the session ended.
 * Never shows raw technical text such as "TypeError: Failed to fetch".
 */
export function reportMutationFailure(
  error: unknown,
  t: (key: string) => string,
  fallbackErrorKey?: string,
): MutationFailureKind {
  const failure = error instanceof MutationFailure
    ? error
    : new MutationFailure({
      body: (error as { code?: string } | null)?.code ? { code: (error as { code: string }).code } : undefined,
      original: error,
    });
  const kind = classifyMutationFailure({ status: failure.status, body: failure.body, error: failure.original ?? failure });
  logFailure(kind, failure);
  toast.error(mutationFailureMessage({ kind, body: failure.body, error: failure.original }, t, fallbackErrorKey));
  if (kind === "session") redirectToLogin();
  return kind;
}
