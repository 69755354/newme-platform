const SUPPORT_REQUEST_FIELDS = new Set([
  "support_user_id",
  "organization_id",
  "ticket_ref",
  "reason",
  "scope",
  "expires_at",
  "idempotency_key",
]);

export function parseSupportSessionApprovalRequest(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== SUPPORT_REQUEST_FIELDS.size
    || keys.some((key) => !SUPPORT_REQUEST_FIELDS.has(key))) return null;
  const text = (field: string) => {
    const fieldValue = body[field];
    return typeof fieldValue === "string" && fieldValue.trim()
      ? fieldValue.trim()
      : null;
  };
  const supportUserId = text("support_user_id");
  const organizationId = text("organization_id");
  const ticketRef = text("ticket_ref");
  const reason = text("reason");
  const expiresAtInput = text("expires_at");
  const idempotencyKey = text("idempotency_key");
  const scope = body.scope;
  const expiresAtValue = expiresAtInput ? Date.parse(expiresAtInput) : Number.NaN;
  const expiresAt = Number.isFinite(expiresAtValue)
    ? new Date(expiresAtValue).toISOString()
    : null;
  if (!supportUserId || !organizationId || !ticketRef || !reason || !expiresAt
    || !idempotencyKey || idempotencyKey.length < 8
    || !Array.isArray(scope) || scope.length === 0
    || !scope.every((item) => item === "lead:read" || item === "lead:write")) {
    return null;
  }
  return {
    organizationId,
    idempotencyKey,
    payload: {
      support_user_id: supportUserId,
      organization_id: organizationId,
      ticket_ref: ticketRef,
      reason,
      scope,
      expires_at: expiresAt,
    },
  };
}
