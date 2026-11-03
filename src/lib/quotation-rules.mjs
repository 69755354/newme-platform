/**
 * Quotation rules shared by the browser forms, the API routes and the tests.
 *
 * Two findings of the 2026-11-03 review (reports 0-总报告 §三, 4b #3, 4c #9-11):
 *
 * 1. Discount. Every discount input accepted any number: a salesperson saved a
 *    draft quote at 150% discount, total AED -2,205. The browser forms clamp to
 *    their own slider range, the routes refuse anything outside 0-100, and
 *    the engine clamps as a last line, so a total cannot go negative through any
 *    path the application owns. There is deliberately NO table constraint here:
 *    a new deferred migration has no release path under the current deploy gate
 *    (review reviews/s2.md B-2), so the bound lives in the application only.
 *    The browser forms save through the Supabase client, which is why each of
 *    them also refuses to save an out-of-range discount rather than only
 *    clamping the field.
 *
 * 2. Line items. quotations.devices_json has been written in three shapes over
 *    the life of the table, and every reader understood exactly one of them:
 *
 *      engine (POST /api/quotations/generate, Hermes):
 *        { "<device_id>": { name, qty, unit_price, line_total, unit } }
 *      calculator / wizard (the Quotes page "Create Quote" dialogs):
 *        [ { device_id, name, price, quantity, unit, subtotal } ]
 *      quotation detail page (/quotations/[id] add-product):
 *        [ { product_id, product_name, description, quantity, unit_price, total_price } ]
 *
 *    The detail page threw "Invalid quotation line item at index 0" on the
 *    second shape, the CSV export printed qty 0 / price 0 for it, and the quote
 *    dialog grouped it under "other" with a subtotal of AED 0.
 *    normalizeQuotationLineItems() reads all three into one shape, so every
 *    reader agrees on the same rows.
 *
 * A .mjs module (with a .d.mts) for the same reason as contract-access.mjs:
 * node --test imports it directly, so the tests check the code the app ships.
 */

/** The table constraint's bounds. Forms may use a narrower range of their own. */
export const DISCOUNT_RATE_MIN = 0;
export const DISCOUNT_RATE_MAX = 100;

/**
 * The value a browser discount field should hold for raw input `value`.
 * Non-numbers become 0; anything outside [0, max] is pulled to the nearest bound.
 */
export function clampDiscountRate(value, max = DISCOUNT_RATE_MAX) {
  const ceiling = Number.isFinite(max) ? Math.min(Math.max(max, 0), DISCOUNT_RATE_MAX) : DISCOUNT_RATE_MAX;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, DISCOUNT_RATE_MIN), ceiling);
}

/**
 * Server-side check. Returns null when `value` is an acceptable discount rate
 * (absent means 0), otherwise a message naming the problem. Never clamps: a
 * request asking for 150% is refused, not silently turned into 100%.
 */
export function discountRateError(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "discount_rate must be a number";
  }
  if (value < DISCOUNT_RATE_MIN || value > DISCOUNT_RATE_MAX) {
    return `discount_rate must be between ${DISCOUNT_RATE_MIN} and ${DISCOUNT_RATE_MAX}`;
  }
  return null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number from a number or a numeric string; otherwise undefined. */
function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(value) {
  return typeof value === "string" ? value : "";
}

function firstNumber(...values) {
  for (const value of values) {
    const n = num(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * One stored row (any of the three shapes) to the common shape, or throws with
 * the row's position when it carries no usable quantity or price.
 */
function normalizeOne(raw, fallbackId, position) {
  if (!isRecord(raw)) {
    throw new Error(`Invalid quotation line item at index ${position}`);
  }
  const quantity = firstNumber(raw.quantity, raw.qty);
  let unitPrice = firstNumber(raw.unit_price, raw.price);
  let lineTotal = firstNumber(raw.total_price, raw.line_total, raw.subtotal);
  if (quantity === undefined || (unitPrice === undefined && lineTotal === undefined)) {
    throw new Error(`Invalid quotation line item at index ${position}`);
  }
  if (unitPrice === undefined) unitPrice = quantity === 0 ? 0 : round2(lineTotal / quantity);
  if (lineTotal === undefined) lineTotal = round2(unitPrice * quantity);
  const id = str(raw.product_id) || str(raw.device_id) || str(raw.id) || fallbackId;
  return {
    id,
    name: str(raw.product_name) || str(raw.name) || id,
    description: str(raw.description),
    quantity,
    unit_price: unitPrice,
    line_total: lineTotal,
    unit: str(raw.unit),
  };
}

/**
 * Every line item stored in `devicesJson`, in storage order, in one shape:
 * `{ id, name, description, quantity, unit_price, line_total, unit }`.
 * null / undefined is no items. Throws on a value that is not one of the shapes.
 */
export function normalizeQuotationLineItems(devicesJson) {
  if (devicesJson === null || devicesJson === undefined) return [];
  if (Array.isArray(devicesJson)) {
    return devicesJson.map((raw, index) => normalizeOne(raw, `item-${index + 1}`, index));
  }
  if (isRecord(devicesJson)) {
    return Object.entries(devicesJson).map(([key, raw], index) => normalizeOne(raw, key, index));
  }
  throw new Error("Quotation line items must be a JSON array or object");
}

/** Sum of the normalized line totals, to the cent. */
export function lineItemsSubtotal(items) {
  return round2(items.reduce((sum, item) => sum + (Number.isFinite(item.line_total) ? item.line_total : 0), 0));
}
