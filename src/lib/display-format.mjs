// One way to write money, dates and clock times on boss-facing screens (S37).
//   money   "AED 12,345"  whole dirhams, thousands separators, never "12K" or "12.5K"
//   dates   "22 Nov" / "11月22日"  (Dubai calendar day)
//   times   "14:05"  24-hour, Dubai time
//   a date-only value (a DATE column, "2026-11-22") is a calendar day, not an instant:
//   it never shows a clock time and never shifts across the time zone (it used to
//   print "04:00" because UTC midnight is 04:00 in Dubai).
const DUBAI = "Asia/Dubai";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isDateOnly(value) {
  return typeof value === "string" && DATE_ONLY.test(value.trim());
}

/** "AED 12,345". null / NaN -> "—". Amounts are rounded to whole dirhams. */
export function formatAED(value) {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n);
  const body = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${rounded < 0 ? "-" : ""}AED ${body}`;
}

function parts(value) {
  if (value === null || value === undefined || value === "") return null;
  if (isDateOnly(value)) {
    const [y, m, d] = value.trim().split("-").map(Number);
    return { year: y, month: m, day: d, hour: null, minute: null };
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: DUBAI, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(f.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** "22 Nov" (en) / "11月22日" (zh). */
export function formatShortDate(value, lang = "en") {
  const p = parts(value);
  if (!p) return "—";
  return lang === "zh" ? `${p.month}月${p.day}日` : `${p.day} ${MONTHS_EN[p.month - 1]}`;
}

/** "14:05" in Dubai time; "" for a date-only value (it has no clock time). */
export function formatDubaiTime(value) {
  const p = parts(value);
  if (!p || p.hour === null) return "";
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "22 Nov 14:05" / "11月22日 14:05"; just the date for a date-only value. */
export function formatDateTime(value, lang = "en") {
  const date = formatShortDate(value, lang);
  const time = formatDubaiTime(value);
  return time ? `${date} ${time}` : date;
}
