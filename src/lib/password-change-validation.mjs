// Shared rules for the self-service password change (S6, review 4d #2/#3).
//
// The forced change page gave no feedback at all and accepted a new password
// identical to the old one. Both the page and POST /api/auth/change-password
// now evaluate the same rules here, so the browser can explain a rejection
// before a round trip and the server still refuses it if the browser is
// bypassed. Every rejection is a stable code; the page translates the code.

export const PASSWORD_MIN_LENGTH = 6;

/** Codes returned by validatePasswordChange and by the API's `code` field. */
export const PASSWORD_CHANGE_CODES = Object.freeze([
  "missing_fields",
  "too_short",
  "mismatch",
  "same_as_old",
  "wrong_current_password",
  "unauthorized",
  "rate_limited",
  "update_failed",
  "partial_success",
  "network",
]);

/**
 * Validate a password change request. `confirmPassword` is optional so the
 * server (which never receives it) can call the same function.
 * Returns null when the request may proceed, otherwise a code.
 */
export function validatePasswordChange({ oldPassword, newPassword, confirmPassword } = {}) {
  if (typeof oldPassword !== "string" || typeof newPassword !== "string"
    || oldPassword.length === 0 || newPassword.length === 0) {
    return "missing_fields";
  }
  if (confirmPassword !== undefined && newPassword !== confirmPassword) return "mismatch";
  if (newPassword.length < PASSWORD_MIN_LENGTH) return "too_short";
  if (newPassword === oldPassword) return "same_as_old";
  return null;
}

/** i18n key for a code; unknown codes fall back to the generic failure text. */
export function passwordChangeMessageKey(code) {
  switch (code) {
    case "missing_fields": return "changePassword.missingFields";
    case "too_short": return "changePassword.tooShort";
    case "mismatch": return "changePassword.mismatch";
    case "same_as_old": return "changePassword.sameAsOld";
    case "wrong_current_password": return "changePassword.wrongCurrent";
    case "unauthorized": return "changePassword.sessionExpired";
    case "rate_limited": return "changePassword.rateLimited";
    case "partial_success": return "changePassword.partialSuccess";
    case "network": return "changePassword.networkError";
    default: return "changePassword.failed";
  }
}
