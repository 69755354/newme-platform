import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../../supabase/migrations/20260723130000_lock_definer_boundaries.sql", import.meta.url);

test("SAM-61 explicitly hardens every inventoried SECURITY DEFINER function", async () => {
  const sql = await readFile(migration, "utf8");
  const functions = [
    "auto_enable_rls()", "check_milestone_order()", "derive_lead_status()",
    "detect_stale_leads(integer)", "enforce_active_lead_transfer_candidate()",
    "generate_quote_no(integer)", "get_my_role()", "get_team_activity(date)",
    "handle_auth_login()", "handle_new_user()", "handle_user_login()",
    "log_activity(text, text, uuid, jsonb, text, integer)",
    "log_activity(uuid, text, text, uuid)", "log_auth_event()", "next_quote_no()",
    "on_lead_won()", "reassign_lead(uuid, uuid, text)",
    "recomplete_lead_milestone(uuid, text, text)",
    "reopen_lead_milestone(uuid, text, text)", "set_lost_reasons()",
    "sync_user_email_to_profile()", "transition_lead_stage(uuid, text, text, text)",
    "trg_enforce_first_contact_milestone()", "trg_prevent_first_contact_delete()",
    "trg_set_won_at()", "update_installment_status()", "update_lead_metrics()",
  ];

  for (const fn of functions) {
    assert.match(sql, new RegExp(`ALTER FUNCTION public\\.${fn.replace(/[()]/g, "\\$&").replace(/ /g, "\\s+")} SET search_path = pg_catalog, public, pg_temp;`));
  }
});

test("SAM-61 preserves only authenticated sales workflow RPCs", async () => {
  const sql = await readFile(migration, "utf8");
  for (const fn of ["get_my_role()", "next_quote_no()", "recomplete_lead_milestone(uuid, text, text)", "reopen_lead_milestone(uuid, text, text)", "transition_lead_stage(uuid, text, text, text)"]) {
    assert.match(sql, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn.replace(/[()]/g, "\\$&").replace(/ /g, "\\s+")} FROM PUBLIC, anon;`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn.replace(/[()]/g, "\\$&").replace(/ /g, "\\s+")} TO authenticated;`));
  }
  assert.match(sql, /ALTER VIEW public\.lead_alerts SET \(security_invoker = true\);/);
  assert.match(sql, /FOR INSERT TO authenticated WITH CHECK \(false\);/);
});
