import type { NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  createServerSupabase,
  getRefreshAttempted,
  getRefreshFailure,
  getRefreshedCookies,
  type RefreshedCookie,
} from "@/lib/supabase-server";
import { getRequestedOrganizationId } from "@/lib/organization-context";

const AUTH_TIMEOUT_MS = 3_000;

export type ActiveProfile = Pick<
  Database["public"]["Tables"]["profiles"]["Row"],
  "email" | "full_name" | "id" | "is_active" | "role"
>;

export type RequestAuthErrorCode =
  | "unauthorized"
  | "inactive_account"
  | "auth_unavailable"
  | "profile_unavailable";

export class RequestAuthError extends Error {
  readonly status: 401 | 503;
  readonly code: RequestAuthErrorCode;

  constructor(code: RequestAuthErrorCode) {
    super(code);
    this.name = "RequestAuthError";
    this.code = code;
    this.status = code === "auth_unavailable" || code === "profile_unavailable" ? 503 : 401;
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

/**
 * Resolves exactly one explicit auth/session boundary for a route handler.
 *
 * Routes pass their Request instead of allowing auth helpers to implicitly
 * read next/headers cookies(). The returned client carries the same request
 * authorization for both getUser() and RLS-governed profile lookups.
 */
export async function getRequestAuthContext(request: Request): Promise<RequestAuthContext> {
  const requestId = crypto.randomUUID();
  const supabase = await createServerSupabase(
    extractBearerToken(request),
    request.headers.get("cookie") ?? "",
    getRequestedOrganizationId(request) ?? undefined,
  );
  const refreshedCookies = getRefreshedCookies(supabase);

  let user: User | null = null;
  let authError: unknown = null;
  try {
    const { data, error } = await withAuthTimeout(supabase.auth.getUser());
    user = data.user;
    authError = error;
  } catch {
    throw new RequestAuthError("auth_unavailable");
  }

  if (!user || authError) {
    if (getRefreshFailure(supabase) === "upstream_error") {
      throw new RequestAuthError("auth_unavailable");
    }
    // A failed, missing, or revoked refresh is always an authentication
    // failure, never an infrastructure failure exposed to the caller.
    if (getRefreshAttempted(supabase) || getRefreshFailure(supabase)) {
      throw new RequestAuthError("unauthorized");
    }
    throw new RequestAuthError("unauthorized");
  }

  let profile: ActiveProfile | null = null;
  let profileError: unknown = null;
  try {
    const { data, error } = await withAuthTimeout(
      supabase
        .from("profiles")
        .select("id, role, is_active, full_name, email")
        .eq("id", user.id)
        .single(),
    );
    profile = data;
    profileError = error;
  } catch {
    throw new RequestAuthError("profile_unavailable");
  }

  if (profileError) {
    if (isMissingProfile(profileError)) {
      throw new RequestAuthError("inactive_account");
    }
    throw new RequestAuthError("profile_unavailable");
  }
  if (!profile || profile.is_active !== true) {
    throw new RequestAuthError("inactive_account");
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

/** Applies refreshed session cookies to every response built from a context. */
export function applyRequestAuthCookies(
  context: Pick<RequestAuthContext, "refreshedCookies">,
  response: NextResponse,
): NextResponse {
  for (const cookie of context.refreshedCookies) {
    response.cookies.set(
      cookie.name,
      cookie.value,
      cookie.options as Parameters<typeof response.cookies.set>[2],
    );
  }
  return response;
}
