-- Migration: Fix Products RLS + Add Leads DELETE RLS
-- Date: 2026-06-05

-- ============================================================
-- #8: Products RLS — restrict INSERT/UPDATE/DELETE to admin/boss only
-- ============================================================

-- Drop existing permissive product policies
DROP POLICY IF EXISTS "products_all_select" ON products;
DROP POLICY IF EXISTS "products_all_insert" ON products;
DROP POLICY IF EXISTS "products_all_update" ON products;
DROP POLICY IF EXISTS "products_all_delete" ON products;

-- SELECT: any authenticated user can read
CREATE POLICY "products_select_all" ON products
  FOR SELECT USING (auth.role() = 'authenticated');

-- INSERT: only admin/boss
CREATE POLICY "products_insert_admin_boss" ON products
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'boss'))
  );

-- UPDATE: only admin/boss
CREATE POLICY "products_update_admin_boss" ON products
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'boss'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'boss'))
  );

-- DELETE: only admin/boss
CREATE POLICY "products_delete_admin_boss" ON products
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'boss'))
  );

-- ============================================================
-- #9: Leads DELETE RLS — add admin/boss delete policy
-- ============================================================

-- Drop existing if any
DROP POLICY IF EXISTS "leads_delete_admin_boss" ON leads;

-- DELETE: only admin/boss can delete leads
CREATE POLICY "leads_delete_admin_boss" ON leads
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'boss'))
  );
