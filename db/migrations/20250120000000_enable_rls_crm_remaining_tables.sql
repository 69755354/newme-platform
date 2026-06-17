```sql
-- Migration: Enable RLS on contract_approvals, payment_allocations, marketing_campaigns
-- Description: Add Row Level Security to remaining unprotected CRM tables
-- Depends on: existing tenant_context / current_tenant_id() helper used by other CRM tables

-- ============================================================================
-- 1. contract_approvals
-- ============================================================================
ALTER TABLE contract_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_approvals FORCE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS contract_approvals_tenant_select ON contract_approvals;
DROP POLICY IF EXISTS contract_approvals_tenant_insert ON contract_approvals;
DROP POLICY IF EXISTS contract_approvals_tenant_update ON contract_approvals;
DROP POLICY IF EXISTS contract_approvals_tenant_delete ON contract_approvals;

CREATE POLICY contract_approvals_tenant_select
    ON contract_approvals
    FOR SELECT
    USING (
        tenant_id = current_tenant_id()
        OR approver_id = auth.uid()
    );

CREATE POLICY contract_approvals_tenant_insert
    ON contract_approvals
    FOR INSERT
    WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY contract_approvals_tenant_update
    ON contract_approvals
    FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY contract_approvals_tenant_delete
    ON contract_approvals
    FOR DELETE
    USING (tenant_id = current_tenant_id());

-- ============================================================================
-- 2. payment_allocations
-- ============================================================================
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_allocations_tenant_select ON payment_allocations;
DROP POLICY IF EXISTS payment_allocations_tenant_insert ON payment_allocations;
DROP POLICY IF EXISTS payment_allocations_tenant_update ON payment_allocations;
DROP POLICY IF EXISTS payment_allocations_tenant_delete ON payment_allocations;

CREATE POLICY payment_allocations_tenant_select
    ON payment_allocations
    FOR SELECT
    USING (tenant_id = current_tenant_id());

CREATE POLICY payment_allocations_tenant_insert
    ON payment_allocations
    FOR INSERT
    WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY payment_allocations_tenant_update
    ON payment_allocations
    FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY payment_allocations_tenant_delete
    ON payment_allocations
    FOR DELETE
    USING (tenant_id = current_tenant_id());

-- ============================================================================
-- 3. marketing_campaigns
-- ============================================================================
ALTER TABLE marketing_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaigns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_campaigns_tenant_select ON marketing_campaigns;
DROP POLICY IF EXISTS marketing_campaigns_tenant_insert ON marketing_campaigns;
DROP POLICY IF EXISTS marketing_campaigns_tenant_update ON marketing_campaigns;
DROP POLICY IF EXISTS marketing_campaigns_tenant_delete ON marketing_campaigns;

CREATE POLICY marketing_campaigns_tenant_select
    ON marketing_campaigns
    FOR SELECT
    USING (
        tenant_id = current_tenant_id()
        OR owner_id = auth.uid()
    );

CREATE POLICY marketing_campaigns_tenant_insert
    ON marketing_campaigns
    FOR INSERT
    WITH CHECK (
        tenant_id = current_tenant_id()
        AND owner_id = auth.uid()
    );

CREATE POLICY marketing_campaigns_tenant_update
    ON marketing_campaigns
    FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY marketing_campaigns_tenant_delete
    ON marketing_campaigns
    FOR DELETE
    USING (tenant_id = current_tenant_id());

-- ============================================================================
-- Verification
-- ============================================================================
SELECT
    c.relname       AS table_name,
    c.relrowsecurity AS rls_enabled,
    c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('contract_approvals', 'payment_allocations', 'marketing_campaigns')
ORDER BY c.relname;
```

#