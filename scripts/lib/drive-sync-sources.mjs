// Drive sheets -> OS sync (S29): which tabs are read and how a sheet row becomes a normalized change.
// READ ONLY. The sheet 'Lead Quality Feedback' of the market file is a script-generated report: it is never read (FORBIDDEN_TABS).
import { CHANNEL_SOURCE, OS_SOURCES, QUALITY_MAP, fingerprintOf, maskId, norm, normalizePhone, parseSheetTime, phoneDigits, emailKey, sha } from "../../src/lib/drive-sync.mjs";

export const FORBIDDEN_TABS = [/lead quality feedback/i];
const SALES_ID = { faizan: "1GUP1mpCAm74XHi4m6WEJdQxKQZ--3OSoVIbmunJG4_w", allocation: "1t8ZbfF8hmv51KcNfWuwLPPII1IGMc6AWJgfxlCAew7w", assem: "1LTcddlbx_63rQ1zPVLsfdRqxhDPlmwpXvNCrJsNILyc", mohammed: "15b7Og5w6I55lZfOdFISC7pb12zPibfiLNVo1_B5D9ss", market: "118T8lf6RUemAz9YQezJ-sez4DaOtv1P6sxInpucDH8g" };
export const SOURCES = [
  { key: "lead_register", kind: "register", spreadsheet_id: SALES_ID.allocation, tab: "Lead Register", header_row: 5, range: "A5:AS2000", required: ["Master Lead ID", "Dispatch status", "Lead quality", "Next action"] },
  { key: "sales_faizan_leads", kind: "sales", owner: "Faizan", spreadsheet_id: SALES_ID.faizan, tab: "Leads", header_row: 7, range: "A7:AD2000", required: ["Lead key", "Lead quality", "Next action", "Day 1 feedback"] },
  { key: "sales_assem_b2c", kind: "sales", owner: "Assem", spreadsheet_id: SALES_ID.assem, tab: "B2C Leads", header_row: 7, range: "A7:AD2000", required: ["Lead key", "Lead quality", "Next action", "Day 1 feedback"] },
  { key: "sales_assem_b2b", kind: "sales", owner: "Assem", spreadsheet_id: SALES_ID.assem, tab: "B2B Leads", header_row: 7, range: "A7:V2000", required: ["Lead key", "Lead quality", "Next action", "Follow-up notes"] },
  { key: "sales_mohammed_daily", kind: "sales", owner: "Mohammed", spreadsheet_id: SALES_ID.mohammed, tab: "Leads - Daily", header_row: 7, range: "A7:AD2000", required: ["Lead key", "Lead quality", "Next action", "Day 1 feedback"] },
  { key: "marketing_home_owners", kind: "marketing", spreadsheet_id: SALES_ID.market, tab: "Home-owners", header_row: 1, range: "A1:W3000", required: ["id", "phone"] },
  { key: "marketing_new_form_leads", kind: "marketing", spreadsheet_id: SALES_ID.market, tab: "new form leads", header_row: 1, range: "A1:Q3000", required: ["id", "phone_number"] },
];

export function assertAllowedTab(tab) {
  if (FORBIDDEN_TABS.some((re) => re.test(tab))) throw new Error("refusing to read a forbidden tab");
}
export function rangeOf(src) {
  assertAllowedTab(src.tab);
  return `'${src.tab}'!${src.range}`;
}

/** values (header row first) -> { headers, rows:[{__row, ...cols}], missing } */
export function toTab(src, values) {
  const [headerRow = [], ...body] = values;
  const headers = headerRow.map(norm);
  const missing = src.required.filter((h) => !headers.includes(h));
  const rows = [];
  body.forEach((cells, i) => {
    const o = { __row: src.header_row + 1 + i };
    headers.forEach((h, j) => { if (h) o[h] = cells?.[j] ?? ""; });
    if (Object.entries(o).some(([k, v]) => !k.startsWith("__") && norm(v))) rows.push(o);
  });
  return { key: src.key, headers, rows, missing };
}

