-- Fix RLS policy for quotations delete
-- Issue: auth.jwt() ->> 'role' syntax is invalid in PostgreSQL
-- Solution: Drop the incorrect policy and create correct one

-- Drop the incorrect policy (if exists)
DROP POLICY IF EXISTS "quotations_sales_delete_own" ON quotations;

-- Create correct policy: creator can delete their own quotations
-- No need to check role - if you created it, you can delete it
CREATE POLICY "quotations_creator_delete_own" ON quotations
  FOR DELETE
  USING (created_by = auth.uid());
