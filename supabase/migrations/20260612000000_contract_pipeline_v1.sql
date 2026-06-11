-- ============================================================
-- Contract Pipeline v1 — Phase 1 Data Foundation
-- 2026-06-12
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- 1. contracts 表改造
-- ════════════════════════════════════════════════════════════

-- 1a. 删除 approval_status 列（单字段 status 管理全生命周期）
ALTER TABLE contracts DROP COLUMN IF EXISTS approval_status;

-- 1b. 扩展 status CHECK 约束
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_status_check;
ALTER TABLE contracts ADD CONSTRAINT contracts_status_check
  CHECK (status IN (
    'draft',
    'pending_admin',
    'pending_ceo',
    'approved',
    'active',
    'revoking',
    'superseded',
    'suspended',
    'completed',
    'terminated',
    'rejected'
  ));

-- 1c. 加盖章文件字段
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS sealed_file_url TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS sealed_file_metadata JSONB;

-- 1d. quotation_id 已存在（确认无操作）
-- quotation_id UUID REFERENCES quotations(id) already in schema

-- ════════════════════════════════════════════════════════════
-- 2. 新建 contract_approvals 表
-- ════════════════════════════════════════════════════════════

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

-- ════════════════════════════════════════════════════════════
-- 3. 新建 payment_allocations 表
-- ════════════════════════════════════════════════════════════

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

-- ════════════════════════════════════════════════════════════
-- 4. installment_plans 改造
-- ════════════════════════════════════════════════════════════

-- 4a. 加 allocated_amount
ALTER TABLE installment_plans ADD COLUMN IF NOT EXISTS allocated_amount DECIMAL(12,2) NOT NULL DEFAULT 0;

-- 4b. 扩展 status CHECK
ALTER TABLE installment_plans DROP CONSTRAINT IF EXISTS installment_plans_status_check;
ALTER TABLE installment_plans ADD CONSTRAINT installment_plans_status_check
  CHECK (status IN ('pending', 'partial', 'paid', 'overdue', 'cancelled'));

-- ════════════════════════════════════════════════════════════
-- 5. quotations 表改造（报价→合同衔接）
-- ════════════════════════════════════════════════════════════

-- 5a. 扩展 status CHECK（加 won, contract_created）
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_status_check;
ALTER TABLE quotations ADD CONSTRAINT quotations_status_check
  CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'won', 'contract_created'));

-- 5b. 加 contract_id 反向引用
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES contracts(id);

-- 5c. 加 quotation_type（区分标准报价 vs 变更报价）
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS quotation_type TEXT NOT NULL DEFAULT 'standard'
  CHECK (quotation_type IN ('standard', 'variation'));

-- ════════════════════════════════════════════════════════════
-- 6. kpi_targets 改造
-- ════════════════════════════════════════════════════════════

ALTER TABLE kpi_targets ADD COLUMN IF NOT EXISTS actual_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ════════════════════════════════════════════════════════════
-- 7. notifications 类型扩展
-- ════════════════════════════════════════════════════════════

-- Drop and recreate notification type constraint to include new types
-- (The existing constraint was added in 20260610000002_fix_notification_types.sql)
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'lead_assigned',
    'lead_stage_changed',
    'follow_up_reminder',
    'follow_up_overdue',
    'contract_signed',
    'payment_received',
    'payment_overdue',
    'first_payment_reminder',
    'contract_rejected',
    'contract_superseded',
    'contract_approved',
    'contract_pending_approval'
  ));
