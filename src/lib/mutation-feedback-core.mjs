// S6 · shared save/mutation feedback (review 4d #4-#7, 3-code-quality F6/F9/F10).
//
// One place decides what a failed write means to the user:
//   network   – the request never reached us (offline, DNS, "TypeError:
//               Failed to fetch"); the input must be kept and a plain
//               "not saved, check your connection" shown — never the raw text.
//   session   – the sign-in ended (other tab logged out, token revoked);
//               say "please sign in again" and take the user to /login.
//   forbidden – signed in but not allowed.
//   conflict  – someone else changed the record first.
//   validation– the server rejected the input.
//   server    – the server answered with an error.
//   unexpected– our own code threw (logged to console + Sentry by the caller).
// Known API error strings/codes are mapped to dictionary keys under
// `apiErrors.*`; anything unknown falls back to the localized kind message, so
// raw English/technical text never reaches a Chinese-mode user.
// Pure and framework-free so node --test can exercise it directly.

export const SLOW_MUTATION_MS = 600;
export const SESSION_REDIRECT_DELAY_MS = 1500;

const NETWORK_PATTERN = /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet_disconnected|the internet connection appears to be offline/i;

const SESSION_CODES = new Set([
  "unauthorized",
  "password_change_required",
  "password_changed",
  "session_revoked",
  "session_expired",
  "inactive_account",
  "jwt_expired",
  "invalid_jwt",
  "pgrst301",
  "pgrst303",
]);

/** Normalize an API error string or code into a dictionary key segment. */
export function apiErrorSlug(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

/** Known server messages → `apiErrors.<slug>` keys present in both dictionaries. */
export const KNOWN_API_ERRORS = Object.freeze([
  "lead_not_found",
  "stage_note_is_required",
  "milestone_note_is_required",
  "concurrent_lead_update",
  "forbidden_invalid_crm_role",
  "forbidden",
  "contact_time_cannot_be_in_the_future",
  "terminal_lead_stage_cannot_be_changed",
  "lead_delete_blocked",
  "invalid_request",
  "not_found",
]);

function looksLikeSessionError(slug) {
  return SESSION_CODES.has(slug) || /jwt|session|not_authenticated|auth_session_missing|refresh_token/.test(slug);
}

/**
 * @param {{ status?: number, body?: any, error?: unknown }} failure
 * @returns {"network"|"session"|"forbidden"|"conflict"|"validation"|"server"|"unexpected"}
 */
export function classifyMutationFailure({ status, body, error } = {}) {
  const errorText = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === "string" ? error
      : typeof error?.message === "string" ? error.message : "";
  // Only a real transport failure is "network" (fetch rejects with
  // "Failed to fetch" / "NetworkError…" / "Load failed"). Any other TypeError
  // is a code bug and must not be hidden behind "check your connection".
  if (!status && NETWORK_PATTERN.test(errorText)) return "network";
  if (NETWORK_PATTERN.test(errorText) && !body) return "network";

  const code = apiErrorSlug(body?.code ?? body?.error ?? error?.code ?? "");
  if (status === 401 || looksLikeSessionError(code)) return "session";
  if (status === 403 || code === "42501") return "forbidden";
  if (status === 409 || code === "concurrent_lead_update" || code === "23505") return "conflict";
  if (status === 400 || status === 422 || code === "23514" || code === "22p02" || code === "p0001") return "validation";
  // No HTTP status and no database/API code: the write threw inside our own
  // code. Report it as unexpected (and log it), not as a server or network fault.
  if (!status && !code && error instanceof Error) return "unexpected";
  return "server";
}

/**
 * Localized message for a failure. `t` is the dictionary lookup, which
 * returns the key path itself when a key is missing.
 */
export function mutationFailureMessage({ kind, body, error }, t, fallbackKey) {
  if (kind === "network" || kind === "session") return t(`mutation.${kind}`);
  const candidates = [body?.code, body?.error, error?.code, error?.message];
  for (const raw of candidates) {
    const slug = apiErrorSlug(raw);
    if (slug && KNOWN_API_ERRORS.includes(slug)) {
      const key = `apiErrors.${slug}`;
      const text = t(key);
      if (text && text !== key) return text;
    }
  }
  if (fallbackKey) {
    const text = t(fallbackKey);
    if (text && text !== fallbackKey) return text;
  }
  return t(`mutation.${kind}`);
}
