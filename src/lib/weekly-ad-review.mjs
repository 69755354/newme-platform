// Weekly ad review: last 7 Dubai days, per ad. Pure functions (no I/O) so the runner and node:test agree.
// It only READS and SUGGESTS; nothing here (or in the runner) changes a Meta campaign, ad or budget.
//
// Per ad: spend, leads, cost per lead, good-quality leads, quotes with an amount, quote value.
// Spend comes from ad_spend (written by the read-only ads sync); when that table has nothing for the window the
// report still works without spend and says so (spend_available = false).
import { addDaysToDateKey, dubaiDateKey, dubaiMidnight } from "./dubai-time.mjs";
import { adLabel, adNameKey, buildAdBreakdown, buildAdNameMap, costPerLead } from "./ads-leads.mjs";
import { qualityBucket } from "./lead-metrics.mjs";
import { csvCell } from "./whatsapp-ad-export.mjs";

export const REVIEW_DAYS = 7;
export const REVIEW_CURRENCY = "AED";
export const MESSAGE_MAX_CHARS = 380; // the WhatsApp sender keeps 400 characters
export const CSV_HEADER = Object.freeze([
  "广告", "广告编号", "广告系列", "花费(AED)", "线索数", "每条线索成本(AED)", "好线索数", "一般线索数",
  "带金额报价数", "报价总额(AED)", "花费说明",
  "每条好线索成本(AED)", "每个报价成本(AED)", "Meta报告线索", "Meta报告WhatsApp对话", "点击", "展示",
]);
export const SPEND_FILE_MAX_ROWS = 500;

const clean = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => (n === null || n === undefined ? "未知" : Math.round(n).toLocaleString("en-US"));
const cut = (text, n) => { const t = clean(text); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The 7 whole Dubai days before today: [today-7, today-1]. Instants are half-open for created_at filters. */
export function reviewWindow(now = new Date(), days = REVIEW_DAYS) {
  const today = dubaiDateKey(now);
  const since = addDaysToDateKey(today, -days);
  const until = addDaysToDateKey(today, -1);
  const [sy, sm, sd] = since.split("-").map(Number);
  const [uy, um, ud] = until.split("-").map(Number);
  return { since, until, startInstant: dubaiMidnight(sy, sm - 1, sd), endInstant: dubaiMidnight(uy, um - 1, ud + 1) };
}

/**
 * Amount a lead was quoted, same rule as latestQuotationAmount (src/lib/quote-amount.mjs) done in bulk: the newest
 * quotation that is not rejected/expired and has a positive total; else leads.quotation_value. AED only: a quote in
 * another currency is not added to AED totals.
 */
export function quoteAmounts(leads, quotations) {
  const newest = new Map();
  for (const q of quotations || []) {
    if (!q?.lead_id || q.status === "rejected" || q.status === "expired") continue;
    const prev = newest.get(q.lead_id);
    if (!prev || (Date.parse(q.created_at ?? "") || 0) >= (Date.parse(prev.created_at ?? "") || 0)) newest.set(q.lead_id, q);
  }
  const out = new Map();
  for (const lead of leads || []) {
    const q = newest.get(lead.id);
    const qValue = Number(q?.total_amount);
    if (q && Number.isFinite(qValue) && qValue > 0) {
      const cur = typeof q.currency === "string" && /^[A-Za-z]{3}$/.test(q.currency) ? q.currency.toUpperCase() : REVIEW_CURRENCY;
      if (cur === REVIEW_CURRENCY) out.set(lead.id, qValue);
      continue;
    }
    const reported = Number(lead.quotation_value);
    if (Number.isFinite(reported) && reported > 0) out.set(lead.id, reported);
  }
  return out;
}


const METRIC_FIELDS = ["impressions", "clicks", "meta_leads", "messaging_conversations"];
const textField = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : typeof v === "number" ? String(v) : null);

/**
 * Strict check of the per-ad spend file the Meta connector session hands in.
 * Returns { rows } (normalised) or { error } (a short reason, never row contents). Nothing is guessed or repaired.
 */
