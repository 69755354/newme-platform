/**
 * The decisions POST /api/payments has to make about an idempotency key, as
 * plain functions.
 *
 * They live outside the route because they are the part worth testing by
 * running it. The route itself needs a request, a session and a database before
 * it does anything, so a test that only reads its source can assert that a
 * comparison is spelled there but not that the comparison is right — and
 * "recorded the payment twice" versus "refused a reused key" is exactly the
 * kind of thing a spelling check passes and a wrong implementation survives.
 * Same reason src/lib/forced-password-change.mjs is a module and not inline.
 */

/** Version-agnostic RFC 4122 form. Clients mint v4; accepting 1–5 costs nothing. */
export const PAYMENT_IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Roles that may record a payment against any contract.
 *
 * Recording is not settling: confirming and allocating are admin/boss/finance
 * only, enforced by confirm_payment() and allocate_payment(). Conflating the two
 * lists was round-3 finding P1-9, so they stay separate lists in separate places.
 */
export const PAYMENT_RECORDING_ROLES = Object.freeze(["admin", "boss", "finance", "operator"]);

/** Every role that may reach the dashboard; sales is narrowed to owned contracts. */
export const PAYMENT_PAGE_ROLES = Object.freeze([...PAYMENT_RECORDING_ROLES, "sales"]);

/** The exact values accepted by payments_payment_method_check in PostgreSQL. */
export const PAYMENT_METHODS = Object.freeze(["bank_transfer", "cash", "cheque", "card", "other"]);

/** Methods offered by the current form. Every member must also be a DB value. */
export const PAYMENT_UI_METHODS = PAYMENT_METHODS;

export function isPaymentMethod(value) {
  return typeof value === "string" && PAYMENT_METHODS.includes(value);
}

/**
 * The key a recording request carries, or null if it carries none we can use.
 *
 * Accepted in the body as `idempotencyKey`, matching the other routes here, or
 * in the `Idempotency-Key` header, which is where an HTTP client puts it. The
 * key must come from the caller: one minted here would be different on every
 * attempt, so every retry would record a new payment — that is the defect this
 * closes, not a fix for it.
 */
