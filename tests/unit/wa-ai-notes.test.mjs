// WhatsApp AI needs summary: queue selection with fixtures, item validation, token/disabled/limits, and "never touches the lead".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_ITEMS_PER_CALL, latestAiNote, noteContent, resolveAiNotesConfig, selectQueue, tokenMatches, validateItem } from "../../src/lib/wa-ai-notes.mjs";
import { collectQueue } from "../../scripts/wa-ai-queue.mjs";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const min = (m) => new Date(NOW - m * 60_000).toISOString();
const day = (d) => new Date(NOW - d * 86_400_000).toISOString();
const L1 = "11111111-1111-4111-8111-111111111111";
const ev = (conv, direction, body, at) => ({ conversation_id: conv, direction, body, occurred_at: at });
const base = () => ({
  leads: [{ id: L1, created_at: day(2), archived: false }],
  conversations: [{ id: "c1", lead_id: L1 }],
  events: [ev("c1", "inbound", "Hi villa renovation", min(90)), ev("c1", "outbound", "Hello!", min(80)), ev("c1", "inbound", "budget 300k, JVC", min(70))],
});
const sel = (o = {}) => selectQueue({ ...base(), now: NOW, ...o });

test("queue: lead with 2 inbound texts, quiet 30+ min is listed with lead_ref and messages", () => {
  const [row] = sel();
  assert.equal(row.lead_id, L1); assert.match(row.lead_ref, /^NM-111111111111$/);
  assert.deepEqual(row.messages.map((m) => m.dir), ["in", "out", "in"]);
  assert.deepEqual(Object.keys(row.messages[0]).sort(), ["at", "dir", "text"]);
  assert.equal(row.watermark, min(70));
});
test("queue: one inbound only, or still chatting (< 30 min), is skipped", () => {
  assert.equal(sel({ events: base().events.slice(0, 2) }).length, 0);
  assert.equal(sel({ events: [...base().events, ev("c1", "inbound", "ok?", min(10))] }).length, 0);
  assert.equal(sel({ events: [...base().events, ev("c1", "outbound", "sure", min(29))] }).length, 0);
  assert.equal(sel({ events: [...base().events, ev("c1", "outbound", "sure", min(31))] }).length, 1);
});
test("queue: media without text does not count as an inbound message", () => {
  const events = [ev("c1", "inbound", "Hi", min(90)), ev("c1", "inbound", null, min(80)), ev("c1", "inbound", "  ", min(70))];
  assert.equal(sel({ events }).length, 0);
});
test("queue: older than 14 days or archived leads are skipped", () => {
  assert.equal(sel({ leads: [{ id: L1, created_at: day(15), archived: false }] }).length, 0);
  assert.equal(sel({ leads: [{ id: L1, created_at: day(13), archived: false }] }).length, 1);
  assert.equal(sel({ leads: [{ id: L1, created_at: day(2), archived: true }] }).length, 0);
});
test("queue: an AI note covering the newest message hides the lead; a newer message brings it back", () => {
  assert.equal(sel({ notes: { [L1]: min(70) } }).length, 0);
  assert.equal(sel({ notes: { [L1]: min(100) } }).length, 1);
});
test("queue: only the last 30 messages, text only, long text clipped", () => {
  const events = Array.from({ length: 40 }, (_, i) => ev("c1", i % 2 ? "outbound" : "inbound", `m${i} ${"x".repeat(2000)}`, min(200 - i)));
  const [row] = sel({ events });
  assert.equal(row.messages.length, 30); assert.ok(row.messages.every((m) => m.text.length <= 1000)); assert.match(row.messages[29].text, /^m39/);
});

test("export script only issues GET requests and applies the same selection", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    const u = String(url);
    const data = u.includes("/leads?") ? [{ id: L1, created_at: day(2), archived: false }]
      : u.includes("whatsapp_conversations") ? [{ id: "c1", lead_id: L1 }]
      : u.includes("activities") ? [] : base().events;
    return { ok: true, status: 200, json: async () => data };
  };
  const rows = await collectQueue({ url: "https://x.example", key: "k".repeat(30), fetchImpl, now: NOW });
  assert.equal(rows.length, 1); assert.ok(calls.length >= 4 && calls.every((c) => c.method === "GET"));
  const src = readFileSync(path.resolve(import.meta.dirname, "../../scripts/wa-ai-queue.mjs"), "utf8");
  assert.ok(!/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(src));
});