const MASTER = /^(META|WA|LEGACY|ASSEM-XLS)-(.+)$/;
const LEADGEN = /^[1-9]\d{7,31}$/;
const PREFIX_CHANNEL = { META: "meta_lead_form", WA: "whatsapp", LEGACY: "legacy_sheet", "ASSEM-XLS": "legacy_sheet" };
const strip = (raw, pfx) => { const s = norm(raw); return s.startsWith(pfx) ? s.slice(pfx.length) : (s || null); };
const lc = (v) => norm(v).toLowerCase();
const dubaiDate = (iso) => (iso ? new Date(Date.parse(iso) + 4 * 3_600_000).toISOString().slice(0, 10) : null);
const DAYS = ["Day 1 feedback", "Day 2 feedback", "Day 3 feedback", "Day 4 feedback", "Day 5 feedback"];
const FEEDBACK_EXTRA = ["Later follow-ups / previous records", "Later follow-ups / B2B notes", "Follow-up notes", "Previous records", "Sales feedback"];
const DISPATCH = { delivered: "import", unassigned: "import", "review phone": "import", "missing intake data": "import", "": "import", "duplicate review": "hold", "duplicate - not dispatched": "skip_duplicate", "excluded - test": "skip_test" };

function feedbackOf(...rows) {
  const parts = [];
  for (const h of [...DAYS, ...FEEDBACK_EXTRA]) {
    const v = rows.map((r) => norm(r?.[h])).find(Boolean);
    if (v) parts.push(`${h}: ${v}`);
  }
  return { text: parts.join(" | "), days: DAYS.filter((h) => rows.some((r) => norm(r?.[h]))).length };
}

/** Rows of the register and the four sales tabs -> one change per Master Lead ID / Lead key. */
export function buildLeadChanges(tabs, modified) {
  const changes = new Map();
  const bump = (c) => { const prev = changes.get(c.key); if (!prev) changes.set(c.key, c); else { prev.refs.push(...c.refs); } };
  const register = tabs.lead_register?.rows ?? [];
  const salesByKey = new Map(); const salesNoKey = [];
  for (const [k, tab] of Object.entries(tabs)) {
    if (!k.startsWith("sales_")) continue;
    for (const r of tab.rows) { const lk = norm(r["Lead key"]); if (lk) salesByKey.set(lk, { ...r, __tab: k }); else if (norm(r["Phone / WhatsApp"])) salesNoKey.push({ ...r, __tab: k }); }
  }
  const used = new Set();
  const make = (key, r, s, srcRefs, insertable) => {
    const pick = (a, b = a) => norm(s?.[a]) || norm(r?.[b]);
    const master = MASTER.exec(key);
    const phoneRaw = norm(r?.["Primary phone"]) || norm(s?.["Phone / WhatsApp"]);
    const phoneN = normalizePhone(phoneRaw);
    const email = emailKey(r?.Email) || emailKey(s?.Email);
    const leadgenCand = master?.[1] === "META" && LEADGEN.test(master[2]) ? master[2] : (norm(r?.["Source lead ID"]).match(/l:(\d{8,32})/) || [])[1] || null;
    const q = QUALITY_MAP[lc(pick("Lead quality"))] ?? null;
    const fb = feedbackOf(s, r);
    const nextDate = parseSheetTime(norm(s?.["Next follow-up date"]) || norm(r?.["Next action date"]));
    const first = parseSheetTime(pick("First contact at"));
    const channel = CHANNEL_SOURCE[lc(r?.["Intake channel"])] || CHANNEL_SOURCE[lc(s?.["Intake channel"])] || (master?.[1] === "META" ? "fb" : master?.[1] === "WA" ? "whatsapp" : "unknown_import");
    const received = parseSheetTime(r?.["Received at"]);
    const owned = { quality: q && q !== "pending" ? q : undefined, quality_reason: pick("Quality reason") || undefined, next_action: (norm(s?.["Next action"]) || norm(r?.["Next action"])) || undefined, next_followup_date: dubaiDate(nextDate.iso) || undefined };
    const c = {
      key, sheet: srcRefs[0].sheet, row: srcRefs[0].row, refs: srcRefs,
      source_modified_at: [...new Set(srcRefs.map((x) => modified[x.sheet]).filter(Boolean))].sort().at(-1) ?? null,
      identity: { fingerprint: fingerprintOf(key), leadgen: leadgenCand, phone_digits: phoneN?.digits ?? phoneDigits(phoneRaw), email },
      owned, followup_text: fb.text || undefined, contact_days_filled: fb.days, first_contact_at: first.iso ?? undefined,
      contact_rule: norm(s?.["Contact rule"]) || undefined,
      insertable,
      insert_fields: { customer_name: norm(r?.Client) || norm(s?.Client) || undefined, phone: phoneN?.e164 || phoneRaw || undefined, email: email || undefined, source: OS_SOURCES.has(channel) ? channel : "unknown", source_channel: master ? PREFIX_CHANNEL[master[1]] : "legacy_sheet", meta_leadgen_id: leadgenCand || undefined, campaign_id: strip(r?.["Campaign ID"], "c:") || undefined, adset_id: strip(r?.["Adset ID"], "as:") || undefined, ad_id: strip(r?.["Ad ID"], "ag:") || undefined, campaign_name: norm(r?.Campaign) || undefined, ad_name: norm(r?.Ad) || undefined, location: norm(r?.Location) || norm(s?.Area) || undefined, notes: pick("Requirement / Context") || undefined, created_at: received.iso || undefined },
      owner_alias: lc(r?.["Assigned to"]) || undefined,
    };
    if (!master) { c.hold_reason = "no_master_lead_id"; }
    return c;
  };
  for (const r of register) {
    const key = norm(r["Master Lead ID"]);
    const ref = [{ sheet: "lead_register", row: r.__row }];
    if (!key) { bump({ key: `lead_register#${r.__row}`, sheet: "lead_register", row: r.__row, refs: ref, hold_reason: "no_master_lead_id", identity: {}, owned: {} }); continue; }
    const s = salesByKey.get(key) ?? null;
    if (s) { used.add(key); ref.push({ sheet: s.__tab, row: s.__row }); }
    const c = make(key, r, s, ref, true);
    const disp = DISPATCH[lc(r["Dispatch status"])] ?? "import";
    if (lc(r["Test record"]) === "yes" || disp === "skip_test") c.skip_reason = "test_record";
    else if (disp === "skip_duplicate") c.skip_reason = "duplicate_not_dispatched";
    else if (disp === "hold") c.hold_reason = "duplicate_review";
    bump(c);
  }
  for (const [lk, s] of salesByKey) {
    if (used.has(lk)) continue;
    bump(make(lk, null, s, [{ sheet: s.__tab, row: s.__row }], true)); // sales-only row (legacy book): same as the backfill
  }
  for (const s of salesNoKey) {
    const c = make(`${s.__tab}#${s.__row}`, null, s, [{ sheet: s.__tab, row: s.__row }], false);
    c.hold_reason = "no_lead_key"; c.identity.fingerprint = undefined; bump(c);
  }
  return [...changes.values()];
}

