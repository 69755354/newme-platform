import { NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  createServerSupabase,
  getRefreshAttempted,
  getRefreshFailure,
  getRefreshedCookies,
  type RefreshedCookie,
} from "@/lib/supabase-server";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";
import { FORCED_SESSION_ERROR, isForcedPasswordChange } from "@/lib/forced-password-change.mjs";

const AUTH_TIMEOUT_MS = 3_000;
const PRIVATE_NO_STORE = "private, no-store, max-age=0, must-revalidate";

export type ActiveProfile = Pick<
  Database["public"]["Tables"]["profiles"]["Row"],
  "email" | "force_password_change" | "full_name" | "id" | "is_active" | "role"
>;

export type RequestAuthErrorCode =
  | "unauthorized"
  | "inactive_account"
  | "auth_unavailable"
  | "profile_unavailable"
  // A2. Not an authentication failure and not a revocation: the session is
  // valid, and the only thing its holder may do with it is replace the
  // credential. Routes that are part of that escape hatch opt out explicitly
  // with { allowForcedPasswordChange: true }; every other route inherits the
  // refusal by calling this function at all.
  | typeof FORCED_SESSION_ERROR;

export class RequestAuthError extends Error {
  readonly status: 401 | 403 | 503;
  readonly code: RequestAuthErrorCode;
  readonly clearSession: boolean;
  readonly refreshedCookies: RefreshedCookie[];

  constructor(
    code: RequestAuthErrorCode,
    options: { clearSession?: boolean; refreshedCookies?: RefreshedCookie[] } = {},
  ) {
    super(code);
    this.name = "RequestAuthError";
    this.code = code;
    this.clearSession = options.clearSession === true;
    this.refreshedCookies = options.refreshedCookies ?? [];
    this.status = code === "auth_unavailable" || code === "profile_unavailable"
      ? 503
      : code === FORCED_SESSION_ERROR
        ? 403
        : 401;
  }
}

export interface RequestAuthContext {
  requestId: string;
  supabase: SupabaseClient<Database>;
  user: User;
  profile: ActiveProfile;
  role: string;
  refreshedCookies: RefreshedCookie[];
}

export function applyPrivateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", PRIVATE_NO_STORE);
  response.headers.set("Vary", "Cookie, Authorization");
  return response;
}

function extractBearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  const match = value?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

async function withAuthTimeout<T>(operation: PromiseLike<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("auth_timeout")), AUTH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isMissingProfile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "PGRST116";
}

export interface RequestAuthOptions {
  /**
   * Only the endpoints that a forced session must be able to reach — the
   * password change itself, session information and logout — may set this. It is
   * an explicit opt-out so that a new route inherits the refusal by default;
   * tests/security/forced-password-change-boundary.test.mjs enumerates the
   * callers that pass it.
   */
  allowForcedPasswordChange?: boolean;
}

type SessionBoundaryState =
  | "ok"
  | "no_session"
  | "no_profile"
  | "inactive"
  | "banned"
  | "token_stale"
  | "password_change_required";

function isSessionBoundaryState(value: unknown): value is SessionBoundaryState {
  return typeof value === "string" && [
    "ok",
    "no_session",
    "no_profile",
    "inactive",
    "banned",
    "token_stale",
    "password_change_required",
  ].includes(value);
}

