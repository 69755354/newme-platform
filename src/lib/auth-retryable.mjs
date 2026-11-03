// Shared by the edge proxy, GET /api/auth/me and the server-rendered pages.
//
// @supabase/auth-js does not throw when the auth service is unreachable or
// answers 5xx: getUser() resolves with `{ data: { user: null }, error }` where
// `error` is an AuthRetryableFetchError (status 0 for a failed fetch, or the
// upstream 5xx). Every caller that wrote `if (error || !user) → /login` turned
// that outage into "logged out" for a valid session. This is the one place
// that decides which auth errors are the dependency's fault rather than a
// verdict about the session.

/**
 * @param {unknown} error the `error` half of a Supabase auth result
 * @returns {boolean} true when the session could not be checked (retry later),
 *   false when there is no error or the error is a verdict (no/invalid session)
 */
export function isRetryableAuthError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.name === "AuthRetryableFetchError") return true;
  const status = error.status;
  return status === 0 || (typeof status === "number" && status >= 500);
}

/**
 * True when a `.single()` profile lookup found no row. The session boundary
 * policy (restrict_profiles_active_session_select) hides a deactivated or
 * banned user's own profile row, so PostgREST answers PGRST116 ("0 rows") —
 * an error object, not `data: null`. That is a verdict (inactive account),
 * not an outage, and must never be shown as "connection failed".
 *
 * @param {unknown} error the `error` half of a Supabase query result
 * @returns {boolean}
 */
export function isMissingProfileRow(error) {
  return Boolean(error) && typeof error === "object" && /** @type {{ code?: unknown }} */ (error).code === "PGRST116";
}
