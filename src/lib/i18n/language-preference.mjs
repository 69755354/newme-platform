// S6 (review 4d #21): the chosen language used to live only in localStorage,
// which the server cannot read, so every page was first rendered in English
// and then switched to Chinese after hydration. The choice is now mirrored in
// a cookie that the root layout reads, so the very first HTML is already in
// the user's language. localStorage stays the source for older sessions; the
// first visit after this change copies it into the cookie.
export const LANGUAGE_COOKIE = "newme-lang";
export const DEFAULT_LANGUAGE = "en";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** "en" | "zh" for a valid stored value, otherwise null. */
export function parseLanguage(value) {
  return value === "en" || value === "zh" ? value : null;
}

/** document.cookie assignment for the chosen language (not sensitive, readable by JS). */
export function languageCookie(lang) {
  const valid = parseLanguage(lang) ?? DEFAULT_LANGUAGE;
  return `${LANGUAGE_COOKIE}=${valid}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

/**
 * What to do right after the first client render (never during it, see S13).
 * `stored` is the localStorage value, `rendered` the language the server HTML
 * and the first client render used (the cookie value, or null when absent).
 * Returns null when nothing needs to change, otherwise the language to show
 * and whether the cookie has to be (re)written to match the stored choice.
 */
export function languageAfterMount(stored, rendered) {
  const wanted = parseLanguage(stored);
  if (!wanted) return null;
  const shown = parseLanguage(rendered) ?? DEFAULT_LANGUAGE;
  const cookieMatches = parseLanguage(rendered) === wanted;
  if (wanted === shown && cookieMatches) return null;
  return { lang: wanted, writeCookie: !cookieMatches };
}
