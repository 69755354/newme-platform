-- 20260625152302_add_ac_brand_column.sql
-- Fix A: ac_brand exists in production but was never captured in a migration.
-- The Phase B migration (20260623040000_crm_v3_phase_b_fields.sql) deliberately
-- excluded it ("already present in production"), so any dev/staging/CI database
-- rebuilt from migrations is missing the column — and saveProjectInfo() / the
-- ac_brand InlineEdit fail 100% when persisting it.
-- Idempotent (rule_009): safe to re-run on databases that already have it.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ac_brand TEXT;
