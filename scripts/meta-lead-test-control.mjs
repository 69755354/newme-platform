#!/usr/bin/env node
// Operator-only CLI. Credentials come from the protected server environment;
// never accept them in argv. No web endpoint or permission expansion is added.
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { lookupTestForm, testFormRegistration, TEST_RECEIPT_ACTION } from "../src/lib/meta-lead-test-isolation.mjs";

export async function controlTestForm(db, { pageId, formId, batchId, action = "status", execute = false, dedicated = false }) {
  if (!["status", "register", "cleanup"].includes(action)) throw Error("test_action_invalid");
  const registration = testFormRegistration({ pageId, formId, batchId });
  const current = await lookupTestForm(db, formId);
  if (current && (current.page_id !== pageId || current.batch_id !== batchId)) throw Error("test_registration_conflict");
  if (action === "register") {
    if (!dedicated) throw Error("dedicated_unused_form_confirmation_required");
    const existing = await db.from("leads").select("id", { head: true, count: "exact" }).eq("form_id", formId);
    if (existing.error || existing.count !== 0) throw Error("test_form_has_customers_or_lookup_failed");
    if (execute && !current) {
      const result = await db.from("audit_logs").insert(registration);
      if (result.error && result.error.code !== "23505") throw Error("test_registration_write_failed");
      const checked = await lookupTestForm(db, formId);
      if (checked?.batch_id !== batchId || checked?.page_id !== pageId) throw Error("test_registration_readback_failed");
    }
    return { mode: execute ? "execute" : "dry_run", registered: Boolean(current) || execute };
  }
  if (!current) throw Error("test_form_not_registered");
  const receipts = await db.from("audit_logs").select("id, details, created_at")
    .eq("action", TEST_RECEIPT_ACTION).eq("target_type", "meta_leadgen_test")
    .eq("details->>batch_id", batchId).eq("details->>form_id", formId).limit(1001);
  if (receipts.error || !Array.isArray(receipts.data) || receipts.data.length > 1000) throw Error("test_receipts_lookup_failed_or_limit");
  if (action === "cleanup" && execute) {
    for (const row of receipts.data) {
      const result = await db.from("audit_logs").delete().eq("id", row.id)
        .eq("action", TEST_RECEIPT_ACTION).eq("target_type", "meta_leadgen_test")
        .eq("details->>batch_id", batchId).eq("details->>form_id", formId);
      if (result.error) throw Error("test_receipt_cleanup_failed");
    }
    const after = await controlTestForm(db, { pageId, formId, batchId });
    if (after.receipts.length) throw Error("test_receipts_remain_or_replayed");
    return { mode: "execute", cleaned: receipts.data.length, registration_retained: true };
  }
  return { mode: execute ? "execute" : "dry_run", registered: true,
    receipts: receipts.data.map(row => ({ id: row.id, origin: row.details?.origin,
      leadgen_id: row.details?.leadgen_id, created_at: row.created_at })) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const flags = new Map();
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i];
      if (flags.has(flag)) throw Error("test_arguments_invalid");
      if (["--execute", "--dedicated-unused-form-confirmed"].includes(flag)) flags.set(flag, true);
      else if (["--action", "--page-id", "--form-id", "--batch-id"].includes(flag) && process.argv[i + 1]) flags.set(flag, process.argv[++i]);
      else throw Error("test_arguments_invalid");
    }
    const env = process.env;
    const url = env.NEXT_PUBLIC_SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw Error("test_server_configuration_missing");
    const db = createClient(url, key,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const result = await controlTestForm(db, { pageId: flags.get("--page-id"), formId: flags.get("--form-id"),
      batchId: flags.get("--batch-id"), action: flags.get("--action") ?? "status", execute: flags.has("--execute"),
      dedicated: flags.has("--dedicated-unused-form-confirmed") });
    console.log(JSON.stringify(result));
  } catch {
    // Never reflect SDK/network errors: they can contain headers or contacts.
    console.error("meta_test_control_failed"); process.exitCode = 1;
  }
}
