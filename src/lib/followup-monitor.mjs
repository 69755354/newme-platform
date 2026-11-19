// Sales follow-up monitor v1 (S21). Pure functions: the first response time, the number of contacts in the
// first 5 working days, the follow-up state and the system note wording. Nothing here reads the database.
// Times are epoch milliseconds or ISO strings; the calendar is the configured time zone (default Dubai,
// Monday to Friday). Elapsed time used by the state rules skips non-working days, so a weekend never ages a lead.

export const DEFAULT_FOLLOWUP_CONFIG = Object.freeze({
  timeZone: "Asia/Dubai",
  weekendDays: Object.freeze([0, 6]), // 0 = Sunday, 6 = Saturday
  holidays: Object.freeze([]), // "YYYY-MM-DD" in the configured time zone
  contactMergeMinutes: 30,
  windowWorkingDays: 5,
  firstResponseAtRiskMinutes: 60,
  firstResponseOverdueMinutes: 240,
  silenceAtRiskHours: 24,
  silenceOverdueHours: 48,
  abandonMaxContacts: 2,
  abandonSilenceHours: 48,
});

const MINUTE = 60_000;
const HOUR = 3_600_000;
const MAX_DAY_STEPS = 800;
const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

export function resolveFollowupConfig(overrides = {}) {
  const d = DEFAULT_FOLLOWUP_CONFIG;
  const o = overrides && typeof overrides === "object" ? overrides : {};
  let timeZone = d.timeZone;
  if (typeof o.timeZone === "string") {
    try { new Intl.DateTimeFormat("en-US", { timeZone: o.timeZone }); timeZone = o.timeZone; } catch { /* keep the default */ }
  }
  const weekendDays = Array.isArray(o.weekendDays) && o.weekendDays.every((n) => Number.isInteger(n) && n >= 0 && n <= 6) && o.weekendDays.length < 7
    ? [...o.weekendDays] : [...d.weekendDays];
  const holidays = Array.isArray(o.holidays) ? o.holidays.filter((x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)) : [...d.holidays];
  return {
    timeZone, weekendDays, holidays,
    contactMergeMinutes: positive(o.contactMergeMinutes, d.contactMergeMinutes),
    windowWorkingDays: Math.floor(positive(o.windowWorkingDays, d.windowWorkingDays)),
    firstResponseAtRiskMinutes: positive(o.firstResponseAtRiskMinutes, d.firstResponseAtRiskMinutes),
    firstResponseOverdueMinutes: positive(o.firstResponseOverdueMinutes, d.firstResponseOverdueMinutes),
    silenceAtRiskHours: positive(o.silenceAtRiskHours, d.silenceAtRiskHours),
    silenceOverdueHours: positive(o.silenceOverdueHours, d.silenceOverdueHours),
    abandonMaxContacts: Number.isInteger(o.abandonMaxContacts) && o.abandonMaxContacts >= 0 ? o.abandonMaxContacts : d.abandonMaxContacts,
    abandonSilenceHours: positive(o.abandonSilenceHours, d.abandonSilenceHours),
  };
}

const formatters = new Map();
function parts(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(timeZone, f);
  }
  const out = {};
  for (const p of f.formatToParts(new Date(ms))) out[p.type] = p.value;
  return { y: Number(out.year), m: Number(out.month), d: Number(out.day), h: Number(out.hour), min: Number(out.minute), s: Number(out.second), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(out.weekday) };
}
const offsetMs = (ms, timeZone) => { const p = parts(ms, timeZone); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000; };
const dayStartOf = (ms, timeZone) => { const p = parts(ms, timeZone); const guess = Date.UTC(p.y, p.m - 1, p.d); return guess - offsetMs(guess - offsetMs(guess, timeZone), timeZone); };
/** Start of the next local day (works across a 23 or 25 hour day because it re-reads the calendar). */
const nextDayStart = (dayStart, timeZone) => dayStartOf(dayStart + 36 * HOUR, timeZone);
const dayKey = (ms, timeZone) => { const p = parts(ms, timeZone); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };

export function isWorkingDay(ms, config = resolveFollowupConfig()) {
  const p = parts(ms, config.timeZone);
  if (config.weekendDays.includes(p.weekday)) return false;
  return !config.holidays.includes(dayKey(ms, config.timeZone));
}

/** Milliseconds between two instants that fall on working days. */
export function workingElapsedMs(fromMs, toMs, config = resolveFollowupConfig()) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  let total = 0;
  let start = dayStartOf(fromMs, config.timeZone);
  for (let i = 0; i < MAX_DAY_STEPS && start < toMs; i++) {
    const end = nextDayStart(start, config.timeZone);
    if (isWorkingDay(start + HOUR, config)) total += Math.max(0, Math.min(end, toMs) - Math.max(start, fromMs));
    start = end;
  }
  return total;
}

