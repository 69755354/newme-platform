// RBAC: user (authenticated)
import { createServerSupabase } from "@/lib/supabase-server";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

const LEGACY_COOKIE_NAMES = ["sb-access-token", "sb-refresh-token"];

/**
 * POST /api/auth/logout
 *
 * Clearing the cookies only ends the session in this browser. The refresh token
 * stays valid upstream until GoTrue is told otherwise, so a copy taken from the
 * machine keeps minting access tokens after the user believes they signed out.
 * Upstream revocation is therefore the part that matters, and its result is
 * reported rather than discarded: the previous implementation ran
 * `await supabase.auth.signOut()` and threw the result away, then answered
 * `{ ok: true }` whether or not the token had actually been revoked — so a
 * silent upstream failure looked exactly like a successful sign-out.
 *
 * Cookies are cleared unconditionally, including when revocation fails. Leaving
 * a session in the browser because the upstream call failed would be strictly
 * worse. The status code and `revoked` flag tell the caller which happened; the
 * login page uses this endpoint to discard a rejected session and treats any
 * outcome as "cookies gone", which stays correct.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  const names = getSupabaseCookieNames();
  const clearCookies = (response: NextResponse) => {
    for (const name of [names.authToken, names.refreshToken, ...LEGACY_COOKIE_NAMES]) {
      response.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
    return response;
  };

  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);

    // `global` revokes every refresh token for this user, not just this one.
    // A sign-out that leaves other copies of the session alive is not a
    // sign-out, and this is the only revocation point the user can trigger.
    const { error } = await supabase.auth.signOut({ scope: "global" });

    if (error) {
      logger.error(
        { request_id: requestId, operation: "auth_logout", code: "revocation_failed" },
        "Upstream session revocation failed during logout",
      );
      return clearCookies(
        NextResponse.json({ ok: false, revoked: false, error: "revocation_failed" }, { status: 502 }),
      );
    }

    return clearCookies(NextResponse.json({ ok: true, revoked: true }));
  } catch (err) {
    logger.error(
      { request_id: requestId, operation: "auth_logout", err },
      "Logout failed before upstream revocation",
    );
    return clearCookies(
      NextResponse.json({ ok: false, revoked: false }, { status: 500 }),
    );
  }
}
