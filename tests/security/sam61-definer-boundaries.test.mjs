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

// The combined S2 release redefines four money routines and adds one private helper.
// None of them may lose the pinned search path or the session entry guard, and the
// helper that moves a lead's stage must not be callable by any end-user role.
test("S2 combined release: redefined definers keep a pinned search path and the entry guard; the stage helper is private", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20261104110000_role_least_privilege.sql", import.meta.url), "utf8");
  for (const fn of ["approve_contract", "set_contract_status", "convert_quotation_to_contract", "create_contract"]) {
    const start = sql.indexOf(`create or replace function public.${fn}(`);
    assert.notEqual(start, -1, fn);
    const head = sql.slice(start, sql.indexOf("as $function$", start));
    assert.match(head, /SECURITY DEFINER/, fn);
    assert.match(head, /SET search_path TO 'pg_catalog', 'public', 'pg_temp'/, fn);
    const body = sql.slice(start, sql.indexOf("$function$;", start + 20));
    assert.match(body, /perform public\.assert_current_session_at_entry\(\);/, `${fn} keeps the session entry guard`);
    assert.match(body, /public\.money_actor\(/, `${fn} keeps the actor/role check`);
  }
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.advance_lead_to_pending_decision\(uuid, uuid, text\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.advance_lead_to_pending_decision[\s\S]*?SET search_path = pg_catalog, public, pg_temp/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.advance_lead_to_pending_decision/);
});