/** The window starts at the local midnight of the first customer message and covers N working days. */
export function windowBounds(firstInboundMs, config = resolveFollowupConfig()) {
  const startMs = dayStartOf(firstInboundMs, config.timeZone);
  let cursor = startMs;
  let counted = 0;
  for (let i = 0; i < MAX_DAY_STEPS; i++) {
    if (isWorkingDay(cursor + HOUR, config)) counted++;
    cursor = nextDayStart(cursor, config.timeZone);
    if (counted >= config.windowWorkingDays) break;
  }
  return { startMs, endMs: cursor };
}

/** Outbound messages that follow each other within `mergeMinutes` count as one contact; returns each contact's first time. */
export function mergeContacts(outboundMs, mergeMinutes = DEFAULT_FOLLOWUP_CONFIG.contactMergeMinutes) {
  const times = outboundMs.filter(Number.isFinite).sort((a, b) => a - b);
  const starts = [];
  let previous = -Infinity;
  for (const t of times) {
    if (t - previous > mergeMinutes * MINUTE) starts.push(t);
    previous = t;
  }
  return starts;
}

const toMs = (value) => (typeof value === "number" ? value : Date.parse(value));
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

/**
 * events: [{ direction: "inbound" | "outbound", occurredAt }] over every conversation of the lead.
 * Returns the metrics, the state (normal | at_risk | overdue), the reasons that opened it and the abandon-risk flag.
 * silenceRules=false (leads past the new and contacted stages) keeps only the first-response rule: no
 * silence rule and no abandon risk.
 */
export function evaluateFollowup({ events, now, config = resolveFollowupConfig(), silenceRules = true }) {
  const inbound = [];
  const outbound = [];
  for (const event of Array.isArray(events) ? events : []) {
    const t = toMs(event?.occurredAt);
    if (!Number.isFinite(t)) continue;
    if (event.direction === "inbound") inbound.push(t);
    else if (event.direction === "outbound") outbound.push(t);
  }
  const nowMs = toMs(now);
  const firstInbound = inbound.length ? Math.min(...inbound) : null;
  const lastOutbound = outbound.length ? Math.max(...outbound) : null;
  const firstReply = firstInbound === null ? null : outbound.filter((t) => t > firstInbound).reduce((a, b) => Math.min(a, b), Infinity);
  const reply = Number.isFinite(firstReply) ? firstReply : null;
  const result = {
    firstInboundAt: iso(firstInbound), firstReplyAt: iso(reply),
    firstResponseMinutes: firstInbound !== null && reply !== null ? Math.floor((reply - firstInbound) / MINUTE) : null,
    contactCount5wd: 0, lastOutboundAt: iso(lastOutbound), state: "normal", abandonRisk: false, reasons: [],
  };
  if (firstInbound === null) return result;

  const { startMs, endMs } = windowBounds(firstInbound, config);
  result.contactCount5wd = mergeContacts(outbound, config.contactMergeMinutes).filter((t) => t >= startMs && t < endMs).length;

  let rank = 0; // 0 normal, 1 at risk, 2 overdue
  if (reply === null) {
    const waitedMin = workingElapsedMs(firstInbound, nowMs, config) / MINUTE;
    if (waitedMin > config.firstResponseOverdueMinutes) rank = 2;
    else if (waitedMin > config.firstResponseAtRiskMinutes) rank = 1;
    if (rank) result.reasons.push("first_response");
  }
  if (!silenceRules) {
    result.state = ["normal", "at_risk", "overdue"][rank];
    return result;
  }
  const silentHours = workingElapsedMs(lastOutbound ?? firstInbound, nowMs, config) / HOUR;
  let silenceRank = 0;
  if (silentHours > config.silenceOverdueHours) silenceRank = 2;
  else if (silentHours > config.silenceAtRiskHours) silenceRank = 1;
  if (silenceRank) result.reasons.push("silence");
  rank = Math.max(rank, silenceRank);
  result.state = ["normal", "at_risk", "overdue"][rank];
  result.abandonRisk = result.contactCount5wd <= config.abandonMaxContacts && silentHours > config.abandonSilenceHours;
  return result;
}

