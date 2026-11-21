// AI needs summary for WhatsApp leads (switched off by default).
// A scheduled Claude session reads scripts/wa-ai-queue.mjs, writes a short summary and POSTs it to /api/leads/ai-notes.
// The note is advisory: it lives only in `activities` (metadata.source = "ai_note"). It never touches leads.quality, stage,
// owner, or anything sent to Meta. Pure helpers here so the route, the export script and the lead page share one definition.
import { createHash, timingSafeEqual } from "node:crypto";

export const AI_NOTE_SOURCE = "ai_note";
export const AI_NOTE_LABEL = "AI 摘要（自动，仅供参考）";
export const MIN_TOKEN_LENGTH = 32;
export const MAX_ITEMS_PER_CALL = 50;
export const MAX_SUMMARY_CHARS = 600;
export const MAX_REASON_CHARS = 200;
export const QUALITIES = ["good", "normal", "poor"];
export const QUALITY_LABEL_ZH = { good: "好", normal: "一般", poor: "差" };
export const QUEUE_MIN_INBOUND = 2;
export const QUEUE_QUIET_MINUTES = 30;
export const QUEUE_LOOKBACK_DAYS = 14;
export const QUEUE_MESSAGE_LIMIT = 30;
export const QUEUE_TEXT_LIMIT = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAG = (v) => String(v ?? "").toLowerCase() === "true";

export function resolveAiNotesConfig(env = process.env) {
  return { enabled: FLAG(env.AI_NOTES_ENABLED) };
}

export function bearerToken(headers) {
  return (headers.get("authorization") ?? "").match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
}

/** Constant-time compare; an unset or short (< 32 chars) server token never matches. */
export function tokenMatches(provided, expected) {
  if (typeof expected !== "string" || expected.length < MIN_TOKEN_LENGTH) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(expected).digest());
}

const clean = (v, max) => String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max);

/** Returns { error } or { item } with trimmed fields. */
export function validateItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "item_not_object" };
  if (typeof raw.lead_id !== "string" || !UUID.test(raw.lead_id)) return { error: "lead_id_invalid" };
  if (typeof raw.summary !== "string" || !raw.summary.trim()) return { error: "summary_required" };
  if (raw.summary.length > MAX_SUMMARY_CHARS) return { error: "summary_too_long" };
  if (!QUALITIES.includes(raw.suggested_quality)) return { error: "suggested_quality_invalid" };
  if (typeof raw.reason !== "string" || !raw.reason.trim()) return { error: "reason_required" };
  if (raw.reason.length > MAX_REASON_CHARS) return { error: "reason_too_long" };
  let watermark = null;
  if (raw.watermark !== undefined && raw.watermark !== null) {
    if (typeof raw.watermark !== "string" || !Number.isFinite(Date.parse(raw.watermark))) return { error: "watermark_invalid" };
    watermark = new Date(raw.watermark).toISOString();
  }
  return { item: { lead_id: raw.lead_id.toLowerCase(), summary: clean(raw.summary, MAX_SUMMARY_CHARS), suggested_quality: raw.suggested_quality, reason: clean(raw.reason, MAX_REASON_CHARS), watermark } };
}

export const noteImportKey = (leadId, watermark) => `ai-note/${leadId}/${watermark}`;

export function noteContent(item) {
  return `${AI_NOTE_LABEL}\n${item.summary}\n建议线索质量：${QUALITY_LABEL_ZH[item.suggested_quality]}（${item.suggested_quality}）— ${item.reason}`;
}

/** Latest AI note among activity rows (any order), or null. Used by the lead page card. */
export function latestAiNote(activities) {
  let best = null;
  for (const a of Array.isArray(activities) ? activities : []) {
    const m = a?.metadata;
    if (!m || m.source !== AI_NOTE_SOURCE || !QUALITIES.includes(m.suggested_quality)) continue;
    if (!best || Date.parse(a.created_at) > Date.parse(best.created_at)) best = a;
  }
  return best && { summary: String(best.metadata.summary ?? ""), suggested_quality: best.metadata.suggested_quality, reason: String(best.metadata.reason ?? ""), created_at: best.created_at, watermark: best.metadata.watermark ?? null };
}

export const leadRef = (id) => `NM-${String(id).replace(/-/g, "").slice(0, 12).toLowerCase()}`;

/**
 * Pure queue selection.
 * leads: [{id, created_at, archived}], conversations: [{id, lead_id, last_inbound_at, last_outbound_at}],
 * events: [{conversation_id, direction, body, occurred_at}], notes: {lead_id: watermark ISO of newest AI note}.
 * A lead is queued when its conversation has >= 2 inbound text messages, has been quiet for 30 min, the lead is not older
 * than 14 days / archived, and no AI note already covers the newest message (note watermark >= newest message time).
 */
export function selectQueue({ leads, conversations, events, notes = {}, now = Date.now() }) {
  const cutoff = now - QUEUE_LOOKBACK_DAYS * 86_400_000;
  const quiet = now - QUEUE_QUIET_MINUTES * 60_000;
  const byConv = new Map();
  for (const e of events) {
    const text = typeof e.body === "string" ? e.body.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    const at = Date.parse(e.occurred_at);
    if (!Number.isFinite(at)) continue;
    if (!byConv.has(e.conversation_id)) byConv.set(e.conversation_id, []);
    byConv.get(e.conversation_id).push({ dir: e.direction === "inbound" ? "in" : "out", text: text.slice(0, QUEUE_TEXT_LIMIT), at: new Date(at).toISOString(), ms: at });
  }
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const perLead = new Map();
  for (const c of conversations) {
    const lead = leadById.get(c.lead_id);
    if (!lead || lead.archived) continue;
    const created = Date.parse(lead.created_at);
    if (!Number.isFinite(created) || created < cutoff) continue;
    const msgs = byConv.get(c.id) ?? [];
    if (!perLead.has(lead.id)) perLead.set(lead.id, []);
    perLead.get(lead.id).push(...msgs);
  }
  const out = [];
  for (const [leadId, all] of perLead) {
    all.sort((a, b) => a.ms - b.ms);
    if (all.filter((m) => m.dir === "in").length < QUEUE_MIN_INBOUND) continue;
    const newest = all[all.length - 1].ms;
    if (newest > quiet) continue;
    const watermark = new Date(newest).toISOString();
    const done = notes[leadId] ? Date.parse(notes[leadId]) : null;
    if (done != null && Number.isFinite(done) && done >= newest) continue;
    out.push({ lead_ref: leadRef(leadId), lead_id: leadId, watermark, messages: all.slice(-QUEUE_MESSAGE_LIMIT).map(({ dir, text, at }) => ({ dir, text, at })) });
  }
  return out.sort((a, b) => a.watermark.localeCompare(b.watermark));
}
