-- Migration: add composite indexes for high-frequency queries
-- Audit P-04:补缺失的复合索引
-- 验证发现审计报告部分列名有误（payments 无 lead_id 列、activity_logs 无 date 列）
-- 仅 installment_plans 的复合索引有效，其余建议索引已存在
-- CREATE INDEX IF NOT EXISTS — 幂等，可安全重跑

-- 1. 逾期分期查询：WHERE status = ... ORDER BY due_date
CREATE INDEX IF NOT EXISTS idx_installments_status_due
  ON installment_plans(status, due_date);

-- 注：以下审计建议但已验证不需要/已存在：
--   payments(lead_id)                    → 列不存在（payments 只有 contract_id，已有 idx_payments_contract）
--   activity_logs(user_id, date)         → 无 date 列；idx_activity_logs_user + idx_activity_logs_created 已覆盖
--   notifications(user_id, read)         → idx_notifications_user_read_created ✓
--   quotations(lead_id)                  → idx_quotations_lead ✓
--   activities(user_id)                  → idx_activities_user ✓
--   leads(lead_status, assigned_to)      → idx_leads_assigned_stage ✓