export function parseSpendFile(data) {
  if (!Array.isArray(data)) return { error: "spend file must be a JSON array" };
  if (data.length > SPEND_FILE_MAX_ROWS) return { error: `spend file has more than ${SPEND_FILE_MAX_ROWS} rows` };
  const rows = [];
  const seen = new Set();
  for (const [i, raw] of data.entries()) {
    const at = `row ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${at}: not an object` };
    const adId = textField(raw.ad_id);
    if (adId === null || adId === "") return { error: `${at}: ad_id missing` };
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(adId)) return { error: `${at}: ad_id has unexpected characters` };
    if (seen.has(adId)) return { error: `${at}: duplicate ad_id` };
    seen.add(adId);
    const text = {};
    for (const f of ["ad_name", "campaign_name", "adset_name"]) {
      const v = raw[f] === undefined ? "" : textField(raw[f]);
      if (v === null || typeof raw[f] === "number") return { error: `${at}: ${f} must be text` };
      if (v.length > 300) return { error: `${at}: ${f} too long` };
      text[f] = v;
    }
    if (raw.currency !== REVIEW_CURRENCY) return { error: `${at}: currency must be ${REVIEW_CURRENCY}` };
    const num = {};
    for (const f of ["spend", ...METRIC_FIELDS]) {
      const v = raw[f];
      if (v === undefined || v === null) {
        if (f === "spend") return { error: `${at}: spend missing` };
        num[f] = 0;
        continue;
      }
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { error: `${at}: ${f} must be a number >= 0` };
      num[f] = v;
    }
    rows.push({ ad_id: adId, ...text, currency: REVIEW_CURRENCY, ...num });
  }
  return { rows };
}

const leadKey = (lead) => {
  const id = clean(lead.ad_id);
  if (id) return `id:${id}`;
  const k = adNameKey(lead.ad_name);
  return k ? `name:${k}` : null;
};

/** Per-ad base rows from OS leads and Meta spend rows (spend file). Matches by ad_id first, then by ad name. */
function breakdownWithMeta(metaRows, leads, names) {
  const base = buildAdBreakdown([], leads, names).map((r) => ({
    ...r, spend: null, cpl: null, meta: { leads: 0, conversations: 0, clicks: 0, impressions: 0 }, campaign: "", hasMeta: false,
  }));
  const metaIds = new Set(metaRows.map((m) => m.ad_id));
  const byId = new Map(base.filter((r) => r.ad_id).map((r) => [r.ad_id, r]));
  const idNames = new Map();
  for (const l of leads) {
    const id = clean(l.ad_id), k = adNameKey(l.ad_name);
    if (!id || !k) continue;
    if (!idNames.has(id)) idNames.set(id, new Set());
    idNames.get(id).add(k);
  }
  const owners = new Map();
  const own = (k, row) => { if (k) { if (!owners.has(k)) owners.set(k, []); if (!owners.get(k).includes(row)) owners.get(k).push(row); } };
  for (const r of base) {
    if (r.ad_id) { for (const k of idNames.get(r.ad_id) ?? []) own(k, r); own(adNameKey(names.get(r.ad_id)), r); }
    else own(adNameKey(r.ad), r);
  }
  const extraRows = [];
  for (const m of metaRows) {
    let target = byId.get(m.ad_id);
    let ambiguous = false;
    if (!target) {
      const cands = (owners.get(adNameKey(m.ad_name)) ?? []).filter((r) => !r.ad_id || !metaIds.has(r.ad_id));
      if (cands.length === 1) target = cands[0];
      else if (cands.length > 1) ambiguous = true;
    }
    if (!target) {
      target = { ad: adLabel(m.ad_id, m.ad_name), ad_id: m.ad_id, leads: 0, spend: null, cpl: null, spend_ambiguous: ambiguous,
        meta: { leads: 0, conversations: 0, clicks: 0, impressions: 0 }, campaign: "", hasMeta: false };
      extraRows.push(target);
      if (!ambiguous) byId.set(m.ad_id, target);
    }
    target.spend = (target.spend ?? 0) + m.spend;
    target.meta.leads += m.meta_leads;
    target.meta.conversations += m.messaging_conversations;
    target.meta.clicks += m.clicks;
    target.meta.impressions += m.impressions;
    target.hasMeta = true;
    if (!target.campaign && m.campaign_name) target.campaign = m.campaign_name;
    if (target.ad_id && !clean(names.get(target.ad_id)) && m.ad_name && target.ad === target.ad_id) target.ad = adLabel(target.ad_id, m.ad_name);
  }
  return [...base, ...extraRows].map((r) => ({
    ...r,
    spend: r.spend === null ? null : round2(r.spend),
    cpl: r.spend_ambiguous ? null : costPerLead(r.spend === null ? undefined : r.spend, r.leads),
  })).sort((a, b) => (b.spend ?? -Infinity) - (a.spend ?? -Infinity) || b.leads - a.leads);
}

