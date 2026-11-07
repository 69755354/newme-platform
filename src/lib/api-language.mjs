// S6b (4b-13): API routes that return a message a person will read answer in
// that person's language. The UI language is mirrored in the `newme-lang`
// cookie (see language-preference.mjs); callers without the cookie fall back to
// the browser's Accept-Language. Every such body also carries a stable `code`
// that the page maps to its own dictionary (apiErrors.*), so the screen text is
// right even when the server could not tell the language.
import { LANGUAGE_COOKIE, parseLanguage } from "./i18n/language-preference.mjs";

/** @param {Headers} headers @returns {"en"|"zh"} */
export function requestLanguage(headers) {
  const cookie = headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === LANGUAGE_COOKIE) {
      const fromCookie = parseLanguage(rest.join("=").trim());
      if (fromCookie) return fromCookie;
    }
  }
  const accept = (headers.get("accept-language") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return accept.startsWith("zh") ? "zh" : "en";
}

// Kept equal to apiErrors.contact_time_cannot_be_in_the_future in
// src/lib/i18n/translations.ts by tests/unit/s6b-followups.test.mjs.
const FUTURE_CONTACT_TIME = Object.freeze({
  en: "Contact time cannot be in the future.",
  zh: "联系时间不能晚于现在。",
});

/** @param {"en"|"zh"} lang */
export function futureContactTimeBody(lang) {
  return { error: FUTURE_CONTACT_TIME[lang] ?? FUTURE_CONTACT_TIME.en, code: "contact_time_cannot_be_in_the_future" };
}
