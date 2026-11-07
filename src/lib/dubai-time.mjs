// Company calendar: every "today / this week / this month / overdue" bucket in
// NEWME OS is a Dubai (Asia/Dubai, UTC+4, no daylight saving) calendar bucket.
//
// The production host runs in Asia/Shanghai (UTC+8) and the browsers run in
// whatever zone the user's device is in, so nothing here may use the process
// zone: no Date#getHours/getDate/getMonth/setHours, no `new Date(y, m, d)` and no
// `toISOString().slice(0, 10)` as a "date". All arithmetic is done on UTC fields
// of an instant shifted by the fixed Dubai offset, which gives the same answer on
// any server and in any browser.
//
// Bounds are half-open [start, end) instants (Date objects in UTC) that can be
// passed straight to `.gte(col, start.toISOString()).lt(col, end.toISOString())`.

export const DUBAI_TIME_ZONE = "Asia/Dubai";
export const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

function toInstant(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    // A bare calendar date is a Dubai calendar date, not UTC midnight.
    const m = DATE_KEY.exec(value);
    if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - DUBAI_OFFSET_MS);
    return new Date(value);
  }
  return new Date(NaN);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Wall-clock fields of `value` in Dubai, read from a UTC-shifted Date. */
function dubaiFields(value) {
  const shifted = new Date(toInstant(value).getTime() + DUBAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(), // 0-based
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0 = Sunday
  };
}

/** Instant of Dubai midnight at the start of the given Dubai calendar day. */
export function dubaiMidnight(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day) - DUBAI_OFFSET_MS);
}

/** "YYYY-MM-DD" of the Dubai calendar day containing `value` (default: now). */
export function dubaiDateKey(value = new Date()) {
  const instant = toInstant(value);
  if (Number.isNaN(instant.getTime())) return null;
  const { year, month, day } = dubaiFields(instant);
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** "YYYY-MM" of the Dubai calendar month containing `value` (default: now). */
export function dubaiMonthKey(value = new Date()) {
  const instant = toInstant(value);
  if (Number.isNaN(instant.getTime())) return null;
  const { year, month } = dubaiFields(instant);
  return `${year}-${pad(month + 1)}`;
}

export function isMonthKey(value) {
  return typeof value === "string" && MONTH_KEY.test(value);
}

/** Dubai calendar day containing `value`: [00:00, next 00:00) Dubai. */
export function dubaiDayBounds(value = new Date()) {
  const { year, month, day } = dubaiFields(value);
  const start = dubaiMidnight(year, month, day);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** Dubai week (Monday 00:00 to next Monday 00:00) containing `value`. */
export function dubaiWeekBounds(value = new Date()) {
  const { year, month, day, weekday } = dubaiFields(value);
  const sinceMonday = (weekday + 6) % 7;
  const start = dubaiMidnight(year, month, day - sinceMonday);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

/** Dubai calendar month "YYYY-MM": [1st 00:00, 1st of next month 00:00) Dubai. */
export function dubaiMonthBounds(monthKey) {
  if (!isMonthKey(monthKey)) throw new RangeError(`Invalid month key: ${monthKey}`);
  const [year, month] = monthKey.split("-").map(Number);
  return { start: dubaiMidnight(year, month - 1, 1), end: dubaiMidnight(year, month, 1) };
}

/** True when instant `value` lies in the half-open bounds. */
export function inBounds(value, bounds) {
  if (!value || !bounds) return false;
  const t = toInstant(value).getTime();
  if (Number.isNaN(t)) return false;
  return t >= bounds.start.getTime() && t < bounds.end.getTime();
}

function dayNumber(value) {
  const key = dubaiDateKey(value);
  if (!key) return null;
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/**
 * Whole Dubai calendar days from `from` to `to` (to - from). A follow-up due at
 * 23:00 Dubai yesterday is 1 day late at 01:00 Dubai today, the same answer as
 * one due at 08:00 yesterday. Returns null for missing/invalid input.
 */
export function dubaiDaysBetween(from, to = new Date()) {
  if (from === null || from === undefined || from === "") return null;
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (a === null || b === null) return null;
  return b - a;
}

/** "YYYY-MM-DD" + n Dubai calendar days. */
export function addDaysToDateKey(dateKey, days) {
  const m = DATE_KEY.exec(dateKey);
  if (!m) throw new RangeError(`Invalid date key: ${dateKey}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The current Dubai month and the previous n-1 months, newest first. */
export function recentDubaiMonthKeys(count, value = new Date()) {
  const { year, month } = dubaiFields(value);
  const keys = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(year, month - i, 1));
    keys.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
  }
  return keys;
}

/**
 * Share of month `monthKey` elapsed at `value`, in whole percent, measured in
 * Dubai days (day-of-month / days-in-month). Past months are 100, future 0.
 */
export function dubaiMonthElapsedPct(monthKey, value = new Date()) {
  const current = dubaiMonthKey(value);
  if (monthKey < current) return 100;
  if (monthKey > current) return 0;
  const { year, month, day } = dubaiFields(value);
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.round((day / daysInMonth) * 100);
}

/** "YYYY-MM-DD" key to a UTC-midnight Date (calendar arithmetic only). */
function keyToUtcDate(dateKey) {
  const m = DATE_KEY.exec(dateKey);
  if (!m) throw new RangeError(`Invalid date key: ${dateKey}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** ISO 8601 year and week number of the calendar day `dateKey`. */
export function isoWeekOfDateKey(dateKey) {
  const d = keyToUtcDate(dateKey);
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // the Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return { year: isoYear, week };
}

/**
 * The last `count` Dubai calendar weeks (Monday to Sunday), oldest first, the
 * last one being the week containing `value`. Each entry has instant bounds
 * [start, end) for timestamps and inclusive date keys for DATE columns.
 */
export function recentDubaiWeeks(count, value = new Date()) {
  const current = dubaiWeekBounds(value);
  const weeks = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(current.start.getTime() - i * 7 * DAY_MS);
    const end = new Date(start.getTime() + 7 * DAY_MS);
    const startKey = dubaiDateKey(start);
    const endKey = addDaysToDateKey(startKey, 6);
    const { year, week } = isoWeekOfDateKey(startKey);
    weeks.push({ year, week, start, end, startKey, endKey });
  }
  return weeks;
}

/** True when a DATE value ("YYYY-MM-DD") or instant falls in the week's Dubai days. */
export function inWeek(value, weekEntry) {
  if (!value) return false;
  const key = typeof value === "string" && DATE_KEY.test(value) ? value : dubaiDateKey(value);
  return key !== null && key >= weekEntry.startKey && key <= weekEntry.endKey;
}
