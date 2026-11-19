// Ads page / ads-roi helpers (OS fix S27). Everything here stops at LEADS: spend, leads, cost per lead,
// per ISO week (Dubai Monday) and per ad. No quotation, contract or won-amount figure, no ROAS.
//
// A click-to-WhatsApp lead (ctwa_clid / ad_id set, campaign fields empty) is an ad lead exactly like a
// form lead. ad_spend has no ad_id column (a migration would be needed, see crm-v3/SPEC.md S27), so
// spend can only be matched by name; a lead's ad id is shown with the ad's name when ANY lead of the
// same ad id carries one, otherwise the id itself.
import { addDaysToDateKey, dubaiDateKey, dubaiMidnight, dubaiWeekBounds } from "./dubai-time.mjs";

export const ADS_WINDOW_DAYS = Object.freeze([7, 30, 90]);
export const ADS_DEFAULT_WINDOW_DAYS = 30;
export const ADS_MAX_WINDOW_DAYS = 400;
export const ADS_STALE_AFTER_DAYS = 3;
export const UNCATEGORIZED = "uncategorized";

const META_SOURCES = new Set(["ins", "fb", "meta", "facebook", "instagram"]);
const present = (v) => typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;
const clean = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

/** A lead that came from a Meta ad: form, click-to-WhatsApp or tracked link. */
export function isAdLead(lead) {
  if (!lead) return false;
  return (
    present(lead.ctwa_clid) || present(lead.ad_id) || present(lead.fbclid) || present(lead.meta_click_id) ||
    META_SOURCES.has(clean(lead.source).toLowerCase()) ||
    META_SOURCES.has(clean(lead.source_platform).toLowerCase()) ||
    META_SOURCES.has(clean(lead.utm_source).toLowerCase())
  );
}

/** ad id -> the most recent ad name any lead of that ad carries (read-time name lookup, nothing stored). */
export function buildAdNameMap(leads) {
  const best = new Map();
  for (const lead of leads || []) {
    const id = clean(lead?.ad_id);
    const name = clean(lead?.ad_name);
    if (!id || !name) continue;
    const at = Date.parse(lead.created_at ?? "") || 0;
    const prev = best.get(id);
    if (!prev || at >= prev.at) best.set(id, { name, at });
  }
  return new Map([...best].map(([id, v]) => [id, v.name]));
}

/** Display label of an ad: its name, with the id when both exist; the bare id when there is no name. */
export function adLabel(adId, name) {
  const id = clean(adId), n = clean(name);
  if (id && n) return `${n} (${id})`;
  return n || id || UNCATEGORIZED;
}

/**
 * Group key + label of a lead for the ads page views.
 * ad: the ad id wins (renaming or duplicating an ad no longer splits or merges rows); name only labels.
 * campaign / adset: the name, then the level's own id, then the ad id (click-to-WhatsApp leads have only that).
 */
export function attributionGroup(lead, mode, names = new Map()) {
  const adId = clean(lead.ad_id);
  const adName = clean(lead.ad_name) || names.get(adId) || "";
  switch (mode) {
    case "source":
      return { key: clean(lead.source) || clean(lead.source_platform) || "other", label: null };
    case "ad":
      if (adId) return { key: `ad:${adId}`, label: adLabel(adId, adName) };
      return adName ? { key: `name:${adName}`, label: adName } : { key: UNCATEGORIZED, label: UNCATEGORIZED };
    case "adset": {
      const name = clean(lead.adset_name), id = clean(lead.adset_id);
      if (name) return { key: name, label: name };
      if (id) return { key: `adset:${id}`, label: id };
      break;
    }
    default: {
      const name = clean(lead.campaign_name) || clean(lead.utm_campaign) || clean(lead.meta_campaign);
      const id = clean(lead.campaign_id);
      if (name) return { key: name, label: name };
      if (id) return { key: `campaign:${id}`, label: id };
    }
  }
  if (adId) return { key: `ad:${adId}`, label: adLabel(adId, adName) };
  return { key: UNCATEGORIZED, label: UNCATEGORIZED };
}

/** "YYYY-MM-DD" of the Dubai Monday of the ISO week containing the date key / instant. */
export function dubaiWeekStartKey(value) {
  const key = dubaiDateKey(value);
  if (!key) return null;
  return dubaiDateKey(dubaiWeekBounds(key).start);
}

/**
 * Inclusive Dubai-date window. `days` ends today (Dubai); an explicit since/until pair wins.
 * Returns { since, until, startInstant, endInstant } with half-open instants for created_at filters,
 * or { error } for a bad request.
 */
export function resolveAdsWindow({ days, since, until, now = new Date() } = {}) {
  const today = dubaiDateKey(now);
  const date = /^\d{4}-\d{2}-\d{2}$/;
  let s, u;
  if (since || until) {
    if (!date.test(since ?? "") || !date.test(until ?? "") || since > until) return { error: "invalid_date_range" };
    s = since; u = until;
  } else {
    const n = days === undefined || days === null || days === "" ? ADS_DEFAULT_WINDOW_DAYS : Number(days);
    if (!Number.isInteger(n) || n < 1 || n > ADS_MAX_WINDOW_DAYS) return { error: "invalid_window_days" };
    u = today; s = addDaysToDateKey(today, -(n - 1));
  }
  const span = (Date.parse(`${u}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86400000 + 1;
  if (span > ADS_MAX_WINDOW_DAYS) return { error: "date_range_too_large" };
  const [sy, sm, sd] = s.split("-").map(Number);
  const [uy, um, ud] = u.split("-").map(Number);
  return { since: s, until: u, startInstant: dubaiMidnight(sy, sm - 1, sd), endInstant: dubaiMidnight(uy, um - 1, ud + 1) };
}

/** Whole days between the newest spend date and today (Dubai); stale once older than the limit. */
export function spendFreshness(lastSpendDate, now = new Date(), limit = ADS_STALE_AFTER_DAYS) {
  if (!lastSpendDate) return { last_date: null, days_old: null, stale: true };
  const today = dubaiDateKey(now);
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(lastSpendDate).slice(0, 10)}T00:00:00Z`)) / 86400000);
  return { last_date: String(lastSpendDate).slice(0, 10), days_old: days, stale: days > limit };
}

export function costPerLead(spend, leads) {
  return typeof spend === "number" && Number.isFinite(spend) && leads > 0 ? Math.round((spend / leads) * 100) / 100 : null;
}

/** Spend and leads per Dubai ISO week. spendRows: {spend_date, amount}; leads: {created_at}. */
export function weeklyLeadCost(spendRows, leads) {
  const weeks = new Map();
  const slot = (k) => { if (!weeks.has(k)) weeks.set(k, { week_start: k, spend: null, leads: 0 }); return weeks.get(k); };
  for (const row of spendRows || []) {
    const amount = Number(row?.amount);
    const k = dubaiWeekStartKey(row?.spend_date);
    if (!k || !Number.isFinite(amount)) continue;
    const w = slot(k); w.spend = (w.spend ?? 0) + amount;
  }
  for (const lead of leads || []) {
    const k = dubaiWeekStartKey(lead?.created_at);
    if (k) slot(k).leads += 1;
  }
  return [...weeks.values()]
    .sort((a, b) => (a.week_start < b.week_start ? 1 : -1))
    .map((w) => ({
      week_start: w.week_start,
      week_end: addDaysToDateKey(w.week_start, 6),
      spend: w.spend === null ? null : Math.round(w.spend * 100) / 100,
      leads: w.leads,
      cpl: costPerLead(w.spend, w.leads),
    }));
}