/** One row per ad. spendRows: {ad_name, amount}; metaRows: validated spend-file rows (used INSTEAD of spendRows); leads: ad lead rows; quotations: {lead_id,total_amount,currency,status,created_at}. */
export function buildReviewRows({ spendRows = [], metaRows = null, leads = [], quotations = [] }) {
  const names = buildAdNameMap(leads);
  const base = metaRows ? breakdownWithMeta(metaRows, leads, names) : buildAdBreakdown(spendRows, leads, names);
  const amounts = quoteAmounts(leads, quotations);
  const extra = new Map();
  for (const lead of leads) {
    const key = leadKey(lead);
    if (!key) continue;
    if (!extra.has(key)) extra.set(key, { good: 0, normal: 0, quotes: 0, value: 0, campaign: "", campaignAt: 0 });
    const e = extra.get(key);
    const bucket = qualityBucket(lead);
    if (bucket === "good") e.good += 1;
    else if (bucket === "normal") e.normal += 1;
    const amount = amounts.get(lead.id);
    if (amount) { e.quotes += 1; e.value += amount; }
    const at = Date.parse(lead.created_at ?? "") || 0;
    const campaign = clean(lead.campaign_name) || clean(lead.utm_campaign) || clean(lead.meta_campaign);
    if (campaign && at >= e.campaignAt) { e.campaign = campaign; e.campaignAt = at; }
  }
  return base.map((row) => {
    const key = row.ad_id ? `id:${row.ad_id}` : `name:${adNameKey(row.ad)}`;
    const e = row.spend_ambiguous ? null : extra.get(key);
    const good = e?.good ?? 0, quotes = e?.quotes ?? 0;
    return {
      ad: row.ad,
      ad_id: row.ad_id,
      campaign: e?.campaign || row.campaign || "",
      spend: row.spend,
      leads: row.leads,
      cpl: row.cpl,
      good_leads: good,
      normal_leads: e?.normal ?? 0,
      quotes,
      quote_value: e ? round2(e.value) : 0,
      cost_per_good: row.spend_ambiguous ? null : costPerLead(row.spend === null ? undefined : row.spend, good),
      cost_per_quote: row.spend_ambiguous ? null : costPerLead(row.spend === null ? undefined : row.spend, quotes),
      meta_leads: metaRows ? row.meta?.leads ?? 0 : null,
      meta_conversations: metaRows ? row.meta?.conversations ?? 0 : null,
      clicks: metaRows ? row.meta?.clicks ?? 0 : null,
      impressions: metaRows ? row.meta?.impressions ?? 0 : null,
      spend_note: row.spend_ambiguous ? "同名广告无法区分，花费未分摊" : row.spend === null ? "无花费数据" : "",
    };
  });
}

