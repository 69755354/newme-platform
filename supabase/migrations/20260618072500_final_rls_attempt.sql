-- Final attempt: RESTRICTIVE policy for leads DELETE
-- If this doesn't work, PostgREST DELETE RLS is fundamentally broken on this table

DROP POLICY IF EXISTS "leads_delete_admin_boss" ON leads;

-- Permissive: allow admin/boss
CREATE POLICY "leads_delete_admin" ON leads
  FOR DELETE 
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND profiles.role IN ('admin', 'boss')
    )
  );

-- Restrictive: explicitly block non-admin/boss
CREATE POLICY "leads_delete_restrictive" ON leads
  AS RESTRICTIVE
  FOR DELETE 
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND profiles.role IN ('admin', 'boss')
    )
  );

NOTIFY pgrst, 'reload schema';
