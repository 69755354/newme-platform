-- Fix: Leads DELETE RLS was missing since v2.2 dropped admin_all without replacement
-- Date: 2026-06-18 07:00
-- Root cause: 20260605000000_newme_crm_v22_complete.sql dropped "admin_all" (FOR ALL)
--   but did NOT create a DELETE policy. 20260605233000_fix_products_leads_rls.sql
--   (which creates leads_delete_admin_boss) was never pushed to remote.

-- Only admin/boss can delete leads
DROP POLICY IF EXISTS "leads_delete_admin_boss" ON leads;
CREATE POLICY "leads_delete_admin_boss" ON leads
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'boss'))
  );
