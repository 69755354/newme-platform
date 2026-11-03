// RBAC helper for the server-rendered pages under (dashboard): quotes,
// projects, settings/ads and cable-costing render data into HTML with the
// caller's own session, so each must decide for itself whether that session
// may see anything.
//
// Three verdicts, and only the first two are redirects:
//   - no session / invalid session / inactive profile → /login
//   - force_password_change → /change-password (the A2 boundary; the edge
//     proxy enforces it too, but a page navigation that the proxy let through
//     because its own profile lookup timed out must not skip it here)
//   - wrong role → /dashboard
// and one that is not a verdict at all: the auth dependency timed out or
// answered 5xx. That renders the shared "connection failed · retry" view
// rather than sending a valid user to /login (auth-js reports an unreachable
// auth service as an error *result*, which the old `if (error || !user)
// redirect("/login")` treated as "not signed in").
//
// Every call is bounded by the same 3-second budget as the proxy and
// /api/auth/me, so a slow Supabase cannot pile up hanging renders.

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase-server";
import { isRetryableAuthError } from "@/lib/auth-retryable.mjs";
import { isActiveProfile } from "@/lib/auth-profile.mjs";
import {
  FORCED_SESSION_ERROR,
  FORCED_SESSION_REDIRECT_PATH,
  isForcedPasswordChange,
} from "@/lib/forced-password-change.mjs";

export const SERVER_PAGE_AUTH_TIMEOUT_MS = 3_000;

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabase>>;

export type ServerPageSession =
  | { status: "ok"; user: { id: string }; role: string; supabase: ServerSupabase }
  | { status: "unavailable" };

type Verdict =
  | { kind: "ok"; user: { id: string }; role: string; supabase: ServerSupabase }
  | { kind: "unavailable" }
  | { kind: "redirect"; to: string };

async function withDeadline<T>(operation: () => PromiseLike<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("auth_timeout")), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function decide(roles: readonly string[] | undefined): Promise<Verdict> {
  const deadline = Date.now() + SERVER_PAGE_AUTH_TIMEOUT_MS;
  let supabase: ServerSupabase;
  let user: { id: string } | null;
  try {
    supabase = await withDeadline(() => createServerSupabase(), deadline);
    const { data, error } = await withDeadline(() => supabase.auth.getUser(), deadline);
    if (isRetryableAuthError(error)) return { kind: "unavailable" };
    if (error || !data.user) return { kind: "redirect", to: "/login" };
    user = data.user;
  } catch {
    return { kind: "unavailable" };
  }

  let profile: { role?: string | null; is_active?: boolean | null; force_password_change?: boolean | null } | null;
  try {
    const { data, error } = await withDeadline(
      () => supabase
        .from("profiles")
        .select("role, is_active, force_password_change")
        .eq("id", user.id)
        .single(),
      deadline,
    );
    if (error) return { kind: "unavailable" };
    profile = data;
  } catch {
    return { kind: "unavailable" };
  }

  if (!isActiveProfile(profile)) return { kind: "redirect", to: "/login?reason=inactive_account" };
  if (isForcedPasswordChange(profile)) {
    return { kind: "redirect", to: `${FORCED_SESSION_REDIRECT_PATH}?reason=${FORCED_SESSION_ERROR}` };
  }
  const role = profile?.role ?? null;
  if (!role || (roles && !roles.includes(role))) return { kind: "redirect", to: "/dashboard" };
  return { kind: "ok", user, role, supabase };
}

/**
 * Resolve the caller's session for a server-rendered page. Redirects (throws)
 * on a definite refusal; returns `{ status: "unavailable" }` when the session
 * could not be checked, which the page renders as <ConnectionFailed />.
 *
 * @param options.roles roles allowed on the page; omit to allow every active role
 */
export async function authorizeServerPage(options: { roles?: readonly string[] } = {}): Promise<ServerPageSession> {
  const verdict = await decide(options.roles);
  if (verdict.kind === "redirect") redirect(verdict.to);
  if (verdict.kind === "unavailable") return { status: "unavailable" };
  return { status: "ok", user: verdict.user, role: verdict.role, supabase: verdict.supabase };
}