const hhmm = (ms, timeZone) => { const p = parts(ms, timeZone); return `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`; };
function when(iso, nowMs, timeZone) {
  const t = Date.parse(iso);
  const time = hhmm(t, timeZone);
  return dayKey(t, timeZone) === dayKey(nowMs, timeZone) ? time : `${dayKey(t, timeZone).slice(5)} ${time}`;
}
const overPhrase = (minutes, config) => (minutes > config.firstResponseOverdueMinutes
  ? { zh: `超过 ${Math.round(config.firstResponseOverdueMinutes / 60)} 小时`, en: `over ${Math.round(config.firstResponseOverdueMinutes / 60)} hours` }
  : { zh: `超过 ${config.firstResponseAtRiskMinutes === 60 ? "1 小时" : `${config.firstResponseAtRiskMinutes} 分钟`}`, en: `over ${config.firstResponseAtRiskMinutes === 60 ? "1 hour" : `${config.firstResponseAtRiskMinutes} minutes`}` });
const hoursOf = (state, config) => (state === "overdue" ? config.silenceOverdueHours : config.silenceAtRiskHours);

/**
 * The system note and the notification wording for one change, or null when neither the state nor the
 * abandon-risk flag changed. previous: { state, abandonRisk }.
 */
export function buildFollowupNote({ result, previous, now, config = resolveFollowupConfig(), leadName = "" }) {
  const nowMs = toMs(now);
  const stateChanged = (previous?.state ?? "normal") !== result.state;
  const abandonChanged = Boolean(previous?.abandonRisk) !== result.abandonRisk;
  if (!stateChanged && !abandonChanged) return null;
  const tz = config.timeZone;
  const lines = [];
  if (stateChanged) {
    const inboundAt = result.firstInboundAt ? when(result.firstInboundAt, nowMs, tz) : "";
    if (result.state === "normal") {
      if (result.firstReplyAt && result.firstResponseMinutes !== null && result.firstResponseMinutes > config.firstResponseAtRiskMinutes) {
        const over = overPhrase(result.firstResponseMinutes, config);
        lines.push(`[系统] 客户 ${inboundAt} 来信，${when(result.firstReplyAt, nowMs, tz)} 才首次回复（${over.zh}）`);
        lines.push(`[System] Customer wrote at ${inboundAt}, first reply only at ${when(result.firstReplyAt, nowMs, tz)} (${over.en}).`);
      } else {
        lines.push("[系统] 跟进已恢复正常（我方已联系客户）");
        lines.push("[System] Follow-up is back to normal (we contacted the customer).");
      }
    } else if (result.reasons.includes("first_response")) {
      const waited = Math.floor((nowMs - Date.parse(result.firstInboundAt)) / MINUTE);
      const over = overPhrase(result.state === "overdue" ? config.firstResponseOverdueMinutes + 1 : waited, config);
      const label = result.state === "overdue" ? "已超时" : "有风险";
      const labelEn = result.state === "overdue" ? "overdue" : "at risk";
      lines.push(`[系统] 客户 ${inboundAt} 来信，至今未回复（${over.zh}），跟进${label}`);
      lines.push(`[System] Customer wrote at ${inboundAt} and has had no reply (${over.en}); follow-up ${labelEn}.`);
    } else {
      const h = hoursOf(result.state, config);
      const label = result.state === "overdue" ? "已超时" : "有风险";
      const labelEn = result.state === "overdue" ? "overdue" : "at risk";
      lines.push(`[系统] 距我方上次联系已超过 ${h} 小时，跟进${label}`);
      lines.push(`[System] More than ${h} hours since our last contact; follow-up ${labelEn}.`);
    }
  }
  if (abandonChanged) {
    if (result.abandonRisk) {
      lines.push(`[系统] 疑似放弃风险：5 个工作日内仅联系 ${result.contactCount5wd} 次，且超过 ${config.abandonSilenceHours} 小时无新联系`);
      lines.push(`[System] Abandon risk: only ${result.contactCount5wd} contact(s) in the first 5 working days and no new contact for over ${config.abandonSilenceHours} hours.`);
    } else {
      lines.push("[系统] 放弃风险已解除");
      lines.push("[System] Abandon risk cleared.");
    }
  }
  const warning = result.state === "overdue" || (abandonChanged && result.abandonRisk);
  const who = leadName ? `${leadName}: ` : "";
  const headline = result.abandonRisk && abandonChanged ? ["疑似放弃风险", "Abandon risk"]
    : result.state === "overdue" ? ["跟进已超时", "Follow-up overdue"]
      : result.state === "at_risk" ? ["跟进有风险", "Follow-up at risk"] : ["跟进已恢复", "Follow-up recovered"];
  return {
    note: lines.join("\n"),
    notificationType: warning ? "warning" : "reminder",
    title: `${headline[0]} / ${headline[1]}`,
    body: `${who}${lines.filter((l) => l.startsWith("[系统]")).map((l) => l.replace("[系统] ", "")).join("；")}`,
  };
}
