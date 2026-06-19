-- Fix: Ensure DELETE RLS is enforced on leads table
-- 2026-06-18: Sales could delete any lead (even unassigned/admin-assigned)
-- Root cause: admin_all (FOR ALL) may have been dropped or ineffective

-- Recreate DELETE policy for leads
DROP POLICY IF EXISTS "leads_delete_admin_boss" ON leads;
DROP POLICY IF EXISTS "admin_all" ON leads;  -- Remove old ambiguous FOR ALL

-- Admin/boss only for ALL operations
CREATE POLICY "leads_admin_all_ops" ON leads FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- Sales can SELECT their own leads
DROP POLICY IF EXISTS "leads_sales_see" ON leads;
CREATE POLICY "leads_sales_see" ON leads FOR SELECT
  USING (assigned_to = auth.uid());

-- Sales can INSERT leads assigned to themselves or unassigned
DROP POLICY IF EXISTS "leads_sales_insert" ON leads;
CREATE POLICY "leads_sales_insert" ON leads FOR INSERT
  WITH CHECK (
    assigned_to = auth.uid()
    OR assigned_to IS NULL
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))
  );

-- Sales can UPDATE only their own leads
DROP POLICY IF EXISTS "leads_sales_update" ON leads;
CREATE POLICY "leads_sales_update" ON leads FOR UPDATE
  USING (assigned_to = auth.uid())
  WITH CHECK (assigned_to = auth.uid());
