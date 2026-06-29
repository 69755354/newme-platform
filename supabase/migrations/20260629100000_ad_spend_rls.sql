-- Enable RLS on ad_spend table
ALTER TABLE ad_spend ENABLE ROW LEVEL SECURITY;

-- Admin/Boss can see all ad_spend data
DROP POLICY IF EXISTS "ad_spend_admin_select" ON ad_spend;
CREATE POLICY "ad_spend_admin_select" ON ad_spend FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- Admin/Boss can insert ad spend data
DROP POLICY IF EXISTS "ad_spend_admin_insert" ON ad_spend;
CREATE POLICY "ad_spend_admin_insert" ON ad_spend FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- Admin/Boss can update ad spend data
DROP POLICY IF EXISTS "ad_spend_admin_update" ON ad_spend;
CREATE POLICY "ad_spend_admin_update" ON ad_spend FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- Admin/Boss can delete ad spend data
DROP POLICY IF EXISTS "ad_spend_admin_delete" ON ad_spend;
CREATE POLICY "ad_spend_admin_delete" ON ad_spend FOR DELETE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
