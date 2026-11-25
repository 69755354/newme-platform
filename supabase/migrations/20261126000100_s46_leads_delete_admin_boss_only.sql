-- NO_ROLLBACK: drops one row-level-security policy, no data written. Manual undo, recreate it (exact definition in 20260630200000_rls_policy_remediation.sql):
--   create policy policy_leads_delete_sales on public.leads for delete to authenticated using (assigned_to = auth.uid());
-- ============================================================================
-- OS fix S46 - only admin / boss may delete a lead
-- ============================================================================
-- The delete button is already hidden from sales in the UI (S41), but the policy that lets a salesperson delete their own
-- lead (policy_leads_delete_sales) was still live, and the lead page deletes with the browser client. Dropping it leaves
-- policy_leads_delete_admin (role admin or boss, created in 20260630200000), so admin keeps every right boss has.
-- Idempotent: drop policy if exists.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

drop policy if exists policy_leads_delete_sales on public.leads;
