import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FOLLOWUP_CONFIG, resolveFollowupConfig, isWorkingDay, workingElapsedMs, windowBounds, mergeContacts,
  evaluateFollowup, buildFollowupNote,
} from "../../src/lib/followup-monitor.mjs";

// Dubai is UTC+4. 2026-11-16 is a Monday; 2026-11-20 Friday; 2026-11-21 Saturday; 2026-11-22 Sunday.
const at = (iso) => Date.parse(iso);
const dubai = (day, hm) => Date.parse(`${day}T${hm}:00+04:00`);
const cfg = resolveFollowupConfig();
const inb = (t) => ({ direction: "inbound", occurredAt: t });
const out = (t) => ({ direction: "outbound", occurredAt: t });

test("defaults follow the design", () => {
  assert.equal(DEFAULT_FOLLOWUP_CONFIG.timeZone, "Asia/Dubai");
  assert.deepEqual([...DEFAULT_FOLLOWUP_CONFIG.weekendDays].sort(), [0, 6]);
  assert.equal(DEFAULT_FOLLOWUP_CONFIG.contactMergeMinutes, 30);
  assert.equal(DEFAULT_FOLLOWUP_CONFIG.firstResponseAtRiskMinutes, 60);
  assert.equal(DEFAULT_FOLLOWUP_CONFIG.firstResponseOverdueMinutes, 240);
  assert.equal(DEFAULT_FOLLOWUP_CONFIG.silenceAtRiskHours, 24);
  assert.equal(DEFAULT_FOLLOWUP_CONFIG.silenceOverdueHours, 48);
  assert.equal(DEFAULT_FOLLOWUP_CONFIG.windowWorkingDays, 5);
});

test("config overrides are validated, bad values fall back", () => {
  assert.equal(resolveFollowupConfig({ contactMergeMinutes: 10 }).contactMergeMinutes, 10);
  assert.equal(resolveFollowupConfig({ contactMergeMinutes: -5 }).contactMergeMinutes, 30);
  assert.equal(resolveFollowupConfig({ timeZone: "Not/AZone" }).timeZone, "Asia/Dubai");
  assert.deepEqual(resolveFollowupConfig({ weekendDays: [5, 6] }).weekendDays, [5, 6]);
});

test("working days are Monday to Friday in Dubai, holidays are configurable", () => {
  assert.equal(isWorkingDay(dubai("2026-11-16", "10:00"), cfg), true);
  assert.equal(isWorkingDay(dubai("2026-11-20", "10:00"), cfg), true);
  assert.equal(isWorkingDay(dubai("2026-11-21", "10:00"), cfg), false);
  assert.equal(isWorkingDay(dubai("2026-11-22", "10:00"), cfg), false);
  // 23:30 UTC on Friday is already Saturday 03:30 in Dubai
  assert.equal(isWorkingDay(at("2026-11-20T23:30:00Z"), cfg), false);
  assert.equal(isWorkingDay(dubai("2026-12-02", "10:00"), resolveFollowupConfig({ holidays: ["2026-12-02"] })), false);
});

test("elapsed time skips non-working days", () => {
  const H = 3_600_000;
  assert.equal(workingElapsedMs(dubai("2026-11-16", "10:00"), dubai("2026-11-16", "12:30"), cfg), 2.5 * H);
  // Friday 18:00 to Monday 06:00 = 6h Friday + 6h Monday
  assert.equal(workingElapsedMs(dubai("2026-11-20", "18:00"), dubai("2026-11-23", "06:00"), cfg), 12 * H);
  assert.equal(workingElapsedMs(dubai("2026-11-21", "10:00"), dubai("2026-11-22", "20:00"), cfg), 0);
  assert.equal(workingElapsedMs(100, 50, cfg), 0);
});

test("the 5 working day window skips the weekend", () => {
  const w = windowBounds(dubai("2026-11-18", "10:00"), cfg); // Wednesday: Wed Thu Fri Mon Tue
  assert.equal(w.startMs, dubai("2026-11-18", "00:00"));
  assert.equal(w.endMs, dubai("2026-11-25", "00:00"));
  const sat = windowBounds(dubai("2026-11-21", "10:00"), cfg); // Saturday: starts counting Monday
  assert.equal(sat.endMs, dubai("2026-11-28", "00:00") + 0 * 1);
});

test("messages close together merge into one contact", () => {
  const m = (min) => at("2026-11-18T06:00:00Z") + min * 60_000;
  assert.equal(mergeContacts([m(0), m(5), m(29), m(50)], 30).length, 1); // each within 30 minutes of the one before
  assert.equal(mergeContacts([m(0), m(5), m(90)], 30).length, 2);
  assert.equal(mergeContacts([], 30).length, 0);
  assert.equal(mergeContacts([m(90), m(0), m(5)], 30).length, 2); // order does not matter
});