/** Market sheet rows. Form leads (with Meta id) only add Drive-owned notes to leads OS already has; rows typed by hand (no id) can become leads. */
export function buildMarketingChanges(tabs, modified) {
  const out = [];
  for (const k of ["marketing_home_owners", "marketing_new_form_leads"]) {
    for (const r of tabs[k]?.rows ?? []) {
      const id = norm(r.id).replace(/^l:/i, "");
      const phoneRaw = norm(r.phone) || norm(r.phone_number);
      const phoneN = normalizePhone(phoneRaw);
      const pDigits = phoneN?.digits ?? phoneDigits(phoneRaw); // foreign numbers without "+" still identify the person (same fallback as the backfill)
      const actions = [r[" ACTION 1 "], r["ACTION 2"], r["ACTION 1"]].map(norm).filter(Boolean);
      const text = actions.length ? `Marketing actions: ${actions.join(" | ")}` : undefined;
      const hasId = LEADGEN.test(id);
      const key = hasId ? `META-${id}` : pDigits ? `MKT-${sha(pDigits).slice(0, 12)}` : null;
      const base = { sheet: k, row: r.__row, refs: [{ sheet: k, row: r.__row }], source_modified_at: modified[k] ?? null };
      if (!key) { out.push({ ...base, key: `${k}#${r.__row}`, skip_reason: "marketing_row_without_id_or_phone", identity: {}, owned: {} }); continue; }
      const c = { ...base, key, identity: { fingerprint: hasId ? fingerprintOf(key) : undefined, leadgen: hasId ? id : null, phone_digits: pDigits ?? null, email: emailKey(r.email) }, owned: {}, followup_text: text, insertable: !hasId };
      if (!text) c.skip_reason = "marketing_no_drive_owned_content";
      else if (!hasId) c.insert_fields = { customer_name: norm(r.full_name) || undefined, phone: phoneN?.e164 || phoneRaw || undefined, email: emailKey(r.email) || undefined, source: "whatsapp", source_channel: "marketing_sheet" };
      out.push(c);
    }
  }
  return out;
}

export function buildChanges(tabs, modified = {}) {
  const lead = buildLeadChanges(tabs, modified);
  const known = new Set(lead.map((c) => c.key));
  const market = buildMarketingChanges(tabs, modified).filter((c) => !known.has(c.key) || c.skip_reason);
  // A market row for a lead the register already carries only contributes when the register has no row for it (OS ids are the register's).
  return [...lead, ...market];
}
export { maskId };
