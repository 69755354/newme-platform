-- Extreme test: force-deny ALL deletes
DROP POLICY IF EXISTS "leads_delete_admin_boss" ON leads;

CREATE POLICY "leads_delete_admin_boss" ON leads
  FOR DELETE USING (false);
