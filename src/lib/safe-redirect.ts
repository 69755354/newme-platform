/**
 * Post-login redirect validation.
 *
 * src/app/login/page.tsx used to navigate straight to whatever arrived in the
 * `redirect` query parameter:
 *
 *     const redirectTo = searchParams.get("redirect") || "/dashboard";
 *     router.push(redirectTo);
 *
 * That is an open redirect on the sign-in page, which is the worst place to have
 * one: a link to
 * https://app.newme.ae/login?redirect=https://app-newme.example/login lands the
 * victim on the real, HTTPS, correct-domain login form, and the moment they
 * authenticate they are handed to an attacker-controlled page that can present a
 * convincing "session expired, sign in again" prompt. The credential is then
 * typed on the attacker's page, not ours.
 *
 * Only a same-origin path is allowed. Everything else falls back to the default.
 * Rejection is silent by design: a bad `redirect` is not the user's fault and
 * must not block sign-in.
 */

export const DEFAULT_REDIRECT = "/dashboard";

const MAX_REDIRECT_LENGTH = 512;

// C0 controls, space, and DEL. Browsers strip tab/newline/CR before resolving a
// URL, so "/	/evil.com" must never reach a router.
const FORBIDDEN_CHARS = /[\u0000-\u0020\u007f]/;

export function safeRedirectPath(
  value: unknown,
  fallback: string = DEFAULT_REDIRECT,
): string {
  if (typeof value !== "string") return fallback;

  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_REDIRECT_LENGTH) return fallback;

  // Must be a path, not a URL. Anything carrying a scheme or an authority is out.
  if (!candidate.startsWith("/")) return fallback;

  // "//host" and "/\host" are protocol-relative: same-origin to a naive check,
  // another site to a browser. Backslash is normalised to "/" by browsers, so it
  // is treated as a separator here too.
  if (candidate.startsWith("//")) return fallback;
  if (candidate.includes("\\")) return fallback;

  if (FORBIDDEN_CHARS.test(candidate)) return fallback;

  // Belt and braces: resolve against a throwaway origin and confirm nothing
  // escaped it. Catches anything the checks above did not anticipate.
  let resolved: URL;
  try {
    resolved = new URL(candidate, "https://redirect-validation.invalid");
  } catch {
    return fallback;
  }
  if (resolved.origin !== "https://redirect-validation.invalid") return fallback;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