/** 3-5 plain-Chinese suggestions. Suggestions only: a person decides and changes the ads. */
export function buildSuggestions(rows, { spendAvailable }) {
  const out = [];
  const withLeads = rows.filter((r) => r.leads > 0);
  const totalLeads = withLeads.reduce((s, r) => s + r.leads, 0);
  const totalGood = withLeads.reduce((s, r) => s + r.good_leads, 0);
  const priced = withLeads.filter((r) => typeof r.cpl === "number");
  const avgCpl = priced.length ? priced.reduce((s, r) => s + r.cpl * r.leads, 0) / priced.reduce((s, r) => s + r.leads, 0) : null;
  const goodRate = totalLeads ? totalGood / totalLeads : 0;
  const spendKnown = withLeads.filter((r) => typeof r.spend === "number");
  const avgCostGood = spendAvailable && totalGood > 0 && spendKnown.length
    ? spendKnown.reduce((s, r) => s + r.spend, 0) / spendKnown.reduce((s, r) => s + r.good_leads, 0) || null : null;
  const label = (r) => `「${cut(r.ad, 24)}」`;

  if (!totalLeads) {
    out.push("这7天没有统计到广告线索，先确认广告是否在投放、表单和WhatsApp入口是否正常。");
    out.push("建议先保持现有投放不动，等线索恢复后再看哪条素材值得加预算。");
    out.push("可以准备一版新素材（实景案例或价格说明）做小额测试。");
    return out;
  }
  if (!spendAvailable) {
    out.push("花费数据还没接入，本周只能按线索质量排序；接入只读花费同步后才能算每条线索成本。");
  }

  // scale: best good-lead result, cheaper than average when spend is known
  const scaleCandidates = withLeads
    .filter((r) => r.leads >= 3 && r.good_leads >= 2 && r.good_leads / r.leads >= Math.max(goodRate, 0.3)
      && (avgCpl === null || r.cpl === null || r.cpl <= avgCpl)
      && (avgCostGood === null || r.cost_per_good === null || r.cost_per_good <= avgCostGood * 1.2))
    .sort((a, b) => b.quote_value - a.quote_value || b.good_leads - a.good_leads);
  if (scaleCandidates[0]) {
    const r = scaleCandidates[0];
    const detail = `好线索${r.good_leads}/${r.leads}${r.quotes ? `，已有${r.quotes}个带金额报价` : ""}${r.cpl !== null ? `，每条线索${money(r.cpl)}` : ""}${r.cost_per_good !== null ? `，每条好线索${money(r.cost_per_good)}` : ""}${r.cost_per_quote !== null ? `，每个报价${money(r.cost_per_quote)}` : ""}`;
    out.push(`可以加预算：${label(r)}，${detail}，建议小幅加（比如两成）再观察一周。`);
  }

  // No lead has a quality mark or a quote yet: "no good leads" says nothing about one ad, so judge by cost per lead only.
  const noOutcomes = totalGood === 0 && withLeads.every((r) => r.quotes === 0);
  if (noOutcomes) {
    out.push("本周所有广告线索都还没有标好坏、也没有带金额报价，先不按质量判断哪条该停；请销售把跟进结果记上，下周再比。");
    const cheapest = priced.filter((r) => r.leads >= 3).sort((a, b) => a.cpl - b.cpl)[0];
    if (cheapest) out.push(`按线索成本看，${label(cheapest)}最划算：${cheapest.leads}条线索，每条${money(cheapest.cpl)}，先保持。`);
  }

  // pause: money out, nothing good back
  const pauseCandidates = withLeads
    .filter((r) => !noOutcomes && r.leads >= 3 && r.good_leads === 0 && r.quotes === 0 && (r.cpl === null || avgCpl === null || r.cpl >= avgCpl))
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || b.leads - a.leads);
  const wasted = rows.filter((r) => r.leads === 0 && (r.spend ?? 0) > 0 && !r.spend_note.includes("无法区分")).sort((a, b) => b.spend - a.spend);
  if (pauseCandidates[0]) {
    const r = pauseCandidates[0];
    out.push(`建议暂停或减量：${label(r)}，${r.leads}条线索里没有好线索也没有报价${r.spend !== null ? `，花了${money(r.spend)}，每条好线索和每个报价的成本都算不出来` : ""}。请投放负责人确认后再调整。`);
  } else if (wasted[0]) {
    out.push(`建议暂停或减量：${label(wasted[0])}花了${money(wasted[0].spend)}但没有带来线索。请投放负责人确认后再调整。`);
  }

  // keep: the steady rest, name the one with most good leads not already named
  const named = new Set([scaleCandidates[0]?.ad, pauseCandidates[0]?.ad, wasted[0]?.ad]);
  const keepers = withLeads.filter((r) => !named.has(r.ad) && r.good_leads > 0).sort((a, b) => b.good_leads - a.good_leads);
  if (keepers[0]) out.push(`保持现状：${label(keepers[0])}，好线索${keepers[0].good_leads}条，表现稳定，先不动。`);

  // costly good leads: spend exists, good leads exist, but far above the average cost per good lead
  if (avgCostGood !== null) {
    const pricey = withLeads.filter((r) => r.good_leads > 0 && r.cost_per_good !== null && r.cost_per_good > avgCostGood * 1.5 && !named.has(r.ad))
      .sort((a, b) => b.cost_per_good - a.cost_per_good)[0];
    if (pricey) out.push(`留意成本：${label(pricey)}每条好线索${money(pricey.cost_per_good)}，比整体平均（${money(avgCostGood)}）高不少${pricey.cost_per_quote !== null ? `，每个报价${money(pricey.cost_per_quote)}` : ""}，建议先观察，由投放负责人决定是否调整。`);
  }

  // test new: concentration or thin portfolio
  const top = [...withLeads].sort((a, b) => b.leads - a.leads)[0];
  if (withLeads.length < 3 || (top && top.leads / totalLeads > 0.6)) {
    out.push("线索来源集中在少数素材，建议准备1到2版新素材（不同户型或不同卖点）做小额测试，避免一条素材失效就断线索。");
  }
  if (rows.some((r) => r.spend_note.includes("无法区分"))) {
    out.push("有同名的广告无法区分花费，建议投放负责人给不同广告起不同的名字。");
  }
  if (out.length < 3) out.push("本周数据量还小，先保持现有投放，多攒一周再做取舍。");
  if (out.length < 3) out.push("可以拿本周最好的一条素材，换个角度再做一版小额测试。");
  return out.slice(0, 5);
}

