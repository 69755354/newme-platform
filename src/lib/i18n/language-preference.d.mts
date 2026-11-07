export type Language = "en" | "zh";
export const LANGUAGE_COOKIE: "newme-lang";
export const DEFAULT_LANGUAGE: Language;
export function parseLanguage(value: unknown): Language | null;
export function languageCookie(lang: unknown): string;
export function languageAfterMount(stored: unknown, rendered: unknown): { lang: Language; writeCookie: boolean } | null;