export function readIdempotencyKey({ body, headerValue } = {}) {
  const fromBody = body && typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const fromHeader = typeof headerValue === "string" ? headerValue.trim() : "";
  if (fromBody && fromHeader && fromBody.toLowerCase() !== fromHeader.toLowerCase()) return null;
  const candidate = (fromBody || fromHeader).toLowerCase();
  return PAYMENT_IDEMPOTENCY_KEY_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Money as an exact integer count of the smallest unit.
 *
 * Comparing amounts as floats would let 0.1 + 0.2 decide whether a retry is the
 * same payment. Returns null for anything that is not a finite number, so a
 * malformed amount can never compare equal to a stored one.
 */
export function paymentAmountMinorUnits(value) {
  let minor;
  if (typeof value === "string") {
    const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
    if (!match) return null;
    const whole = BigInt(match[1]);
    const fraction = BigInt((match[2] ?? "").padEnd(2, "0"));
    minor = whole * 100n + fraction;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    const scaled = value * 100;
    const rounded = Math.round(scaled);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
    if (Math.abs(scaled - rounded) > tolerance) return null;
    minor = BigInt(rounded);
  } else {
    return null;
  }

  // public.payments.amount is numeric(12,2): ten whole digits and two decimals.
  if (minor <= 0n || minor > 999_999_999_999n) return null;
  return Number(minor);
}

/** Empty and absent are the same thing here, because the route stores `|| null`. */
function orNull(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function optionalText(value) {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  return typeof value === "string" ? { ok: true, value } : { ok: false, value: null };
}

/**
 * The payment a request is asking to record, reduced to the fields that decide
 * whether two requests are asking for the same thing.
 *
 * Deliberately excludes `confirmed`, `created_by` and every timestamp: those are
 * decided by the server, not by the caller, so including them would compare the
 * server against itself. Accepts either an incoming request body or a row read
 * back from the database, which is the point — both sides normalise the same way.
 */
export function paymentIntentOf(source) {
  const row = source ?? {};
  return {
    contract_id: orNull(row.contract_id),
    amount: paymentAmountMinorUnits(row.amount),
    payment_date: typeof row.payment_date === "string" ? row.payment_date.slice(0, 10) : null,
    payment_method: orNull(row.payment_method),
    reference_no: orNull(row.reference_no),
    notes: orNull(row.notes),
  };
}

/**
 * Validate and canonicalise the caller-owned fields before touching PostgreSQL.
 * In particular, values such as 1.005 are refused instead of being rounded by
 * numeric(12,2) after the idempotency comparison has remembered a different
 * number.
 */
export function validatePaymentRecordInput(source) {
  const row = source ?? {};
  const contractId = typeof row.contract_id === "string" ? row.contract_id.trim() : "";
  if (!contractId) return { ok: false, error: "contract_id is required" };

  const amountMinor = typeof row.amount === "number" ? paymentAmountMinorUnits(row.amount) : null;
  if (amountMinor === null) {
    return { ok: false, error: "Amount must be positive and have at most two decimal places" };
  }

  const paymentDate = typeof row.payment_date === "string" ? row.payment_date.trim() : "";
  if (!isCalendarDate(paymentDate)) {
    return { ok: false, error: "payment_date must be a valid YYYY-MM-DD date" };
  }

  if (!isPaymentMethod(row.payment_method)) {
    return { ok: false, error: "Unsupported payment_method" };
  }

  const reference = optionalText(row.reference_no);
  const notes = optionalText(row.notes);
  if (!reference.ok || !notes.ok) {
    return { ok: false, error: "reference_no and notes must be text when provided" };
  }

  return {
    ok: true,
    intent: {
      contract_id: contractId,
      amount: amountMinor / 100,
      payment_date: paymentDate,
      payment_method: row.payment_method,
      reference_no: reference.value,
      notes: notes.value,
    },
  };
}

/**
 * Whether a retry is asking for the payment that was already recorded.
 *
 * A null amount never matches, including another null: an unreadable amount on
 * either side is not evidence that the two agree.
 */
export function paymentIntentsMatch(left, right) {
  const a = paymentIntentOf(left);
  const b = paymentIntentOf(right);
  if (a.amount === null || b.amount === null) return false;
  return (
    a.contract_id === b.contract_id &&
    a.amount === b.amount &&
    a.payment_date === b.payment_date &&
    a.payment_method === b.payment_method &&
    a.reference_no === b.reference_no &&
    a.notes === b.notes
  );
}

/**
 * Whether an insert error is the request-key index refusing a second payment
 * under a key that is already spent.
 *
 * Narrow on purpose. Every other 23505 on this table — a unique reference_no,
 * say — is a real conflict the caller has to hear about, and answering it with
 * "already recorded, here is your payment" would hand back an unrelated row.
 */
export function isRequestKeyConflict(error) {
  if (!error || error.code !== "23505") return false;
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.constraint ?? ""}`;
  return /request_key/i.test(text);
}

/**
 * What to answer once the key is known to be spent.
 *
 *   "replay"   the stored payment is the one being asked for; answer with it, so
 *              the retry gets what the first attempt would have returned
 *   "mismatch" the key is spent on a DIFFERENT payment; refuse, because the
 *              alternatives are recording a second payment or silently
 *              answering with someone's other one
 *   "opaque"   the row exists but this session cannot read it — a key reused
 *              across creators, or a contract writable but not readable here.
 *              Refuse without saying which: saying would leak the row.
 */
export function resolveSpentKey({ stored, requested }) {
  if (!stored) return { outcome: "opaque", status: 409, code: "DUPLICATE_REQUEST" };
  return paymentIntentsMatch(stored, requested)
    ? { outcome: "replay", status: 200, code: null }
    : { outcome: "mismatch", status: 409, code: "IDEMPOTENCY_KEY_REUSED" };
}

/**
 * Whether this caller may record this payment.
 *
 * Unchanged from what the route and the removed server action both applied: a
 * role is required, the recording roles may record against any contract, and
 * anyone else may record only against a contract they own.
 */
export function canRecordPayment({ role, contractSalesId, userId } = {}) {
  if (!role) return false;
  if (PAYMENT_RECORDING_ROLES.includes(role)) return true;
  return Boolean(userId) && contractSalesId === userId;
}
