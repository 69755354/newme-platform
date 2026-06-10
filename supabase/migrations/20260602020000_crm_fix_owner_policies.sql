-- ================================================
-- NewMe CRM MVP Fix - Owner column, anon policies
-- 2026-06-02 Hotfix
-- ================================================

-- ═══════════════ 1. Add owner column to leads ═══════════════
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner TEXT;
UPDATE leads SET owner = rep_name WHERE owner IS NULL AND rep_name IS NOT NULL;

-- ═══════════════ 2. Fix business_events RLS for anon users ═══════════════
-- Drop old policies that block anon (and break authenticated ops too
-- since frontend doesn't send user_id)
DROP POLICY IF EXISTS be_sales_create ON business_events;
DROP POLICY IF EXISTS be_sales_see ON business_events;

-- Add permissive policies for public (anon + authenticated)
CREATE POLICY be_anon_insert ON business_events FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY be_anon_select ON business_events FOR SELECT
  TO public
  USING (true);

CREATE POLICY be_anon_update ON business_events FOR UPDATE
  TO public
  USING (true);

-- ═══════════════ 3. Refresh PostgREST schema cache ═══════════════
NOTIFY pgrst, 'reload schema';
