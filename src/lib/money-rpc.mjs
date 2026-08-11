/**
 * Translating a money routine's SQLSTATE into an HTTP status.
 *
 * The contract/payment routines in
 * supabase/migrations/20260812000000_money_actor_identity_and_atomicity.sql are
 * the only writers of contracts, installment_plans, contract_approvals and
 * payment_allocations (trg_guard_* refuses a direct write arriving as the
 * `authenticated` role), so a route's job is now to call one and report what it
 * said. Each routine raises with a deliberate errcode:
 *
 *   42501  the caller is not permitted to do this                    → 403
 *   22023  the request is invalid, or the transition is not allowed   → 400
 *   23505  it already exists (duplicate lead, converted quotation)    → 409
 *   P0002  the row does not exist                                     → 404
 *
 * Anything else is a database failure rather than a decision, and is reported as
 * 500 WITHOUT its message: an unmapped error can be a constraint violation or an
 * internal failure whose text quotes row values, and the routes must not relay
 * those. Mapped messages are safe to relay because they are authored in the
 * migration and carry only a contract number, a status name or a field name.
 *
 * The behaviour this replaces returned HTTP 200 with `{ error }` or `{ warning }`
 * in several of these cases, so a client could not tell a refusal from a success.
 *
 * This is .mjs rather than .ts so that tests/security/money-route-rpc-coupling
 * exercises the same function the routes import, instead of a re-implementation.
 */

/** SQLSTATEs the money routines raise on purpose, and what each means over HTTP. */
export const MONEY_RPC_STATUS = Object.freeze({
  "42501": 403,
  "22023": 400,
  "23505": 409,
  P0002: 404,
});

/** The HTTP status for an RPC error, or 500 when the code is not one we raise. */
export function moneyRpcStatus(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  return Object.prototype.hasOwnProperty.call(MONEY_RPC_STATUS, code)
    ? MONEY_RPC_STATUS[code]
    : 500;
}

/**
 * The status and body for a failed money RPC.
 *
 * `fallback` is the generic message used for unmapped codes; callers pass one that
 * names the operation ("Failed to create contract") so the client still gets
 * something actionable without any database text.
 */
export function moneyRpcFailure(error, fallback) {
  const status = moneyRpcStatus(error);
  if (status === 500) {
    return { status, body: { error: fallback } };
  }
  const message = error && typeof error.message === "string" ? error.message.trim() : "";
  return {
    status,
    body: { error: message || fallback, code: error?.code ?? undefined },
  };
}
