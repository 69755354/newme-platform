-- 20260623021000_add_no_answer_flag.sql
-- CRM v3 Epic 4: no_answer_flag on leads for No Answer detection
-- rule_009: 幂等

ALTER TABLE leads ADD COLUMN IF NOT EXISTS no_answer_flag BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_leads_no_answer_flag ON leads(no_answer_flag)
  WHERE no_answer_flag = true;
