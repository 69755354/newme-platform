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
    // A null/blank amount is unknown, not zero: Number(null) is 0, so test before converting.
    const raw = row?.amount;
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) continue;
    const amount = Number(raw);
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

const round2 = (n) => Math.round(n * 100) / 100;

/** Name key used to join ad_spend (which has no ad_id column) to leads. */
export function adNameKey(name) {
  const n = clean(name);
  if (!n) return "";
  return n.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
}

/**
 * Per-ad leads and spend.
 * Leads are counted per ad_id (the name only labels), so two ad ids sharing a name stay two rows and a renamed
 * ad stays one. A lead with no ad_id is counted under its name. ad_spend has no ad_id, so spend is joined by
 * name: a spend name that exactly one ad id has ever carried is attributed to that ad; one carried by several
 * ad ids is ambiguous and is NOT guessed. It is reported on its own row (spend_ambiguous) and the ads that
 * could own it show unknown spend and no cost per lead.
 * spendRows: {ad_name, amount}; leads: {ad_id, ad_name, created_at}.
 */
export function buildAdBreakdown(spendRows, leads, names = buildAdNameMap(leads)) {
  const rows = new Map(); // key -> { label, ad_id, leads, spend, ambiguous }
  const idNames = new Map(); // ad_id -> Set of name keys any of its leads carried (+ latest known name)
  const nameOwners = new Map(); // name key -> Set of ad_ids that carry it
  const slot = (key, init) => { if (!rows.has(key)) rows.set(key, { leads: 0, spend: null, ambiguous: false, ...init }); return rows.get(key); };
  const addName = (id, name) => {
    const k = adNameKey(name);
    if (!k) return;
    if (!idNames.has(id)) idNames.set(id, new Set());
    idNames.get(id).add(k);
    if (!nameOwners.has(k)) nameOwners.set(k, new Set());
    nameOwners.get(k).add(id);
  };

  for (const lead of leads || []) {
    const id = clean(lead?.ad_id);
    const own = clean(lead?.ad_name);
    if (id) {
      addName(id, own);
      slot(`id:${id}`, { label: null, ad_id: id }).leads += 1;
    } else if (own) {
      slot(`name:${adNameKey(own)}`, { label: own, ad_id: null }).leads += 1;
    }
  }
  for (const [id] of idNames) addName(id, names.get(id));
  for (const r of rows.values()) if (r.ad_id) r.label = adLabel(r.ad_id, names.get(r.ad_id));

  const addSpend = (r, amount) => { r.spend = (r.spend ?? 0) + amount; };
  for (const row of spendRows || []) {
    const spendName = clean(row?.ad_name);
    const k = adNameKey(spendName);
    if (!k) continue;
    const raw = row?.amount;
    const known = !(raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) && Number.isFinite(Number(raw));
    const amount = known ? Number(raw) : null;
    const owners = [...(nameOwners.get(k) || [])];
    if (owners.length === 1) {
      const r = rows.get(`id:${owners[0]}`);
      if (amount !== null) addSpend(r, amount);
    } else if (owners.length > 1) {
      const r = slot(`ambiguous:${k}`, { label: spendName, ad_id: null, ambiguous: true });
      if (amount !== null) addSpend(r, amount);
      for (const id of owners) rows.get(`id:${id}`).tainted = true;
    } else {
      const r = slot(`name:${k}`, { label: spendName, ad_id: null });
      if (amount !== null) addSpend(r, amount);
    }
  }

  return [...rows.values()]
    .map((r) => {
      const unknown = r.tainted === true || r.ambiguous;
      const spend = r.tainted ? null : r.spend;
      return {
        ad: r.label,
        ad_id: r.ad_id,
        spend: spend === null ? null : round2(spend),
        leads: r.leads,
        cpl: unknown ? null : costPerLead(spend ?? undefined, r.leads),
        spend_ambiguous: unknown,
      };
    })
    .sort((a, b) => (b.spend ?? -Infinity) - (a.spend ?? -Infinity) || b.leads - a.leads);
}
