-- Final attempt: force-disable then re-enable RLS on leads
-- Then use a belt-and-suspenders approach with NOTIFY

-- Step 1: Force RLS reset
ALTER TABLE leads DISABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- Step 2: Drop all DELETE policies
DROP POLICY IF EXISTS "leads_delete_admin_boss" ON leads;

-- Step 3: Create explicit admin/boss DELETE policy
CREATE POLICY "leads_delete_admin_boss" ON leads
  FOR DELETE 
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
        AND profiles.role IN ('admin', 'boss')
    )
  );

-- Step 4: Force PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