test("first response: whole minutes from the first customer message to the first later reply", () => {
  const r = evaluateFollowup({ events: [inb(dubai("2026-11-18", "10:05")), out(dubai("2026-11-18", "11:40")), out(dubai("2026-11-18", "11:41"))], now: dubai("2026-11-18", "11:45"), config: cfg });
  assert.equal(r.firstResponseMinutes, 95);
  assert.equal(r.firstInboundAt, new Date(dubai("2026-11-18", "10:05")).toISOString());
  assert.equal(r.firstReplyAt, new Date(dubai("2026-11-18", "11:40")).toISOString());
  assert.equal(r.contactCount5wd, 1);
  assert.equal(r.state, "normal");
});

test("an outbound message before the first inbound is not a reply", () => {
  const r = evaluateFollowup({ events: [out(dubai("2026-11-18", "09:00")), inb(dubai("2026-11-18", "10:00"))], now: dubai("2026-11-18", "10:30"), config: cfg });
  assert.equal(r.firstReplyAt, null);
  assert.equal(r.firstResponseMinutes, null);
});

test("no reply: at risk after 60 minutes, overdue after 240", () => {
  const events = [inb(dubai("2026-11-18", "10:00"))];
  assert.equal(evaluateFollowup({ events, now: dubai("2026-11-18", "10:59"), config: cfg }).state, "normal");
  assert.equal(evaluateFollowup({ events, now: dubai("2026-11-18", "11:01"), config: cfg }).state, "at_risk");
  assert.equal(evaluateFollowup({ events, now: dubai("2026-11-18", "13:59"), config: cfg }).state, "at_risk");
  const late = evaluateFollowup({ events, now: dubai("2026-11-18", "14:01"), config: cfg });
  assert.equal(late.state, "overdue");
  assert.deepEqual(late.reasons, ["first_response"]);
});

test("silence after contact: 24 hours at risk, 48 hours overdue, measured on working days only", () => {
  const events = [inb(dubai("2026-11-16", "09:00")), out(dubai("2026-11-16", "09:10"))];
  assert.equal(evaluateFollowup({ events, now: dubai("2026-11-17", "09:00"), config: cfg }).state, "normal");
  const risk = evaluateFollowup({ events, now: dubai("2026-11-17", "09:11"), config: cfg });
  assert.equal(risk.state, "at_risk");
  assert.deepEqual(risk.reasons, ["silence"]);
  assert.equal(evaluateFollowup({ events, now: dubai("2026-11-18", "09:11"), config: cfg }).state, "overdue");
  // Friday contact, checked on Saturday and Sunday: the weekend does not age it
  const friday = [inb(dubai("2026-11-20", "09:00")), out(dubai("2026-11-20", "09:10"))];
  assert.equal(evaluateFollowup({ events: friday, now: dubai("2026-11-22", "20:00"), config: cfg }).state, "normal");
  assert.equal(evaluateFollowup({ events: friday, now: dubai("2026-11-23", "10:00"), config: cfg }).state, "at_risk");
});

test("a fresh outbound message brings the state back to normal", () => {
  const events = [inb(dubai("2026-11-16", "09:00")), out(dubai("2026-11-16", "09:10")), out(dubai("2026-11-18", "10:00"))];
  assert.equal(evaluateFollowup({ events, now: dubai("2026-11-18", "10:05"), config: cfg }).state, "normal");
});

test("abandon risk: at most 2 contacts and 48 working hours without a new one", () => {
  const events = [inb(dubai("2026-11-16", "09:00")), out(dubai("2026-11-16", "09:10")), out(dubai("2026-11-16", "15:00"))];
  const r = evaluateFollowup({ events, now: dubai("2026-11-18", "15:01"), config: cfg });
  assert.equal(r.contactCount5wd, 2);
  assert.equal(r.abandonRisk, true);
  assert.equal(evaluateFollowup({ events, now: dubai("2026-11-18", "14:00"), config: cfg }).abandonRisk, false);
  const busy = [inb(dubai("2026-11-16", "09:00")), out(dubai("2026-11-16", "09:10")), out(dubai("2026-11-16", "15:00")), out(dubai("2026-11-16", "18:00"))];
  assert.equal(evaluateFollowup({ events: busy, now: dubai("2026-11-18", "19:00"), config: cfg }).abandonRisk, false);
});

