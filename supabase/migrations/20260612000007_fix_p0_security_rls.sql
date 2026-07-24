-- Migration: Fix P0 security issues
-- Date: 2026-06-12
-- 1. Enable RLS on 3 tables that had no protection
-- 2. Fix notifications_service_insert to require authentication

-- ============================================================
-- P0-1: Enable RLS on contract_approvals, payment_allocations, marketing_campaigns
-- ============================================================
ALTER TABLE contract_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF to_regclass('public.marketing_campaigns') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.marketing_campaigns ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- contract_approvals policies
CREATE POLICY ca_admin_all ON contract_approvals
  FOR ALL TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','boss']));

CREATE POLICY ca_sales_select ON contract_approvals
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracts
    WHERE contracts.id = contract_approvals.contract_id
    AND contracts.sales_id = auth.uid()
  ));

-- payment_allocations policies
CREATE POLICY pa_admin_all ON payment_allocations
  FOR ALL TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','boss']));

CREATE POLICY pa_sales_select ON payment_allocations
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracts c
    JOIN payments p ON p.contract_id = c.id
    WHERE p.id = payment_allocations.payment_id
    AND c.sales_id = auth.uid()
  ));

-- marketing_campaigns policies (admin/boss only)
DO $$ BEGIN
  IF to_regclass('public.marketing_campaigns') IS NOT NULL THEN
    EXECUTE 'CREATE POLICY mc_admin_all ON public.marketing_campaigns
      FOR ALL TO authenticated
      USING (get_my_role() = ANY (ARRAY[''admin'',''boss'']))';
  END IF;
END $$;

-- ============================================================
-- P0-2: Fix notifications_service_insert - restrict to authenticated
-- ============================================================
DROP POLICY IF EXISTS notifications_service_insert ON notifications;

CREATE POLICY notifications_service_insert ON notifications
  FOR INSERT TO authenticated
  WITH CHECK (true);