/** Resolve one request-bound client for auth, authorization, and RLS queries. */
export async function getRequestAuthContext(
  request: Request,
  options: RequestAuthOptions = {},
): Promise<RequestAuthContext> {
  const requestId = crypto.randomUUID();
  const supabase = await createServerSupabase(
    extractBearerToken(request),
    request.headers.get("cookie") ?? "",
  );
  const refreshedCookies = getRefreshedCookies(supabase);

  let user: User | null = null;
  let authError: unknown = null;
  try {
    const { data, error } = await withAuthTimeout(supabase.auth.getUser());
    user = data.user;
    authError = error;
  } catch {
    throw new RequestAuthError("auth_unavailable", { refreshedCookies });
  }

  if (!user || authError) {
    const refreshFailure = getRefreshFailure(supabase);
    if (refreshFailure === "upstream_error") {
      throw new RequestAuthError("auth_unavailable", { refreshedCookies });
    }
    if (getRefreshAttempted(supabase) || getRefreshFailure(supabase)) {
      throw new RequestAuthError(
        "unauthorized",
        {
          clearSession: refreshFailure === "invalid_refresh_token" || refreshFailure === "missing_refresh_token",
          refreshedCookies,
        },
      );
    }
    throw new RequestAuthError("unauthorized", { refreshedCookies });
  }

  // Ask the caller-scoped database boundary for the same verdict enforced by
  // RLS and SECURITY DEFINER entry guards. getUser() proves that Supabase signed
  // the token; it does not prove that an administrator has not since banned the
  // identity or changed its password. The profiles self-read below is
  // intentionally available to stale/forced sessions so the UI can explain the
  // refusal, so it cannot be used as the freshness check itself.
  let boundaryState: unknown;
  try {
    const { data, error } = await withAuthTimeout(supabase.rpc("session_boundary_state"));
    if (error) throw error;
    boundaryState = data;
  } catch {
    throw new RequestAuthError("profile_unavailable", { refreshedCookies });
  }

  if (!isSessionBoundaryState(boundaryState)) {
    throw new RequestAuthError("profile_unavailable", { refreshedCookies });
  }
  if (boundaryState === "no_session" || boundaryState === "token_stale") {
    throw new RequestAuthError("unauthorized", { clearSession: true, refreshedCookies });
  }
  if (["no_profile", "inactive", "banned"].includes(boundaryState)) {
    throw new RequestAuthError("inactive_account", { clearSession: true, refreshedCookies });
  }
  if (
    boundaryState === "password_change_required"
    && options.allowForcedPasswordChange !== true
  ) {
    throw new RequestAuthError(FORCED_SESSION_ERROR, { refreshedCookies });
  }

  let profile: ActiveProfile | null = null;
  let profileError: unknown = null;
  try {
    const { data, error } = await withAuthTimeout(
      supabase
        .from("profiles")
        .select("id, role, is_active, full_name, email, force_password_change")
        .eq("id", user.id)
        .single(),
    );
    profile = data;
    profileError = error;
  } catch {
    throw new RequestAuthError("profile_unavailable", { refreshedCookies });
  }

  if (profileError) {
    if (isMissingProfile(profileError)) {
      throw new RequestAuthError("inactive_account", { refreshedCookies });
    }
    throw new RequestAuthError("profile_unavailable", { refreshedCookies });
  }
  if (!profile || profile.is_active !== true) {
    throw new RequestAuthError("inactive_account", { refreshedCookies });
  }
  if (isForcedPasswordChange(profile) && options.allowForcedPasswordChange !== true) {
    throw new RequestAuthError(FORCED_SESSION_ERROR, { refreshedCookies });
  }

  return {
    requestId,
    supabase,
    user,
    profile,
    role: profile.role ?? "sales",
    refreshedCookies,
  };
}

export function requestAuthErrorResponse(error: RequestAuthError): NextResponse {
  const response = applyPrivateNoStore(
    NextResponse.json({ error: error.code }, { status: error.status }),
  );
  for (const cookie of error.refreshedCookies) {
    response.cookies.set(
      cookie.name,
      cookie.value,
      cookie.options as Parameters<typeof response.cookies.set>[2],
    );
  }
  if (error.clearSession) {
    const names = getSupabaseCookieNames();
    for (const name of [
      names.authToken,
      names.refreshToken,
      "sb-access-token",
      "sb-refresh-token",
    ]) {
      response.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
  }
  return response;
}

export function applyRequestAuthCookies(
  context: Pick<RequestAuthContext, "refreshedCookies">,
  response: NextResponse,
): NextResponse {
  applyPrivateNoStore(response);
  for (const cookie of context.refreshedCookies) {
    response.cookies.set(
      cookie.name,
      cookie.value,
      cookie.options as Parameters<typeof response.cookies.set>[2],
    );
  }
  return response;
}
