// Meta ID registry: one row per Meta identifier on a lead (form leads carry a leadgen id, click-to-WhatsApp
// leads carry a ctwa_clid), with the ad it came from and the state of the feedback sent back to Meta.
// Pure functions so the route, node:test and any operator script agree. No personal data is ever read:
// no name, phone or email, and the public reference is a short form of the lead id.
import { createHash, timingSafeEqual } from "node:crypto";
import { csvCell } from "./whatsapp-ad-export.mjs";

export const META_IDS_ROLES = Object.freeze(["admin", "boss", "operator"]);
export const META_IDS_MIN_TOKEN_LENGTH = 32;
export const META_IDS_HEADER = Object.freeze([
  "lead_ref", "source", "meta_id_type", "meta_id", "campaign_id", "campaign_name", "adset_id", "ad_id", "ad_name",
  "created_at", "stage", "final_status", "archived", "feedback_events", "last_feedback_at",
]);
const EVENT_ORDER = ["LeadSubmitted", "QualifiedLead", "Purchase"];
const STATUS_LABEL = Object.freeze({ delivered: "sent", pending: "queued", sending: "queued", failed: "failed", review_required: "manual" });

export function canExportMetaIds(role) {
  return typeof role === "string" && META_IDS_ROLES.includes(role);
}

/** Constant-time comparison. A missing or short expected token means the token method is disabled. */
export function tokenMatches(provided, expected) {
  if (typeof expected !== "string" || expected.length < META_IDS_MIN_TOKEN_LENGTH) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function extractExportToken(headers, searchParams) {
  const bearer = (headers.get("authorization") ?? "").match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
  return { query: searchParams.get("token") || null, bearer };
}

/** Stable public reference: first 12 hex characters of the lead id. */
export function leadRef(id) {
  return `NM-${String(id).replace(/-/g, "").slice(0, 12).toLowerCase()}`;
}

export function toDubaiIso(value) {
  const ms = Date.parse(value ?? "");
  if (!Number.isFinite(ms)) return "";
  return `${new Date(ms + 4 * 3_600_000).toISOString().slice(0, 19)}+04:00`;
}

function summarize(events) {
  if (!events.length) return { text: "", last: "" };
  const rank = (name) => { const i = EVENT_ORDER.indexOf(name); return i < 0 ? EVENT_ORDER.length : i; };
  const sorted = [...events].sort((a, b) => rank(a.event_name) - rank(b.event_name) || String(a.event_name).localeCompare(String(b.event_name)));
  const text = sorted.map((e) => `${e.event_name}:${STATUS_LABEL[e.status] ?? e.status}`).join(";");
  let last = 0;
  for (const e of events) last = Math.max(last, Date.parse(e.delivered_at ?? e.created_at ?? "") || 0);
  return { text, last: last ? toDubaiIso(new Date(last).toISOString()) : "" };
}

function groupByLead(events) {
  const map = new Map();
  for (const e of events) {
    if (!map.has(e.lead_id)) map.set(e.lead_id, []);
    map.get(e.lead_id).push(e);
  }
  return map;
}

export function buildMetaIdRows(leads, formEvents, whatsappEvents) {
  const form = groupByLead(formEvents);
  const wa = groupByLead(whatsappEvents);
  const rows = [];
  const base = (lead, source, type, id, events) => {
    const f = summarize(events);
    return {
      lead_ref: leadRef(lead.id), source, meta_id_type: type, meta_id: id,
      campaign_id: lead.campaign_id ?? "", campaign_name: lead.campaign_name ?? "", adset_id: lead.adset_id ?? "",
      ad_id: lead.ad_id ?? "", ad_name: lead.ad_name ?? "", created_at: toDubaiIso(lead.created_at),
      stage: lead.stage ?? "", final_status: lead.final_status ?? "", archived: lead.archived ? "true" : "false",
      feedback_events: f.text, last_feedback_at: f.last,
    };
  };
  for (const lead of leads) {
    if (lead.meta_leadgen_id) rows.push(base(lead, "form", "leadgen", lead.meta_leadgen_id, form.get(lead.id) ?? []));
    if (lead.ctwa_clid) rows.push(base(lead, "whatsapp", "ctwa_clid", lead.ctwa_clid, wa.get(lead.id) ?? []));
  }
  return rows;
}

export function buildMetaIdsCsv(rows) {
  const lines = [META_IDS_HEADER.join(",")];
  for (const row of rows) lines.push(META_IDS_HEADER.map((k) => csvCell(row[k])).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
