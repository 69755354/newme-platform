// Reason codes for Meta lead-intake failures (review 5-logging-monitoring F5).
// Only a short machine code is ever returned: never the Graph response body,
// token, lead fields or free-text error messages, so the result is safe to log
// and to send to Sentry.
const CODE = /^[a-z][a-z0-9_]{2,63}$/;
const KNOWN = new Set([
  "invalid_page_id", "invalid_lead", "invalid_lead_payload", "lead_identity_mismatch", "lead_id_unavailable",
  "lead_lookup_failed", "lead_merge_failed", "lead_insert_failed", "lead_event_not_queued",
  "invalid_leadgen_payload",
]);

/** Classify a thrown error into a stable, PII-free reason code. */
export function leadgenFailureReason(error) {
  const message = error instanceof Error ? error.message : "";
  if (/^graph_error_\d{1,6}$/.test(message)) return message;
  if (KNOWN.has(message)) return message;
  if (CODE.test(message) && message.includes("_")) return message;
  return "unexpected_error";
}
