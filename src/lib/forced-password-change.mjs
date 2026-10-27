// Round-4 review A2: force-password-change was a client-side convention.
//
// profiles.force_password_change was written by the admin reset paths, returned
// by /api/auth/login, and acted on by the browser, which redirected itself to
// /change-password. Nothing on the server refused a forced session: a caller who
// ignored the redirect — or who never ran the page at all and simply held a
// token — reached every authenticated route, including the service-role
// password-reset paths. A credential the operator has already decided must be
// replaced is exactly the credential this state exists to contain.
//
// So the flag is enforced in two places that every authenticated request passes
// through: src/proxy.ts at the edge, and getRequestAuthContext() for the routes
// that resolve their own auth context. Both fail closed, and both consult the
// list below rather than carrying their own copy of it.
//
// The database half of the boundary is a different question and a different
// migration: 20260813000000_session_revocation_boundary.sql answers "is this
// identity allowed to touch data at all". force_password_change is not a
// revocation — the session is valid and its holder must be able to complete the
// change — so it is enforced where the allowed exceptions are known, which is
// the request path.
//
// The escape hatch is deliberately three endpoints and two pages: change the
// password, look at who you are, and leave. Anything else is refused, reads
// included, because a forced session's holder has no business reading business
// data with a credential that is on its way out.

/** The only API paths a forced session may reach. */
export const FORCED_SESSION_ALLOWED_API_PATHS = new Set([
  // The way out. POST here proves the current password and clears the flag.
  "/api/auth/change-password",
  // Session information and teardown. /api/auth/login is pre-session by
  // definition; it is listed so that an inventory over this set is complete.
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/auth/session",
]);

/** The only pages a forced session may render. */
export const FORCED_SESSION_ALLOWED_PAGE_PATHS = new Set([
  "/change-password",
  "/login",
]);

/** Where a forced browser session is sent instead of the page it asked for. */
export const FORCED_SESSION_REDIRECT_PATH = "/change-password";

/** The response code both boundaries use, so one string is testable. */
export const FORCED_SESSION_ERROR = "password_change_required";

export function isForcedPasswordChange(profile) {
  return profile?.force_password_change === true;
}

export function isForcedSessionAllowedPath(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) return false;
  // Trailing slashes and query strings are normalised away by the callers'
  // frameworks, but a bare trailing slash still reaches the proxy for pages.
  const normalised = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  return FORCED_SESSION_ALLOWED_API_PATHS.has(normalised)
    || FORCED_SESSION_ALLOWED_PAGE_PATHS.has(normalised);
}