test("contacts count only inside the 5 working day window", () => {
  const events = [inb(dubai("2026-11-16", "09:00")), out(dubai("2026-11-16", "09:10")), out(dubai("2026-11-19", "10:00")), out(dubai("2026-11-23", "10:00")), out(dubai("2026-11-24", "10:00"))];
  // the window is Mon 16 to Fri 20; Mon 23 and Tue 24 are working days 6 and 7 and do not count
  const r = evaluateFollowup({ events, now: dubai("2026-11-24", "11:00"), config: cfg });
  assert.equal(r.contactCount5wd, 2);
});

test("no customer message at all is normal with empty metrics; bad events are ignored", () => {
  const r = evaluateFollowup({ events: [out(dubai("2026-11-16", "09:10")), { direction: "sideways", occurredAt: 1 }, { direction: "inbound", occurredAt: Number.NaN }], now: dubai("2026-11-18", "09:00"), config: cfg });
  assert.equal(r.state, "normal");
  assert.equal(r.firstInboundAt, null);
  assert.equal(r.firstResponseMinutes, null);
});

test("events may carry ISO strings", () => {
  const r = evaluateFollowup({ events: [{ direction: "inbound", occurredAt: "2026-11-18T06:00:00Z" }, { direction: "outbound", occurredAt: "2026-11-18T06:20:00Z" }], now: at("2026-11-18T06:30:00Z"), config: cfg });
  assert.equal(r.firstResponseMinutes, 20);
});

test("notes are bilingual, name the times in Dubai and describe the change", () => {
  const events = [inb(dubai("2026-11-18", "10:05")), out(dubai("2026-11-18", "11:40"))];
  const now = dubai("2026-11-18", "11:45");
  const recovered = buildFollowupNote({ result: evaluateFollowup({ events, now, config: cfg }), previous: { state: "at_risk", abandonRisk: false }, now, config: cfg });
  assert.match(recovered.note, /\[系统\] 客户 10:05 来信，11:40 才首次回复（超过 1 小时）/);
  assert.match(recovered.note, /\[System\] Customer wrote at 10:05, first reply only at 11:40 \(over 1 hour\)/);
  const waiting = evaluateFollowup({ events: [inb(dubai("2026-11-18", "10:05"))], now: dubai("2026-11-18", "11:20"), config: cfg });
  const atRisk = buildFollowupNote({ result: waiting, previous: { state: "normal", abandonRisk: false }, now: dubai("2026-11-18", "11:20"), config: cfg });
  assert.match(atRisk.note, /10:05/);
  assert.match(atRisk.note, /未回复/);
  assert.equal(atRisk.notificationType, "reminder");
  const overdue = evaluateFollowup({ events: [inb(dubai("2026-11-18", "10:05"))], now: dubai("2026-11-18", "15:00"), config: cfg });
  assert.equal(buildFollowupNote({ result: overdue, previous: { state: "at_risk", abandonRisk: false }, now: dubai("2026-11-18", "15:00"), config: cfg }).notificationType, "warning");
  const same = buildFollowupNote({ result: waiting, previous: { state: "at_risk", abandonRisk: false }, now: dubai("2026-11-18", "11:20"), config: cfg });
  assert.equal(same, null);
});

test("abandon risk on and off each get a note", () => {
  const events = [inb(dubai("2026-11-16", "09:00")), out(dubai("2026-11-16", "09:10"))];
  const now = dubai("2026-11-18", "09:11");
  const result = evaluateFollowup({ events, now, config: cfg });
  assert.equal(result.abandonRisk, true);
  const on = buildFollowupNote({ result, previous: { state: result.state, abandonRisk: false }, now, config: cfg });
  assert.match(on.note, /放弃|abandon/i);
  assert.equal(on.notificationType, "warning");
  const off = buildFollowupNote({ result: { ...result, abandonRisk: false }, previous: { state: result.state, abandonRisk: true }, now, config: cfg });
  assert.match(off.note, /解除|cleared/i);
});

test("past the new and contacted stages only the first-response rule applies", () => {
  const events = [inb(dubai("2026-11-16", "09:00")), out(dubai("2026-11-16", "09:10"))];
  const r = evaluateFollowup({ events, now: dubai("2026-11-20", "09:00"), config: cfg, silenceRules: false });
  assert.equal(r.state, "normal");
  assert.equal(r.abandonRisk, false);
  const waiting = evaluateFollowup({ events: [inb(dubai("2026-11-16", "09:00"))], now: dubai("2026-11-16", "15:00"), config: cfg, silenceRules: false });
  assert.equal(waiting.state, "overdue");
});
