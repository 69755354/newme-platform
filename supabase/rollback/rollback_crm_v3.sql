-- ================================================
-- CRM v3 — Rollback Script
-- 按 4 → 3 → 2 → 1 逆序回退
-- 执行: curl -X POST ... -d '{"query":"..."}'
-- ================================================

-- ── Rollback 4: no_answer_flag ────────────────
DROP INDEX IF EXISTS idx_leads_no_answer_flag;
ALTER TABLE leads DROP COLUMN IF EXISTS no_answer_flag;

-- ── Rollback 3: RLS Policies ──────────────────
-- follow_up_logs
DROP POLICY IF EXISTS follow_up_logs_no_delete ON follow_up_logs;
DROP POLICY IF EXISTS follow_up_logs_no_update ON follow_up_logs;
DROP POLICY IF EXISTS follow_up_logs_select ON follow_up_logs;
DROP POLICY IF EXISTS follow_up_logs_insert ON follow_up_logs;
ALTER TABLE follow_up_logs DISABLE ROW LEVEL SECURITY;

-- tasks
DROP POLICY IF EXISTS tasks_admin ON tasks;
DROP POLICY IF EXISTS tasks_own ON tasks;
ALTER TABLE tasks DISABLE ROW LEVEL SECURITY;

-- lead_milestones
DROP POLICY IF EXISTS lead_milestones_admin ON lead_milestones;
DROP POLICY IF EXISTS lead_milestones_own ON lead_milestones;
ALTER TABLE lead_milestones DISABLE ROW LEVEL SECURITY;

-- lead_documents
DROP POLICY IF EXISTS lead_documents_admin ON lead_documents;
DROP POLICY IF EXISTS lead_documents_own ON lead_documents;
ALTER TABLE lead_documents DISABLE ROW LEVEL SECURITY;

-- user_features
DROP POLICY IF EXISTS user_features_admin ON user_features;
DROP POLICY IF EXISTS user_features_own ON user_features;
ALTER TABLE user_features DISABLE ROW LEVEL SECURITY;

-- crm_daily_funnel_snapshot
DROP POLICY IF EXISTS crm_daily_funnel_snapshot_admin ON crm_daily_funnel_snapshot;
ALTER TABLE crm_daily_funnel_snapshot DISABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS apply_standard_rls;

-- ── Rollback 2: leads_extensions + functions + triggers ──
DROP TRIGGER IF EXISTS trg_auto_create_task ON follow_up_logs;
DROP TRIGGER IF EXISTS trg_check_milestone_order ON lead_milestones;
DROP FUNCTION IF EXISTS auto_create_task_from_followup;
DROP FUNCTION IF EXISTS check_milestone_order;
DROP FUNCTION IF EXISTS milestone_order;

ALTER TABLE leads DROP COLUMN IF EXISTS final_status;
ALTER TABLE leads DROP COLUMN IF EXISTS current_milestone;

-- ── Rollback 1: 6 new tables ──────────────────────────────
DROP TABLE IF EXISTS crm_daily_funnel_snapshot;
DROP TABLE IF EXISTS user_features;
DROP TABLE IF EXISTS lead_documents;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS follow_up_logs;
DROP TABLE IF EXISTS lead_milestones;
