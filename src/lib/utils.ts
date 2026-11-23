import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { formatDateTime, formatShortDate } from "./display-format.mjs"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format a date/time string to Dubai time (UTC+4). */
// S6 (review 4d section 4): dates used to be hard-coded "en-US", so the
// Chinese UI showed "Nov 2, 2026". Call sites now pass the interface locale
// explicitly (t("locale.dateLocale")). The default never reads the browser:
// the server and the first client render must format identically, otherwise
// React reports a hydration mismatch.
// S38: one date style everywhere ("22 Nov" / "11月22日", plus "14:05" when the caller
// asks for a clock time, always Dubai time). The Intl options a caller passes only
// decide whether a time is wanted and which language; month/year spelling is no
// longer chosen page by page. A date-only value never shows a clock time.
export function fmtDubai(d: string | Date | null | undefined, opts?: Intl.DateTimeFormatOptions & { locale?: string }): string {
  if (!d) return "—";
  const { locale = "en-US", ...fmtOpts } = opts || {};
  const lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  const wantsTime = fmtOpts.hour !== undefined || fmtOpts.minute !== undefined || fmtOpts.timeStyle !== undefined;
  return wantsTime ? formatDateTime(d, lang) : formatShortDate(d, lang);
}
