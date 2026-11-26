// Daily brief section: which salespeople are behind on feedback. Sales write "Day 1..5 feedback" in their own sheets (they rarely set
// "Lead quality", which this section deliberately ignores). Per salesperson it lists
//   (a) leads assigned 1+ day ago whose Day 1 feedback is still empty, and
//   (b) leads assigned 3+ days ago whose newest feedback is only a "no answer" type note (time for another try).
// Pure helpers (no network, no disk). Output holds salesperson names, counts and lead refs (Master Lead ID): no customer data.
import { parseSheetTime } from "./drive-sync.mjs";

export const FEEDBACK_REGISTER = Object.freeze({ spreadsheetId: "1t8ZbfF8hmv51KcNfWuwLPPII1IGMc6AWJgfxlCAew7w", tab: "Lead Register", range: "A5:AS2000" });
/** Sales tabs with Day 1..5 columns (header row 7); joined to the register by Lead key = Master Lead ID. The B2B tab has no Day columns. */
export const FEEDBACK_SALES_TABS = Object.freeze([
  { spreadsheetId: "1GUP1mpCAm74XHi4m6WEJdQxKQZ--3OSoVIbmunJG4_w", tab: "Leads", range: "A7:AD2000" },
  { spreadsheetId: "1LTcddlbx_63rQ1zPVLsfdRqxhDPlmwpXvNCrJsNILyc", tab: "B2C Leads", range: "A7:AD2000" },
  { spreadsheetId: "15b7Og5w6I55lZfOdFISC7pb12zPibfiLNVo1_B5D9ss", tab: "Leads - Daily", range: "A7:AD2000" },
]);
export const NO_FEEDBACK_AFTER_DAYS = 1;
export const STALE_AFTER_DAYS = 3;
const DAY = 86_400_000;
const DAYS = ["Day 1 feedback", "Day 2 feedback", "Day 3 feedback", "Day 4 feedback", "Day 5 feedback"];
// The sales sheets use several headers for the free-text follow-up column (same list as scripts/lib/drive-sync-sources.mjs).
const LATER_ALIASES = ["Later follow-ups / previous records", "Later follow-ups / B2B notes", "Follow-up notes", "Previous records", "Sales feedback"];
const s = (v) => (v === null || v === undefined ? "" : String(v).trim());
// Feedback that says the customer was not reached (English and Chinese wording the sales team uses).
const NO_ANSWER = /\b(no[\s-]*answer|not\s+answer(ed|ing)?|did(n'?t| not)\s+(pick|answer)|no\s+(reply|response)|unreachable|not\s+reachable|switched\s+off|voice\s?mail|busy|n\/?a)\b|无人接听|没接|未接|关机|无应答|不接/i;
const NO_ANSWER_MAX_FILLER_WORDS = 3; // "tried twice", "called again": a short fragment next to the no-answer phrase adds no news
// A note that only promises another attempt ("will try calling again tomorrow", "call back later", 明天再打) is still no contact.
const RETRY_ONLY_MAX_WORDS = 8; // longer sentences carry news beyond the retry
const RETRY_ONLY = /\b(try|trying|tried|call(ing|ed)?|calling|ring|reach|follow[\s-]*up|contact|attempt|message|whatsapp|text)\b.*\b(again|later|tomorrow|back|next|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(call[\s-]*back|retry|re-?attempt)\b|再(打|联系|试|拨)|稍后|明天|下次|回电/i;
/**
 * True only when the whole note says the customer was not reached. A note that mentions "busy" or "no answer" but also
 * records real contact ("Was busy, confirmed interest and asked for a quote") is substantive feedback.
 */
export const isNoAnswer = (text) => {
  const note = s(text);
  if (!NO_ANSWER.test(note)) return false;
  const segments = note.split(/[\n.;,!?]+|[،؛]/).map((x) => x.trim()).filter(Boolean);
  return segments.every((seg) => {
    if (NO_ANSWER.test(seg)) return true;
    const words = seg.replace(/[\d:/\\-]+/g, " ").split(/\s+/).filter((w) => /[\p{L}]/u.test(w));
    if (words.length <= NO_ANSWER_MAX_FILLER_WORDS) return true;
    return words.length <= RETRY_ONLY_MAX_WORDS && RETRY_ONLY.test(seg);
  });
};

const index = (head, names) => Object.fromEntries(names.map((n) => [n, head.indexOf(n)]));
const headOf = (grid) => (grid?.[0] ?? []).map(s);

/** Sales rows by Lead key: { days: [Day 1..5 text], later }. Throws when a tab lacks its columns. */
export function indexSalesRows(grids) {
  const byKey = new Map();
  for (const grid of grids) {
    const head = headOf(grid);
    const c = index(head, ["Lead key", ...DAYS, ...LATER_ALIASES]);
    const laterCols = LATER_ALIASES.map((n) => c[n]).filter((i) => i >= 0);
    if (c["Lead key"] < 0 || c["Day 1 feedback"] < 0) throw new Error("sales_header_mismatch");
    for (const row of grid.slice(1)) {
      const key = s(row[c["Lead key"]]);
      if (!key) continue;
      const entry = { days: DAYS.map((d) => (c[d] >= 0 ? s(row[c[d]]) : "")), later: laterCols.map((i) => s(row[i])).filter(Boolean).join("\n") };
      const prev = byKey.get(key);
      byKey.set(key, prev ? { days: entry.days.map((v, i) => v || prev.days[i]), later: entry.later || prev.later } : entry);
    }
  }
  return byKey;
}

/**
 * registerGrid / salesGrids: values from the header row (index 0 = header). Leads without a matching sales row are not judged.
 * Returns { people: [{name, noFeedback: {count, oldest[]}, stale: {count, oldest[]}}], noFeedbackTotal, staleTotal }, biggest backlog first.
 */
export function summarizeFeedbackBacklog(registerGrid, salesGrids, { now = new Date(), refsPerPerson = 3 } = {}) {
  const head = headOf(registerGrid);
  const c = index(head, ["Assigned to", "Assigned at", "Test record", "Master Lead ID", "Dispatch status", "Opportunity stage"]);
  for (const name of ["Assigned to", "Assigned at", "Test record", "Master Lead ID"]) if (c[name] < 0) throw new Error("register_header_mismatch");
  const sales = indexSalesRows(salesGrids);
  const by = new Map();
  const add = (name, kind, ref, ms) => {
    if (!by.has(name)) by.set(name, { name, noFeedback: [], stale: [] });
    by.get(name)[kind].push({ ref, ms });
  };
  for (const row of registerGrid.slice(1)) {
    const ref = s(row[c["Master Lead ID"]]);
    const owner = s(row[c["Assigned to"]]).slice(0, 40);
    if (!ref || !owner) continue;
    if (s(row[c["Test record"]]).toLowerCase() === "yes") continue;
    const dispatch = c["Dispatch status"] >= 0 ? s(row[c["Dispatch status"]]).toLowerCase() : "";
    if (/^excluded|duplicate - not dispatched/.test(dispatch)) continue;
    const stage = c["Opportunity stage"] >= 0 ? s(row[c["Opportunity stage"]]).toLowerCase() : "";
    if (/\b(won|lost|closed|dead|invalid|not interested)\b/.test(stage)) continue;
    const at = parseSheetTime(row[c["Assigned at"]]).iso;
    if (!at) continue; // no readable assignment time: its age is unknown
    const ms = Date.parse(at);
    const age = now.getTime() - ms;
    const fb = sales.get(ref);
    if (!fb) continue; // not in a sales sheet (yet): cannot say anything about feedback
    const filled = [...fb.days, fb.later].filter(Boolean);
    if (!fb.days[0] && age >= NO_FEEDBACK_AFTER_DAYS * DAY) add(owner, "noFeedback", ref.slice(0, 40), ms);
    else if (filled.length && age >= STALE_AFTER_DAYS * DAY && isNoAnswer(filled.at(-1))) add(owner, "stale", ref.slice(0, 40), ms);
  }
  const pack = (items) => { items.sort((a, b) => a.ms - b.ms); return { count: items.length, oldest: items.slice(0, refsPerPerson).map((i) => i.ref) }; };
  const people = [...by.values()].map((p) => ({ name: p.name, noFeedback: pack(p.noFeedback), stale: pack(p.stale) }))
    .sort((a, b) => (b.noFeedback.count + b.stale.count) - (a.noFeedback.count + a.stale.count) || a.name.localeCompare(b.name));
  return { people, noFeedbackTotal: people.reduce((n, p) => n + p.noFeedback.count, 0), staleTotal: people.reduce((n, p) => n + p.stale.count, 0) };
}

/** Section text. level "full": counts plus oldest refs per person; "short": totals and the top 3 names. "" when nothing to report. */
export function feedbackSectionText(f, level = "full") {
  if (!f || !f.people?.length) return "";
  if (level === "short") {
    const top = f.people.slice(0, 3).map((p) => `${p.name}${p.noFeedback.count + p.stale.count}`).join("、");
    return `销售反馈待补：Day1未写${f.noFeedbackTotal}条，仅未接超3天${f.staleTotal}条（${top}${f.people.length > 3 ? "等" : ""}）`;
  }
  const part = (label, x) => (x.count ? `${label}${x.count}条(最久${x.oldest.join("/")})` : "");
  const who = f.people.map((p) => `${p.name} ${[part("Day1未写", p.noFeedback), part("仅未接超3天", p.stale)].filter(Boolean).join("，")}`).join("、");
  return `销售反馈待补：${who}`;
}
