#!/usr/bin/env node
// STAGING ONLY. Seeds (or removes) the one lead + one contract that the post-deploy
// browser acceptance runner looks for, in the STAGING Supabase project.
//
// Run as root:
//   node --env-file=/etc/newme-staging/staging.env scripts/rehearse-postdeploy-browser-uat-fixture.mjs seed <sales-user-id>
//   node --env-file=/etc/newme-staging/staging.env scripts/rehearse-postdeploy-browser-uat-fixture.mjs cleanup <lead-id> <contract-id>
//
// The rows mirror what scripts/run-postdeploy-acceptance.mjs seeds in production for
// the browser step (browserLead / browserContract). Output is one JSON line with ids
// only; no credentials are ever printed. Refuses to run against anything but staging.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const STAGING_REF = "bfsiibofuzoglziltgyd";
const PRODUCTION_REF = "vfopmpxlhwzpxqegayew";
const MODULE_ROOT = process.env.S0_MODULE_ROOT || "/opt/newme-staging/current";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function stagingFixtureRows(salesId, ids = { lead: randomUUID(), contract: randomUUID() }) {
  const marker = `postdeploy-uat-${randomUUID()}`;
  const contractNo = `UAT-C-${ids.contract.slice(0, 8)}`;
  const day30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  return {
    marker,
    contractNo,
    lead: {
      id: ids.lead,
      source: "other",
      customer_name: marker,
      assigned_to: salesId,
      stage: "pending_decision",
      quotation_value: 1000,
      next_followup_date: day30,
      next_action: "call",
      notes: marker,
      created_by: salesId,
    },
    contract: {
      id: ids.contract,
      lead_id: ids.lead,
      sales_id: salesId,
      created_by: salesId,
      contract_no: contractNo,
      contract_amount: 1000,
      party_a_name: marker,
      status: "active",
      notes: marker,
    },
  };
}

function refuse(message) {
  console.error(`refusing: ${message}`);
  process.exit(2);
}

async function main(argv) {
  const [mode, ...rest] = argv;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url.includes(`${STAGING_REF}.supabase.co`) || url.includes(PRODUCTION_REF)) refuse("NEXT_PUBLIC_SUPABASE_URL is not the staging project");
  if (!key) refuse("service role key missing");
  const require = createRequire(path.join(MODULE_ROOT, "package.json"));
  const { createClient } = require("@supabase/supabase-js");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  if (mode === "seed") {
    const [salesId] = rest;
    if (!UUID.test(salesId ?? "")) refuse("seed needs the sales user id");
    const rows = stagingFixtureRows(salesId);
    const leadResult = await db.from("leads").insert(rows.lead);
    if (leadResult.error) { console.error(`seed lead failed: ${leadResult.error.message}`); process.exit(1); }
    const contractResult = await db.from("contracts").insert(rows.contract);
    if (contractResult.error) {
      await db.from("leads").delete().eq("id", rows.lead.id);
      console.error(`seed contract failed: ${contractResult.error.message}`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({ marker: rows.marker, lead_id: rows.lead.id, contract_id: rows.contract.id, contract_no: rows.contractNo })}\n`);
    return;
  }
  if (mode === "cleanup") {
    const [leadId, contractId] = rest;
    if (!UUID.test(leadId ?? "") || !UUID.test(contractId ?? "")) refuse("cleanup needs lead id and contract id");
    // Staging data is disposable; a leftover row is reported, never fatal.
    const contract = await db.from("contracts").delete().eq("id", contractId);
    const lead = await db.from("leads").delete().eq("id", leadId);
    process.stdout.write(`${JSON.stringify({ contract_deleted: !contract.error, lead_deleted: !lead.error })}\n`);
    return;
  }
  refuse("mode must be seed or cleanup");
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  await main(process.argv.slice(2));
}
