import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format a date/time string to Dubai time (UTC+4). */
// S6 (review 4d section 4): dates used to be hard-coded "en-US", so the
// Chinese UI showed "Nov 2, 2026". Call sites now pass the interface locale
// explicitly (t("locale.dateLocale")). The default never reads the browser:
// the server and the first client render must format identically, otherwise
// React reports a hydration mismatch.
export function fmtDubai(d: string | Date | null | undefined, opts?: Intl.DateTimeFormatOptions & { locale?: string }): string {
  if (!d) return "—";
  const { locale = "en-US", ...fmtOpts } = opts || {};
  const defaults: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
  return new Date(d).toLocaleDateString(locale, {
    ...defaults,
    ...fmtOpts,
    timeZone: "Asia/Dubai",
  });
}
