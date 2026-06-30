-- Fix 1: Add INSERT policy for sales/boss on leads
-- 2026-06-04

-- Sales can create leads (assigned to themselves or unassigned)
CREATE POLICY "sales_create_leads" ON leads FOR INSERT
  WITH CHECK (
    auth.uid() = assigned_to
    OR assigned_to IS NULL
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))
  );

-- Boss role also needs INSERT (same as admin but using boss role name)
-- Already covered by sales_create_leads since it checks admin/boss

-- Activities: ensure sales can insert activities on their own leads
CREATE POLICY "activity_sales_create_on_lead" ON activities FOR INSERT
  WITH CHECK (
    lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))
  );
