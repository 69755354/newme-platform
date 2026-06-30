-- Fix migration: complete missing parts from contract_pipeline_v1
-- 2026-06-12 fix

-- 1. contract_approvals (missing)
CREATE TABLE IF NOT EXISTS contract_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  step TEXT NOT NULL CHECK (step IN ('admin_review', 'ceo_review')),
  approver_id UUID REFERENCES profiles(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  notes JSONB,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contract_approvals_contract ON contract_approvals(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_approvals_tenant ON contract_approvals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contract_approvals_status ON contract_approvals(status);

-- 2. payment_allocations (missing)
CREATE TABLE IF NOT EXISTS payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES installment_plans(id) ON DELETE CASCADE,
  amount_allocated DECIMAL(12,2) NOT NULL CHECK (amount_allocated > 0),
  allocated_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_plan ON payment_allocations(plan_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_tenant ON payment_allocations(tenant_id);

-- 3. Add missing columns (IF NOT EXISTS guards)
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS sealed_file_url TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS sealed_file_metadata JSONB;
ALTER TABLE installment_plans ADD COLUMN IF NOT EXISTS allocated_amount DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES contracts(id);
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS quotation_type TEXT NOT NULL DEFAULT 'standard'
  CHECK (quotation_type IN ('standard', 'variation'));
ALTER TABLE kpi_targets ADD COLUMN IF NOT EXISTS actual_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

-- 4. Fix notifications constraint to include ALL existing + new types
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'lead_created',
    'lead_stage_change',
    'lead_stage_changed',
    'lead_assigned',
    'quote_created',
    'follow_up_reminder',
    'follow_up_overdue',
    'contract_signed',
    'contract_rejected',
    'contract_superseded',
    'contract_approved',
    'contract_pending_approval',
    'payment_received',
    'payment_overdue',
    'payment_due',
    'first_payment_reminder',
    'kpi_target_set',
    'team_member_added'
  ));

-- 5. Fix contracts status constraint
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_status_check;
ALTER TABLE contracts ADD CONSTRAINT contracts_status_check
  CHECK (status IN (
    'draft', 'pending_admin', 'pending_ceo', 'approved',
    'active', 'revoking', 'superseded', 'suspended',
    'completed', 'terminated', 'rejected'
  ));

-- 6. Fix installment_plans status constraint
ALTER TABLE installment_plans DROP CONSTRAINT IF EXISTS installment_plans_status_check;
ALTER TABLE installment_plans ADD CONSTRAINT installment_plans_status_check
  CHECK (status IN ('pending', 'partial', 'paid', 'overdue', 'cancelled'));

-- 7. Fix quotations status constraint
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_status_check;
ALTER TABLE quotations ADD CONSTRAINT quotations_status_check
  CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'won', 'contract_created'));

-- 8. Drop approval_status column if still exists
ALTER TABLE contracts DROP COLUMN IF EXISTS approval_status;
