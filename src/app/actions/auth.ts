"use server";

import { getActionAuthContext } from "@/lib/action-auth-context";

interface CurrentUser {
  id: string;
  role: string | null;
  email: string | null;
}

/**
 * Server action: resolve the current user's id, role, and email from the session cookie.
 * Returns null if no valid session — caller handles redirect.
 *
 * R1 · the one action a forced session may still call. It answers "who am I",
 * which is what /change-password renders and what GET /api/auth/me already
 * allows for the same reason. Every other action refuses; see
 * src/lib/action-auth-context.ts.
 *
 * The null return is kept: three client hooks treat null as "not signed in, go
 * to /login", and turning that into a throw would replace a redirect with an
 * unhandled server-action error.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const { user, profile } = await getActionAuthContext({ allowForcedPasswordChange: true });
    return {
      id: user.id,
      role: profile.role ?? null,
      email: profile.email ?? null,
    };
  } catch {
    return null;
  }
}
