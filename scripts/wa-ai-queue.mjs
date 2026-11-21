#!/usr/bin/env node
// READ-ONLY export for the scheduled AI summary routine (docs/runbooks/wa-ai-notes.md).
// Prints one JSON line per WhatsApp lead that needs a needs-summary: {lead_ref, lead_id, watermark, messages:[{dir,text,at}]}.
// Only GET requests to the database REST API; never writes. Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment
// (same variables the app uses; never printed). Messages hold customer text only; no phone numbers are exported.
import { fileURLToPath } from "node:url";
import { AI_NOTE_SOURCE, QUEUE_LOOKBACK_DAYS, QUEUE_MESSAGE_LIMIT, QUEUE_MIN_INBOUND, selectQueue } from "../src/lib/wa-ai-notes.mjs";

const CHUNK = 40;
const MAX_LEADS = 500;

export async function collectQueue({ url, key, fetchImpl = fetch, now = Date.now() }) {
  const get = async (pathAndQuery) => {
    const res = await fetchImpl(`${url}/rest/v1/${pathAndQuery}`, { method: "GET", headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!res.ok) { await res.body?.cancel?.(); throw new Error(`query_failed_${res.status}`); }
    return res.json();
  };
  const since = new Date(now - QUEUE_LOOKBACK_DAYS * 86_400_000).toISOString();
  const leads = await get(`leads?select=id,created_at,archived&archived=eq.false&created_at=gte.${encodeURIComponent(since)}&source_channel=in.(whatsapp_ctwa,whatsapp_direct)&order=created_at.desc&limit=${MAX_LEADS}`);
  const ids = leads.map((l) => l.id);
  const conversations = []; const events = []; const notes = {};
  for (let i = 0; i < ids.length; i += CHUNK) {
    const list = ids.slice(i, i + CHUNK).join(",");
    conversations.push(...await get(`whatsapp_conversations?select=id,lead_id,last_inbound_at,last_outbound_at&inbound_count=gte.${QUEUE_MIN_INBOUND}&lead_id=in.(${list})`));
    const acts = await get(`activities?select=lead_id,metadata&lead_id=in.(${list})&metadata-%3E%3Esource=eq.${AI_NOTE_SOURCE}&limit=1000`);
    for (const a of acts) { const w = a.metadata?.watermark; if (w && (!notes[a.lead_id] || w > notes[a.lead_id])) notes[a.lead_id] = w; }
  }
  for (const c of conversations) {
    events.push(...(await get(`whatsapp_message_events?select=conversation_id,direction,body,occurred_at&conversation_id=eq.${c.id}&body=not.is.null&order=occurred_at.desc&limit=${QUEUE_MESSAGE_LIMIT}`)));
  }
  return selectQueue({ leads, conversations, events, notes, now });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("wa-ai-queue: database configuration unavailable"); process.exit(64); }
  try { for (const row of await collectQueue({ url, key })) process.stdout.write(`${JSON.stringify(row)}\n`); }
  catch (err) { console.error(`wa-ai-queue: ${err instanceof Error ? err.message : "failed"}`); process.exit(1); }
}
