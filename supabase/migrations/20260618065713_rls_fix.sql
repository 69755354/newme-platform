-- CRM: P0-1 Enable RLS on unprotected tables
ALTER TABLE contract_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaigns ENABLE ROW LEVEL SECURITY;

-- Admin full access
CREATE POLICY "admin_all_contract_approvals" ON contract_approvals FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'admin') WITH CHECK ((auth.jwt() ->> 'role') = 'admin');
CREATE POLICY "admin_all_payment_allocations" ON payment_allocations FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'admin') WITH CHECK ((auth.jwt() ->> 'role') = 'admin');
CREATE POLICY "admin_all_marketing_campaigns" ON marketing_campaigns FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role') = 'admin') WITH CHECK ((auth.jwt() ->> 'role') = 'admin');

-- Sales read access
CREATE POLICY "sales_select_contract_approvals" ON contract_approvals FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'role') IN ('sales', 'admin'));
CREATE POLICY "sales_select_payment_allocations" ON payment_allocations FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'role') IN ('sales', 'admin'));
CREATE POLICY "sales_select_marketing_campaigns" ON marketing_campaigns FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'role') IN ('sales', 'admin'));