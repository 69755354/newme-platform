-- NO_ROLLBACK: drops one row-level-security policy and replaces one routine in place, no data written. Manual undo: recreate the policy (exact definition in 20260630200000_rls_policy_remediation.sql) and re-apply delete_lead_atomic from supabase/replay/production-schema-baseline.sql:
--   create policy policy_leads_delete_sales on public.leads for delete to authenticated using (assigned_to = auth.uid());
-- ============================================================================
-- OS fix S46 - only admin / boss may delete a lead
-- ============================================================================
-- The delete button is already hidden from sales in the UI (S41), but the policy that lets a salesperson delete their own
-- lead (policy_leads_delete_sales) was still live, and the lead page deletes with the browser client. Dropping it leaves
-- policy_leads_delete_admin (role admin or boss, created in 20260630200000), so admin keeps every right boss has.
-- The same rule in the routine the leads list / board uses: public.delete_lead_atomic is SECURITY DEFINER, so it bypasses
-- row-level security and used to let a salesperson delete their own lead. Replaced in place (same signature, SECURITY DEFINER,
-- pinned search_path); a salesperson now gets FORBIDDEN_LEAD_DELETE. Grants are re-stated (authenticated and service_role, not anon).
-- Idempotent: drop policy if exists, create or replace.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

drop policy if exists policy_leads_delete_sales on public.leads;

CREATE OR REPLACE FUNCTION public.delete_lead_atomic(p_lead_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_lead public.leads%ROWTYPE;
  v_response jsonb;
BEGIN
  PERFORM public.assert_current_session_at_entry();
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY'; END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  -- S46: only admin and boss may delete a lead (a salesperson may no longer delete their own)
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss') THEN
    RAISE EXCEPTION 'FORBIDDEN_LEAD_DELETE';
  END IF;

  SELECT response INTO v_response
  FROM public.lead_deletion_requests
  WHERE actor_id = v_actor_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_response || jsonb_build_object('idempotent_replay', true); END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;

  BEGIN
    DELETE FROM public.leads WHERE id = p_lead_id;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'LEAD_DELETE_BLOCKED';
  END;

  v_response := jsonb_build_object('lead_id', p_lead_id, 'deleted', true);
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, details)
  VALUES (
    v_actor_id, 'lead_deleted', 'lead', p_lead_id,
    jsonb_build_object('customer_name', v_lead.customer_name, 'assigned_to', v_lead.assigned_to, 'stage', v_lead.stage)
  );
  INSERT INTO public.lead_deletion_requests (actor_id, idempotency_key, deleted_lead_id, response)
  VALUES (v_actor_id, p_idempotency_key, p_lead_id, v_response);
  RETURN v_response;
END;
$function$;

revoke all on function public.delete_lead_atomic(uuid, uuid) from public, anon;
grant execute on function public.delete_lead_atomic(uuid, uuid) to authenticated, service_role;
