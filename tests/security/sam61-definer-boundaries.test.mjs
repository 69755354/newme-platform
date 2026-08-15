import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const migration = new URL("../../supabase/migrations/20260723130000_lock_definer_boundaries.sql", import.meta.url);

test("SAM-61 fixes the search path of every current public function", async () => {
  const sql = await readFile(migration, "utf8");
  const functions = [
    "allocate_payment(uuid, jsonb, uuid)", "apply_standard_rls(text)",
    "approve_contract(uuid, uuid, text, text)", "auto_create_task_from_followup()",
    "auto_enable_rls()", "check_milestone_order()", "derive_lead_status()",
    "confirm_payment(uuid, uuid)", "days_since_last_contact(uuid)",
    "detect_stale_leads(integer)", "enforce_active_lead_transfer_candidate()", "enforce_followup_required()",
    "generate_quote_no(integer)", "get_my_role()", "get_team_activity(date)",
    "handle_auth_login()", "handle_new_user()", "handle_user_login()",
    "log_activity(text, text, uuid, jsonb, text, integer)",
    "log_activity(uuid, text, text, uuid)", "log_auth_event()", "milestone_order(text)", "next_quote_no()",
    "on_lead_won()", "reassign_lead(uuid, uuid, text)",
    "recomplete_lead_milestone(uuid, text, text)",
    "reopen_lead_milestone(uuid, text, text)", "set_lost_reasons()", "set_updated_at()",
    "sync_lead_next_followup()", "sync_task_from_lead()",
    "sync_user_email_to_profile()", "transition_lead_stage(uuid, text, text, text)",
    "transition_lead_stage(uuid, text, text, text, uuid)",
    "trg_check_first_contact_gate()", "trg_check_stage_sequence()",
    "trg_enforce_first_contact_milestone()", "trg_prevent_first_contact_delete()",
    "trg_set_won_at()", "update_installment_status()", "update_lead_metrics()",
  ];

  for (const fn of functions) {
    const escaped = escapeRegExp(fn).replace(/ /g, "\\s+");
    if (fn.startsWith("transition_lead_stage")) {
      assert.ok(sql.includes(`to_regprocedure('public.${fn.replace(/ /g, "")}')`));
      assert.match(sql, new RegExp(`ALTER FUNCTION public\\.${escaped} SET search_path = pg_catalog, public, pg_temp`));
    } else {
      assert.match(sql, new RegExp(`ALTER FUNCTION public\\.${escaped} SET search_path = pg_catalog, public, pg_temp;`));
    }
  }
});

test("SAM-61 preserves only authenticated sales workflow RPCs", async () => {
  const sql = await readFile(migration, "utf8");
  for (const fn of ["get_my_role()", "next_quote_no()", "recomplete_lead_milestone(uuid, text, text)", "reopen_lead_milestone(uuid, text, text)", "transition_lead_stage(uuid, text, text, text)", "transition_lead_stage(uuid, text, text, text, uuid)"]) {
    const escaped = escapeRegExp(fn).replace(/ /g, "\\s+");
    assert.match(sql, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${escaped} FROM PUBLIC, anon`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped} TO authenticated`));
  }
  assert.match(sql, /ALTER VIEW public\.lead_alerts SET \(security_invoker = true\);/);
  assert.match(sql, /FOR INSERT TO authenticated WITH CHECK \(false\);/);
});
