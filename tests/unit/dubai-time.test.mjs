// S5: every date bucket is a Dubai calendar bucket, whatever zone the server
// process runs in (production runs Asia/Shanghai, UTC+8).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  addDaysToDateKey,
  dubaiDateKey,
  dubaiDayBounds,
  dubaiDaysBetween,
  dubaiMonthBounds,
  dubaiMonthElapsedPct,
  dubaiMonthKey,
  dubaiWeekBounds,
  inBounds,
  inWeek,
  isoWeekOfDateKey,
  recentDubaiMonthKeys,
  recentDubaiWeeks,
} from "../../src/lib/dubai-time.mjs";

test("month bounds start at Dubai midnight (20:00 UTC of the previous day)", () => {
  const { start, end } = dubaiMonthBounds("2026-11");
  assert.equal(start.toISOString(), "2026-10-31T20:00:00.000Z");
  assert.equal(end.toISOString(), "2026-11-30T20:00:00.000Z");
  const dec = dubaiMonthBounds("2026-12");
  assert.equal(dec.end.toISOString(), "2026-12-31T20:00:00.000Z");
  assert.throws(() => dubaiMonthBounds("2026-13"));
});

test("a won at 23:30 Dubai on the last day of the month belongs to that month", () => {
  const oct = dubaiMonthBounds("2026-10");
  const nov = dubaiMonthBounds("2026-11");
  const lastHalfHour = "2026-10-31T19:30:00.000Z"; // 23:30 Dubai, 03:30 Shanghai on 1 Nov
  assert.equal(inBounds(lastHalfHour, oct), true);
  assert.equal(inBounds(lastHalfHour, nov), false);
  const firstMinute = "2026-10-31T20:00:00.000Z"; // 00:00 Dubai 1 Nov
  assert.equal(inBounds(firstMinute, nov), true);
  assert.equal(inBounds(firstMinute, oct), false);
  assert.equal(dubaiMonthKey(lastHalfHour), "2026-10");
  assert.equal(dubaiMonthKey(firstMinute), "2026-11");
});

test("today is the Dubai day, not the UTC or server day", () => {
  // 01:00 Dubai on 3 Nov = 21:00 UTC on 2 Nov = 05:00 Shanghai on 3 Nov.
  const now = new Date("2026-11-02T21:00:00.000Z");
  assert.equal(dubaiDateKey(now), "2026-11-03");
  const { start, end } = dubaiDayBounds(now);
  assert.equal(start.toISOString(), "2026-11-02T20:00:00.000Z");
  assert.equal(end.toISOString(), "2026-11-03T20:00:00.000Z");
  // 22:00 Dubai on 3 Nov = 02:00 Shanghai on 4 Nov: still Dubai's 3 Nov.
  assert.equal(dubaiDateKey(new Date("2026-11-03T18:00:00.000Z")), "2026-11-03");
});

test("week starts Monday 00:00 Dubai", () => {
  // Sunday 8 Nov 2026 23:00 Dubai
  const { start, end } = dubaiWeekBounds(new Date("2026-11-08T19:00:00.000Z"));
  assert.equal(start.toISOString(), "2026-11-01T20:00:00.000Z"); // Mon 2 Nov 00:00 Dubai
  assert.equal(end.toISOString(), "2026-11-08T20:00:00.000Z");
});

test("overdue days are whole Dubai calendar days", () => {
  const now = new Date("2026-11-03T05:00:00.000Z"); // 09:00 Dubai 3 Nov
  assert.equal(dubaiDaysBetween("2026-11-02T19:00:00.000Z", now), 1); // 23:00 Dubai 2 Nov
  assert.equal(dubaiDaysBetween("2026-11-02T04:00:00.000Z", now), 1); // 08:00 Dubai 2 Nov
  assert.equal(dubaiDaysBetween("2026-11-02T21:00:00.000Z", now), 0); // 01:00 Dubai 3 Nov
  assert.equal(dubaiDaysBetween("2026-11-01", now), 2); // bare date = Dubai date
  assert.equal(dubaiDaysBetween(null, now), null);
  assert.equal(addDaysToDateKey("2026-12-28", 7), "2027-01-04");
});

