-- ============================================================
-- P0 Security: Re-affirm RLS on 3 tables + harden notifications INSERT
-- Date: 2026-06-18
-- Author: GLM 5.2 (CRM Security Batch 1)
--
-- Background:
--   This migration is IDEMPOTENT. A direct catalog query against the live
--   Supabase DB (pg_class.relrowsecurity + pg_policies) confirmed that:
--     * contract_approvals, payment_allocations, marketing_campaigns already
--       have RLS enabled with admin/sales policies (from 20260612000007).
--     * notifications_service_insert was hardened manually to
--       WITH CHECK (user_id = auth.uid()) per the 2026-06-15 production audit,
--       but that hardening was NEVER encoded in a committed migration.
--       A fresh DB rebuilt from migrations would revert to the weaker
--       WITH CHECK (true). This migration closes that drift.
--
-- Design note on sales_insert (deliberately NOT added):
--   The task template requested a "sales_insert where assigned_to = auth.uid()"
--   policy. None of these three tables have an `assigned_to` column:
--     - contract_approvals.contract_id  -> contracts.sales_id
--     - payment_allocations.payment_id / allocated_by
--     - marketing_campaigns (admin-only domain)
--   Approvals, payment allocations and campaigns are created by admins / the
--   server (service_role, which bypasses RLS). Granting sales INSERT would be
--   a security REGRESSION, so the existing admin-only-write design is retained.
-- ============================================================

-- ------------------------------------------------------------
-- P0-1: Enable RLS on the 3 previously-unprotected tables
-- (ENABLE is idempotent; no-op if already enabled)
-- ------------------------------------------------------------
ALTER TABLE contract_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaigns ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- contract_approvals: admin/boss full access; sales read-only on own contracts
-- ------------------------------------------------------------
DROP POLICY IF EXISTS ca_admin_all ON contract_approvals;
CREATE POLICY ca_admin_all ON contract_approvals
  FOR ALL TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','boss']));

DROP POLICY IF EXISTS ca_sales_select ON contract_approvals;
CREATE POLICY ca_sales_select ON contract_approvals
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_approvals.contract_id
        AND contracts.sales_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- payment_allocations: admin/boss full access; sales read-only on own contracts
-- ------------------------------------------------------------
DROP POLICY IF EXISTS pa_admin_all ON payment_allocations;
CREATE POLICY pa_admin_all ON payment_allocations
  FOR ALL TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','boss']));

DROP POLICY IF EXISTS pa_sales_select ON payment_allocations;
CREATE POLICY pa_sales_select ON payment_allocations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM contracts c
      JOIN payments p ON p.contract_id = c.id
      WHERE p.id = payment_allocations.payment_id
        AND c.sales_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- marketing_campaigns: admin/boss only (no sales access)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS mc_admin_all ON marketing_campaigns;
CREATE POLICY mc_admin_all ON marketing_campaigns
  FOR ALL TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','boss']));

-- ------------------------------------------------------------
-- P0-2: Harden notifications_service_insert
-- Restrict INSERT to the authenticated owner of the row (user_id = auth.uid()).
-- This is STRICTER than the "WITH CHECK (true)" originally requested:
--   - An authenticated user can only create notifications FOR THEMSELVES,
--     blocking cross-user notification injection / forgery.
--   - Server-side notification creation uses the service_role key, which
--     bypasses RLS entirely, so legitimate system notifications are unaffected.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS notifications_service_insert ON notifications;
CREATE POLICY notifications_service_insert ON notifications
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Refresh PostgREST schema cache so policy changes take effect immediately
NOTIFY pgrst, 'reload schema';