export function buildWeeklyAdReview({ window, spendRows = [], metaRows = null, leads = [], quotations = [] }) {
  const rows = buildReviewRows({ spendRows, metaRows, leads, quotations });
  const source = metaRows ? "meta_file" : "ad_spend";
  const known = metaRows
    ? metaRows.map((r) => ({ amount: r.spend }))
    : spendRows.filter((r) => r?.amount !== null && r?.amount !== undefined && Number.isFinite(Number(r.amount)));
  const spendAvailable = known.length > 0;
  const spendTotal = spendAvailable ? round2(known.reduce((s, r) => s + Number(r.amount), 0)) : null;
  const totals = {
    spend: spendTotal,
    leads: rows.reduce((s, r) => s + r.leads, 0),
    good_leads: rows.reduce((s, r) => s + r.good_leads, 0),
    quotes: rows.reduce((s, r) => s + r.quotes, 0),
    quote_value: round2(rows.reduce((s, r) => s + r.quote_value, 0)),
  };
  totals.cpl = spendAvailable && totals.leads > 0 ? round2(spendTotal / totals.leads) : null;
  totals.cost_per_good = spendAvailable ? costPerLead(spendTotal, totals.good_leads) : null;
  totals.cost_per_quote = spendAvailable ? costPerLead(spendTotal, totals.quotes) : null;
  let meta = null;
  if (metaRows) {
    const metaLeads = metaRows.reduce((s, r) => s + r.meta_leads, 0);
    const conversations = metaRows.reduce((s, r) => s + r.messaging_conversations, 0);
    meta = { leads: metaLeads, conversations, os_leads: totals.leads, gap: Math.max(0, metaLeads + conversations - totals.leads) };
  }
  const suggestions = buildSuggestions(rows, { spendAvailable });
  return { window: { since: window.since, until: window.until }, spend_source: source, spend_available: spendAvailable, totals, meta, rows, suggestions };
}

