import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format a date/time string to Dubai time (UTC+4). */
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
