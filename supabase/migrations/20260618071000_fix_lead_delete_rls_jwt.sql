-- Fix: Leads DELETE RLS - use JWT claims directly instead of profiles table lookup
-- 2026-06-18 07:10
-- The profiles-table-based policy wasn't blocking sales despite correct role.
-- Using app_metadata->>role from JWT which is the authoritative source.

DROP POLICY IF EXISTS "leads_delete_admin_boss" ON leads;

CREATE POLICY "leads_delete_admin_boss" ON leads
  FOR DELETE USING (
    auth.jwt() ->> 'role' = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin', 'boss')
  );
