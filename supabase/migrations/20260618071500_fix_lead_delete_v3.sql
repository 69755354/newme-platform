-- Fix: Leads DELETE RLS - simplified approach
-- 2026-06-18 07:15
-- Drop only DELETE-related policies, keep SELECT policies intact.

DROP POLICY IF EXISTS "leads_delete_admin_boss" ON leads;
DROP POLICY IF EXISTS "leads_admin_all_ops" ON leads;

CREATE POLICY "leads_delete_admin_boss" ON leads
  FOR DELETE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'boss')
  );