export function reviewCsv(review) {
  const lines = [CSV_HEADER.map((h) => csvCell(h)).join(",")];
  for (const r of review.rows) {
    lines.push([
      r.ad, r.ad_id ?? "", r.campaign, r.spend ?? "", r.leads, r.cpl ?? "", r.good_leads, r.normal_leads, r.quotes,
      r.quote_value, r.spend_note, r.cost_per_good ?? "", r.cost_per_quote ?? "", r.meta_leads ?? "", r.meta_conversations ?? "",
      r.clicks ?? "", r.impressions ?? "",
    ].map((v) => csvCell(v)).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** One line: what Meta says versus what reached OS. Empty without a spend file. */
export function metaGapLine(review) {
  const m = review.meta;
  if (!m) return "";
  const said = `Meta报告线索${m.leads}条、WhatsApp对话${m.conversations}条，OS记录${m.os_leads}条`;
  return m.gap > 0 ? `${said}，有${m.gap}条没进OS（例如没转成线索的WhatsApp对话）。` : `${said}，没有缺口。`;
}

const dateLabel = (key) => `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`;

/** Full text for the NAS copy. */
export function reviewText(review) {
  const t = review.totals;
  const lines = [
    `广告周报 ${dateLabel(review.window.since)}至${dateLabel(review.window.until)}（迪拜时间）`,
    review.spend_available
      ? `花费 ${money(t.spend)} 迪拉姆，线索 ${t.leads} 条，每条线索 ${t.cpl === null ? "未知" : money(t.cpl)}，好线索 ${t.good_leads} 条（每条好线索 ${t.cost_per_good === null ? "未知" : money(t.cost_per_good)}），带金额报价 ${t.quotes} 个（每个报价 ${t.cost_per_quote === null ? "未知" : money(t.cost_per_quote)}），报价总额 ${money(t.quote_value)}。`
      : `线索 ${t.leads} 条，好线索 ${t.good_leads} 条，带金额报价 ${t.quotes} 个，报价总额 ${money(t.quote_value)}。花费数据还没接入，所以没有成本。`,
    ...(review.meta ? [metaGapLine(review)] : []),
    "以下只是建议，不会自动改任何投放：",
    ...review.suggestions.map((s, i) => `${i + 1}. ${s}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** One line for the WhatsApp alert sender (it keeps 400 characters): headline plus as many suggestions as fit. */
export function reviewMessage(review, { nasNote = "详表在NAS的exports文件夹" } = {}) {
  const t = review.totals;
  const head = `广告周报${dateLabel(review.window.since)}至${dateLabel(review.window.until)}：`
    + (review.spend_available
      ? `花费${money(t.spend)}，线索${t.leads}条，每条${t.cpl === null ? "未知" : money(t.cpl)}，每条好线索${t.cost_per_good === null ? "未知" : money(t.cost_per_good)}，`
      : `线索${t.leads}条（花费数据未接入），`)
    + `好线索${t.good_leads}条，带金额报价${t.quotes}个共${money(t.quote_value)}${t.cost_per_quote === null ? "" : `（每个${money(t.cost_per_quote)}）`}。${metaGapLine(review)}建议（仅供参考，不自动改投放）：`;
  const tail = nasNote ? `${nasNote}。` : "";
  let body = "";
  review.suggestions.forEach((s, i) => {
    const piece = `${i + 1}）${s}`;
    if ((head + body + piece + tail).length <= MESSAGE_MAX_CHARS) body += piece;
  });
  if (!body && review.suggestions[0]) body = cut(`1）${review.suggestions[0]}`, MESSAGE_MAX_CHARS - head.length - tail.length);
  return `${head}${body}${tail}`;
}
