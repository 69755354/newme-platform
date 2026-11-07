/**
 * Object-storage download rules shared by /api/cos/download-url and its tests
 * (review 2-security F-07).
 *
 * 1. A key is checked for ownership by its first two path segments, then handed
 *    to the signing script unchanged. `leads/<own lead>/../../contracts/<other>/x`
 *    passed the ownership check as "own lead" while naming another object, so any
 *    key with a `..` is refused before anything else looks at it.
 * 2. The caller chose how long the signed link lives, with no upper bound. A
 *    link is now valid for at most one hour, whatever was asked.
 *
 * A .mjs module for the same reason as contract-access.mjs: node --test imports
 * the code the app ships.
 */

/** Longest a signed download link may live, in seconds. Also the default. */
export const COS_MAX_EXPIRES_SECONDS = 3600;
/** Shortest link worth signing; a smaller request is raised to this. */
export const COS_MIN_EXPIRES_SECONDS = 60;

const SAFE_KEY = /^[a-zA-Z0-9_/\-.]+$/;

/** Null when `key` is acceptable, otherwise the reason it is refused. */
export function cosKeyError(key) {
  if (typeof key !== "string" || key.length === 0) return "key is required";
  if (key.length > 512) return "Invalid key: too long";
  if (!SAFE_KEY.test(key)) return "Invalid key: contains unsafe characters";
  if (key.startsWith("/") || key.includes("//")) return "Invalid key: malformed path";
  // Judge whole path segments: "report..pdf" is a file name, ".." and "." are not.
  if (key.split("/").some((seg) => seg === ".." || seg === ".")) {
    return "Invalid key: path traversal is not allowed";
  }
  return null;
}

/**
 * Seconds a signed link should live for the requested `expires`.
 * Missing, non-numeric, zero or negative values get the default; anything above
 * the maximum is cut to it; fractions are rounded down.
 */
export function clampCosExpires(expires) {
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) {
    return COS_MAX_EXPIRES_SECONDS;
  }
  return Math.min(Math.max(Math.floor(expires), COS_MIN_EXPIRES_SECONDS), COS_MAX_EXPIRES_SECONDS);
}

/**
 * File name part of a contract object key. Anything outside A-Za-z0-9_.- (spaces
 * included) becomes "_" and runs of dots collapse to one, so the key built from
 * it always passes cosKeyError and can be downloaded again.
 */
export function sanitizeContractFilename(filename) {
  return String(filename).replace(/[^a-zA-Z0-9_.\-]/g, "_").replace(/\.{2,}/g, ".");
}
