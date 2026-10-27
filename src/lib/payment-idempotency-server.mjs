import { isRequestKeyConflict, resolveSpentKey } from "./payment-idempotency.mjs";

/**
 * Execute the user-scoped insert/read-back protocol at the server boundary.
 * This module is intentionally separate from the pure helpers imported by the
 * client page, so database mutations cannot become browser-reachable code.
 */
export async function recordPaymentWithKey({ supabase, creatorId, requestKey, intent }) {
  const { data: inserted, error: insertError } = await supabase
    .from("payments")
    .insert({
      ...intent,
      created_by: creatorId,
      confirmed: false,
      request_key: requestKey,
    })
    .select("id, amount")
    .single();

  if (!insertError) {
    return { outcome: "created", status: 201, payment: inserted, code: null, error: null };
  }

  if (!isRequestKeyConflict(insertError)) {
    return { outcome: "failed", status: 500, payment: null, code: null, error: insertError };
  }

  const { data: existing, error: lookupError } = await supabase
    .from("payments")
    .select("id, amount, contract_id, payment_date, payment_method, reference_no, notes")
    .eq("created_by", creatorId)
    .eq("request_key", requestKey)
    .maybeSingle();

  if (lookupError) {
    return {
      outcome: "opaque",
      status: 409,
      payment: null,
      code: "DUPLICATE_REQUEST",
      error: lookupError,
    };
  }

  const verdict = resolveSpentKey({ stored: existing, requested: intent });
  return { ...verdict, payment: existing ?? null, error: null };
}
