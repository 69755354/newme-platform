-- CRM v3 Phase B: Power-hold migration adding CRM enrichment fields to leads table
-- All columns use ADD COLUMN IF NOT EXISTS for idempotent, non-locking application
-- Excludes ac_brand, lost_reason, project_status (already present in production)
-- rule_009: 幂等
-- rule_017: Phase B 字段定义

ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_result TEXT
  CHECK (contact_result IN ('interested','not_interested','no_answer'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS not_interested_reason TEXT;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS project_type TEXT
  CHECK (project_type IN ('villa','apartment','developer'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS emirate TEXT;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS area TEXT;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_company_type TEXT;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_position TEXT;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS smart_requirements JSONB;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_budget NUMERIC(12,2);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS expected_sign_date DATE;
