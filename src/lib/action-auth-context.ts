import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createServerSupabase } from "@/lib/supabase-server";
import { FORCED_SESSION_ERROR, isForcedPasswordChange } from "@/lib/forced-password-change.mjs";

// Round-4 R1 · the third entry point.
//
// A2 closed two of the three ways an authenticated request reaches business
// logic: src/proxy.ts at the edge, and getRequestAuthContext() for route
// handlers. Server actions are the third, and they had no forced-password check
// anywhere. Each one resolved its own session with createServerSupabase(), read
// `profiles.role` for its own role gate, and never looked at
// force_password_change or is_active.
//
// The edge does cover them today, because a server action POSTs to the page's
// own path and every page under (dashboard) is in the matcher. That is one
// matcher entry away from being false, and it is the wrong place to be the only
// check: the matcher is a routing declaration, not an authorization boundary,
// and A2's own note says the refusal must live where the exceptions are known.
// So the actions get the same treatment the routes got — one function, consulted
// by all of them, failing closed — and the matcher becomes defence in depth
// instead of the whole defence.
//
// The escape hatch is narrower here than for routes. A forced session's holder
// changes the password through POST /api/auth/change-password, which is a route;
// no server action is part of that flow. The single opt-out is getCurrentUser(),
// which is the action-shaped equivalent of GET /api/auth/me — reading your own
// id, role and email is what the /change-password page needs to render, and it
// is on the allowed list for exactly that reason.
//
// tests/security/forced-password-actions-boundary.test.mjs enumerates every
// exported action in src/app/actions/ and requires each to reach this function,
// so a new action inherits the refusal by being written at all.

export type ActionProfile = Pick<
  Database["public"]["Tables"]["profiles"]["Row"],
  "email" | "force_password_change" | "full_name" | "id" | "is_active" | "role"
>;

export type ActionAuthErrorCode =
  | "Unauthorized"
  | "Profile not found"
  | "inactive_account"
  | "auth_unavailable"
  | typeof FORCED_SESSION_ERROR;

/**
 * The refusal a server action throws.
 *
 * The two pre-existing messages are kept verbatim — `Unauthorized` and
 * `Profile not found` are what every action already threw and what the UI
 * already renders — so this change adds refusals without renaming any.
 */
export class ActionAuthError extends Error {
  readonly code: ActionAuthErrorCode;

  constructor(code: ActionAuthErrorCode) {
    super(code);
    this.name = "ActionAuthError";
    this.code = code;
  }
}

export interface ActionAuthContext {
  supabase: SupabaseClient<Database>;
  user: User;
  profile: ActionProfile;
  role: string | null;
}

export interface ActionAuthOptions {
  /**
   * Only getCurrentUser() may set this. See the header: it is the action-shaped
   * GET /api/auth/me, and the enumeration test names it as the sole caller.
   */
  allowForcedPasswordChange?: boolean;
}

/**
 * Resolve one session-bound client, user and profile for a server action.
 *
 * Reads through the caller's own RLS client, not the service key: an action that
 * needs its caller's role needs no more privilege than the caller has, and
 * `profiles` already lets an identity read its own row.
 */
export async function getActionAuthContext(
  options: ActionAuthOptions = {},
): Promise<ActionAuthContext> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new ActionAuthError("Unauthorized");

  // The database verdict also covers a banned identity and a token minted
  // before password_changed_at. Neither condition is established by getUser(),
  // and the profiles self-read is deliberately relaxed for stale/forced tokens.
  const { data: boundaryState, error: boundaryError } = await supabase.rpc(
    "session_boundary_state",
  );
  if (boundaryError || typeof boundaryState !== "string") {
    throw new ActionAuthError("auth_unavailable");
  }
  if (boundaryState === "no_session" || boundaryState === "token_stale") {
    throw new ActionAuthError("Unauthorized");
  }
  if (["no_profile", "inactive", "banned"].includes(boundaryState)) {
    throw new ActionAuthError(boundaryState === "no_profile" ? "Profile not found" : "inactive_account");
  }
  if (
    boundaryState === "password_change_required"
    && options.allowForcedPasswordChange !== true
  ) {
    throw new ActionAuthError(FORCED_SESSION_ERROR);
  }
  if (boundaryState !== "ok" && boundaryState !== "password_change_required") {
    throw new ActionAuthError("auth_unavailable");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, is_active, full_name, email, force_password_change")
    .eq("id", user.id)
    .single();

  if (!profile) throw new ActionAuthError("Profile not found");
  // is_active was checked at the edge and nowhere else. A revoked account whose
  // request skips the edge for any reason should not get to write.
  if (profile.is_active !== true) throw new ActionAuthError("inactive_account");
  if (isForcedPasswordChange(profile) && options.allowForcedPasswordChange !== true) {
    throw new ActionAuthError(FORCED_SESSION_ERROR);
  }

  return { supabase, user, profile, role: profile.role ?? null };
}