const good = { lead_id: L1, summary: "Villa, JVC, budget 300k", suggested_quality: "good", reason: "预算明确" };
test("validation: required fields, quality enum, length caps, watermark", () => {
  assert.ok(validateItem(good).item);
  assert.equal(validateItem({ ...good, summary: "x".repeat(601) }).error, "summary_too_long");
  assert.ok(validateItem({ ...good, summary: "x".repeat(600) }).item);
  assert.equal(validateItem({ ...good, suggested_quality: "excellent" }).error, "suggested_quality_invalid");
  assert.equal(validateItem({ ...good, lead_id: "nope" }).error, "lead_id_invalid");
  assert.equal(validateItem({ ...good, reason: "" }).error, "reason_required");
  assert.equal(validateItem({ ...good, watermark: "yesterday-ish" }).error, "watermark_invalid");
  assert.equal(validateItem(null).error, "item_not_object");
  assert.match(noteContent(validateItem(good).item), /^AI 摘要（自动，仅供参考）/);
});
test("token: constant-time compare, >= 32 chars on the server side, disabled by default", () => {
  const t = "a".repeat(40);
  assert.equal(tokenMatches(t, t), true); assert.equal(tokenMatches("b".repeat(40), t), false);
  assert.equal(tokenMatches("short", "short"), false); assert.equal(tokenMatches(t, undefined), false); assert.equal(tokenMatches(null, t), false);
  assert.equal(resolveAiNotesConfig({}).enabled, false); assert.equal(resolveAiNotesConfig({ AI_NOTES_ENABLED: "true" }).enabled, true);
  assert.equal(MAX_ITEMS_PER_CALL, 50);
});
test("latestAiNote picks the newest advisory note and ignores other activities", () => {
  const a = (created_at, q, extra = {}) => ({ created_at, metadata: { source: "ai_note", suggested_quality: q, summary: "s", reason: "r", ...extra } });
  assert.equal(latestAiNote([{ created_at: day(0), metadata: { source: "drive_sync" } }]), null);
  assert.equal(latestAiNote([a(day(3), "poor"), a(day(1), "good"), a(day(2), "normal")]).suggested_quality, "good");
});

const route = readFileSync(path.resolve(import.meta.dirname, "../../src/app/api/leads/ai-notes/route.ts"), "utf8");
test("route: disabled -> 503 before rate limit, rate limit before token, token before body", () => {
  assert.ok(route.indexOf("enabled") < route.indexOf("consumeRateLimit(") && route.indexOf("consumeRateLimit(") < route.indexOf("tokenMatches(") && route.indexOf("tokenMatches(") < route.indexOf("request.json()"));
  assert.match(route, /Disabled/); assert.match(route, /503/); assert.match(route, /401/); assert.match(route, /429/); assert.match(route, /MAX_ITEMS_PER_CALL/); assert.match(route, /413/);
  assert.match(route, /process\.env\.AI_NOTES_TOKEN/);
});
test("route never writes the leads table and never touches quality/stage/owner/Meta", () => {
  assert.ok(!/from\("leads"\)\s*\.\s*(update|insert|upsert|delete)/.test(route));
  assert.deepEqual([...route.matchAll(/\.from\("([a-z_]+)"\)\s*\.insert/g)].map((m) => m[1]), ["activities"]);
  assert.ok(!/\.(update|upsert|delete)\(/.test(route));
  assert.ok(!/quality:|stage:|owner|assigned|\bmeta\b|meta_|capi|enqueue/i.test(route.replace(/suggested_quality/g, "").replace(/whatsapp_(conversations|message_events)/g, "").replace(/\/\/.*$/gm, "")));
  assert.match(route, /ai_generated: true/);
});
test("proxy lets the exact path through to the handler token check", () => {
  const proxy = readFileSync(path.resolve(import.meta.dirname, "../../src/proxy.ts"), "utf8");
  assert.match(proxy, /"\/api\/leads\/ai-notes",/);
});