test("month picker and target pacing use the Dubai month", () => {
  const now = new Date("2026-10-31T21:00:00.000Z"); // 01:00 Dubai 1 Nov
  assert.deepEqual(recentDubaiMonthKeys(3, now), ["2026-11", "2026-10", "2026-09"]);
  assert.equal(dubaiMonthElapsedPct("2026-11", now), 3); // day 1 of 30
  assert.equal(dubaiMonthElapsedPct("2026-10", now), 100);
  assert.equal(dubaiMonthElapsedPct("2026-12", now), 0);
});

test("results do not depend on the process time zone (Asia/Shanghai vs UTC)", () => {
  const moduleUrl = new URL("../../src/lib/dubai-time.mjs", import.meta.url).href;
  const script = `
    const m = await import(${JSON.stringify(moduleUrl)});
    const at = new Date("2026-10-31T19:30:00.000Z");
    console.log(JSON.stringify({
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      key: m.dubaiDateKey(at), month: m.dubaiMonthKey(at),
      day: m.dubaiDayBounds(at).start.toISOString(),
      monthStart: m.dubaiMonthBounds("2026-11").start.toISOString(),
      week: m.dubaiWeekBounds(at).start.toISOString(),
    }));`;
  const run = (tz) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ: tz }, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const shanghai = run("Asia/Shanghai");
  const utc = run("UTC");
  assert.equal(shanghai.tz, "Asia/Shanghai");
  assert.equal(shanghai.key, "2026-10-31");
  assert.equal(shanghai.month, "2026-10");
  const { tz: _a, ...a } = shanghai;
  const { tz: _b, ...b } = utc;
  assert.deepEqual(a, b);
});

test("ISO week numbers follow the calendar day, across year ends", () => {
  assert.deepEqual(isoWeekOfDateKey("2026-11-02"), { year: 2026, week: 45 });
  assert.deepEqual(isoWeekOfDateKey("2026-01-01"), { year: 2026, week: 1 });
  assert.deepEqual(isoWeekOfDateKey("2027-01-01"), { year: 2026, week: 53 });
  assert.deepEqual(isoWeekOfDateKey("2024-12-30"), { year: 2025, week: 1 });
});

test("twelve Dubai weeks, Monday to Sunday, oldest first", () => {
  const weeks = recentDubaiWeeks(12, new Date("2026-11-03T06:00:00Z"));
  assert.equal(weeks.length, 12);
  assert.equal(weeks.at(-1).startKey, "2026-11-02");
  assert.equal(weeks.at(-1).endKey, "2026-11-08");
  assert.equal(weeks.at(-1).start.toISOString(), "2026-11-01T20:00:00.000Z");
  assert.equal(weeks[0].startKey, "2026-08-17");
  assert.equal(weeks.at(-1).week, 45);
  // Sunday 22:00 Dubai (02:00 Monday in Shanghai) is still the previous week
  assert.equal(inBounds("2026-11-01T18:00:00Z", weeks.at(-2)), true);
  assert.equal(inBounds("2026-11-01T21:00:00Z", weeks.at(-1)), true);
  assert.equal(inWeek("2026-11-08", weeks.at(-1)), true);
  assert.equal(inWeek("2026-11-09", weeks.at(-1)), false);
});

test("week and month bucketing agree when the process runs in Asia/Shanghai", () => {
  const moduleUrl = new URL("../../src/lib/dubai-time.mjs", import.meta.url).href;
  const script = `
    const m = await import(${JSON.stringify(moduleUrl)});
    const weeks = m.recentDubaiWeeks(3, new Date("2026-11-01T17:30:00Z"));
    console.log(JSON.stringify({ weeks: weeks.map((w) => [w.startKey, w.week, w.start.toISOString()]), month: m.dubaiMonthKey(new Date("2026-11-01T17:30:00Z")) }));`;
  const run = (tz) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const shanghai = run("Asia/Shanghai");
  assert.deepEqual(shanghai, run("UTC"));
  assert.equal(shanghai.month, "2026-11"); // 21:30 Dubai on 1 Nov
});
