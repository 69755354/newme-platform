-- SAM-61: privileged database objects must not be callable by anonymous users.
-- This is intentionally explicit: do not grant/revoke the whole public schema.

-- A fixed search path prevents caller-controlled object shadowing.
ALTER FUNCTION public.allocate_payment(uuid, jsonb, uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.apply_standard_rls(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.approve_contract(uuid, uuid, text, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auto_create_task_from_followup() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auto_enable_rls() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.check_milestone_order() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.confirm_payment(uuid, uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.days_since_last_contact(uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.derive_lead_status() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.detect_stale_leads(integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.enforce_active_lead_transfer_candidate() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.enforce_followup_required() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.generate_quote_no(integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.get_my_role() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.get_team_activity(date) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.handle_auth_login() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.handle_new_user() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.handle_user_login() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.log_activity(text, text, uuid, jsonb, text, integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.log_activity(uuid, text, text, uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.log_auth_event() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.milestone_order(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.next_quote_no() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.on_lead_won() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.reassign_lead(uuid, uuid, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.recomplete_lead_milestone(uuid, text, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.reopen_lead_milestone(uuid, text, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.set_lost_reasons() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.set_updated_at() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.sync_lead_next_followup() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.sync_task_from_lead() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.sync_user_email_to_profile() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.transition_lead_stage(uuid, text, text, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.trg_enforce_first_contact_milestone() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.trg_check_first_contact_gate() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.trg_check_stage_sequence() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.trg_prevent_first_contact_delete() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.trg_set_won_at() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.update_installment_status() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.update_lead_metrics() SET search_path = pg_catalog, public, pg_temp;

-- Trigger, maintenance and internal helper functions are never API endpoints.
REVOKE EXECUTE ON FUNCTION public.auto_enable_rls() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_milestone_order() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.derive_lead_status() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.detect_stale_leads(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_active_lead_transfer_candidate() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_quote_no(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_team_activity(date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_auth_login() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_user_login() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_activity(text, text, uuid, jsonb, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_activity(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_auth_event() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.on_lead_won() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reassign_lead(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_lost_reasons() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_user_email_to_profile() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_enforce_first_contact_milestone() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_prevent_first_contact_delete() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_set_won_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_installment_status() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_lead_metrics() FROM PUBLIC, anon, authenticated;

-- These RPCs are authenticated user workflows. No anonymous caller is allowed.
REVOKE EXECUTE ON FUNCTION public.get_my_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_quote_no() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.recomplete_lead_milestone(uuid, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reopen_lead_milestone(uuid, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.transition_lead_stage(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_quote_no() TO authenticated;
GRANT EXECUTE ON FUNCTION public.recomplete_lead_milestone(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_lead_milestone(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_lead_stage(uuid, text, text, text) TO authenticated;

-- The alerts view must obey the caller's RLS on leads; its route already scopes sales to self.
ALTER VIEW public.lead_alerts SET (security_invoker = true);
REVOKE ALL ON TABLE public.lead_alerts FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.lead_alerts TO authenticated;

-- Audit/session records are server-owned evidence, never browser-submitted facts.
DROP POLICY IF EXISTS policy_activity_logs_insert_authenticated ON public.activity_logs;
CREATE POLICY policy_activity_logs_insert_server_only ON public.activity_logs
  FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS policy_audit_logs_insert_authenticated ON public.audit_logs;
CREATE POLICY policy_audit_logs_insert_server_only ON public.audit_logs
  FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS policy_user_session_daily_insert_authenticated ON public.user_session_daily;
CREATE POLICY policy_user_session_daily_insert_server_only ON public.user_session_daily
  FOR INSERT TO authenticated WITH CHECK (false);
