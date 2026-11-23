// S39: the order of the compact (mobile) leads list. Default "smart": never contacted first, then overdue, then newest.
import { dubaiDateKey } from "./dubai-time.mjs";

export const LEAD_SORTS = Object.freeze(["smart", "newest", "overdue", "last_contact"]);
export const DEFAULT_LEAD_SORT = "smart";
export const LEAD_SORT_STORAGE_KEY = "newme.leads.sort";

export function parseLeadSort(value) {
  return LEAD_SORTS.includes(value) ? value : DEFAULT_LEAD_SORT;
}

const open = (lead) => !lead.final_status && lead.stage !== "won" && lead.stage !== "lost";
export const neverContacted = (lead) => open(lead) && !lead.last_contact_date && (lead.stage === "new" || !lead.stage);
export const overdueFollowUp = (lead, today) => open(lead) && Boolean(lead.next_followup_date) && String(lead.next_followup_date).slice(0, 10) < today;

const time = (value) => { const t = Date.parse(value ?? ""); return Number.isFinite(t) ? t : 0; };

/**
 * @param {Array<Record<string, any>>} leads
 * @param {string} sort one of LEAD_SORTS
 * @param {Date} [now]
 * @returns {Array<Record<string, any>>} a new array
 */
export function sortLeads(leads, sort, now = new Date()) {
  const today = dubaiDateKey(now) ?? "";
  const rows = [...leads];
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));
  const newest = (a, b) => time(b.created_at) - time(a.created_at) || byId(a, b);
  switch (parseLeadSort(sort)) {
    case "newest":
      return rows.sort(newest);
    case "last_contact":
      // longest without a contact first; never contacted counts as the longest
      return rows.sort((a, b) => (a.last_contact_date ? time(a.last_contact_date) : -1) - (b.last_contact_date ? time(b.last_contact_date) : -1) || newest(a, b));
    case "overdue":
      return rows.sort((a, b) => {
        const ao = overdueFollowUp(a, today), bo = overdueFollowUp(b, today);
        if (ao !== bo) return ao ? -1 : 1;
        if (ao) return String(a.next_followup_date).localeCompare(String(b.next_followup_date)) || newest(a, b);
        return newest(a, b);
      });
    default: {
      const rank = (lead) => (neverContacted(lead) ? 0 : overdueFollowUp(lead, today) ? 1 : 2);
      return rows.sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 1) return String(a.next_followup_date).localeCompare(String(b.next_followup_date)) || newest(a, b); // most overdue first
        return newest(a, b);
      });
    }
  }
}

export const MOBILE_PAGE_SIZE = 30;
/** The first `pages` pages of the sorted list. */
export function pageOf(rows, pages, size = MOBILE_PAGE_SIZE) {
  return rows.slice(0, Math.max(1, pages) * size);
}
