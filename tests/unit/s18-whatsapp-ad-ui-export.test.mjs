import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import { buildWhatsAppAdExportCsv, canExportWhatsAppAdLeads, csvCell } from "../../src/lib/whatsapp-ad-export.mjs";
import { isWhatsAppAdLead, isWhatsAppDirectLead, firstResponseSeconds, durationParts } from "../../src/lib/whatsapp-ad-display.mjs";

const require = createRequire(import.meta.url);

test("only admin, boss and operator may export; admin and boss are equal", () => {
  for (const r of ["admin", "boss", "operator"]) assert.equal(canExportWhatsAppAdLeads(r), true, r);
  for (const r of ["sales", "finance", "designer", "user", "", null, undefined]) assert.equal(canExportWhatsAppAdLeads(r), false, String(r));
});

test("CSV has the marketing columns, feedback state and no spreadsheet formulas", () => {
  const csv = buildWhatsAppAdExportCsv(
    [{ id: "L1", phone: "+971501234567", ctwa_clid: "-abcdefghij", ad_id: "120210000000001", created_at: "2026-11-18T08:00:00Z", stage: "new", final_status: null }],
    [{ lead_id: "L1", event_name: "QualifiedLead", status: "pending" }, { lead_id: "L1", event_name: "LeadSubmitted", status: "delivered" }]);
  const [header, row] = csv.replace("﻿", "").trim().split("\r\n");
  assert.equal(header, "lead_id,phone,ctwa_clid,ad_id,created_at,stage,final_status,meta_feedback");
  assert.equal(row, "L1,+971501234567,'-abcdefghij,120210000000001,2026-11-18T08:00:00Z,new,,LeadSubmitted:delivered; QualifiedLead:pending");
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
});

test("list filter and detail panel recognise ad leads and organic WhatsApp leads", () => {
  assert.equal(isWhatsAppAdLead({ ctwa_clid: "x" }), true);
  assert.equal(isWhatsAppAdLead({ source_channel: "whatsapp_ctwa" }), true);
  assert.equal(isWhatsAppAdLead({ source_channel: "meta_lead_form" }), false);
  assert.equal(isWhatsAppDirectLead({ source_channel: "whatsapp_direct" }), true);
  assert.equal(isWhatsAppDirectLead({ source_channel: "whatsapp_direct", ctwa_clid: "x" }), false);
  assert.equal(firstResponseSeconds("2026-11-18T08:00:00Z", "2026-11-18T08:05:00Z"), 300);
  assert.equal(firstResponseSeconds("2026-11-18T08:00:00Z", null), null);
  assert.deepEqual(durationParts(300), { unit: "minutes", n: 5 });
  assert.deepEqual(durationParts(7200), { unit: "hours", n: 2 });
});

test("export route checks the role before any service-role query and never caches", async () => {
  const src = fs.readFileSync(new URL("../../src/app/api/leads/whatsapp-ads/export/route.ts", import.meta.url), "utf8");
  assert.ok(src.indexOf("canExportWhatsAppAdLeads(context.role)") < src.indexOf("supabaseAdmin.from"));
  assert.match(src, /^\/\/ RBAC: admin, boss, operator/);
  assert.match(src, /private, no-store/);
});

test("both languages carry every key the panel and filter use", () => {
  const src = fs.readFileSync(new URL("../../src/lib/i18n/translations.ts", import.meta.url), "utf8");
  const blocks = [...src.matchAll(/whatsappAds: \{([\s\S]*?)\n    \},/g)].map((m) => [...m[1].matchAll(/^\s+(\w+):/gm)].map((k) => k[1]).sort());
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], blocks[1]);
  const panel = fs.readFileSync(new URL("../../src/app/(dashboard)/leads/[id]/LeadWhatsAppAdPanel.tsx", import.meta.url), "utf8");
  for (const [, key] of panel.matchAll(/t\("whatsappAds\.(\w+)"\)/g)) assert.ok(blocks[0].includes(key), key);
});

test("migration contract: definer entry guard, pinned search_path, service-only grants, rollback note", () => {
  const sql = fs.readFileSync(new URL("../../supabase/migrations/20261118200000_whatsapp_ctwa_leads.sql", import.meta.url), "utf8");
  assert.match(sql, /^-- NO_ROLLBACK: \S/);
  assert.match(sql, /security definer\nset search_path = pg_catalog, public, pg_temp[\s\S]*?\nbegin\n  perform public\.assert_current_session_at_entry\(\);/);
  assert.match(sql, /revoke all on function public\.record_whatsapp_ad_event\(jsonb, boolean\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.record_whatsapp_ad_event\(jsonb, boolean\) to service_role;/);
  assert.equal((sql.match(/enable row level security/g) ?? []).length, 1); // inside the loop over the three tables
  assert.match(sql, /'whatsapp_conversations', 'whatsapp_message_events', 'whatsapp_capi_events'/);
  assert.match(sql, /unique \(waba_id, customer_key\)/);
  assert.match(sql, /unique \(lead_id, event_name\)/);
});
