-- 20260623020000_crm_v3_rls_policies.sql
-- RLS 策略 — 每张新表 × 2 策略（own + admin）
-- rule_101: 无全局绕过

-- Function to apply standard RLS
CREATE OR REPLACE FUNCTION apply_standard_rls(table_name TEXT)
RETURNS void AS $$
DECLARE
  own_policy TEXT;
  admin_policy TEXT;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', table_name);
  -- own policy
  EXECUTE format($p$DROP POLICY IF EXISTS %I ON %I;$p$, table_name || '_own', table_name);
  EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL USING (
    lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
  );$p$, table_name || '_own', table_name);
  -- admin policy
  EXECUTE format($p$DROP POLICY IF EXISTS %I ON %I;$p$, table_name || '_admin', table_name);
  EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))
  );$p$, table_name || '_admin', table_name);
END;
$$ LANGUAGE plpgsql;

-- lead_milestones
ALTER TABLE lead_milestones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_milestones_own ON lead_milestones;
CREATE POLICY lead_milestones_own ON lead_milestones
  FOR ALL USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));
DROP POLICY IF EXISTS lead_milestones_admin ON lead_milestones;
CREATE POLICY lead_milestones_admin ON lead_milestones
  FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- follow_up_logs (rule_001: only INSERT + SELECT)
ALTER TABLE follow_up_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS follow_up_logs_insert ON follow_up_logs;
CREATE POLICY follow_up_logs_insert ON follow_up_logs
  FOR INSERT WITH CHECK (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
DROP POLICY IF EXISTS follow_up_logs_select ON follow_up_logs;
CREATE POLICY follow_up_logs_select ON follow_up_logs
  FOR SELECT USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
DROP POLICY IF EXISTS follow_up_logs_no_update ON follow_up_logs;
CREATE POLICY follow_up_logs_no_update ON follow_up_logs FOR UPDATE USING (false);
DROP POLICY IF EXISTS follow_up_logs_no_delete ON follow_up_logs;
CREATE POLICY follow_up_logs_no_delete ON follow_up_logs FOR DELETE USING (false);

-- tasks
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_own ON tasks;
CREATE POLICY tasks_own ON tasks
  FOR ALL USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));
DROP POLICY IF EXISTS tasks_admin ON tasks;
CREATE POLICY tasks_admin ON tasks
  FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- lead_documents
ALTER TABLE lead_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_documents_own ON lead_documents;
CREATE POLICY lead_documents_own ON lead_documents
  FOR ALL USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));
DROP POLICY IF EXISTS lead_documents_admin ON lead_documents;
CREATE POLICY lead_documents_admin ON lead_documents
  FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- user_features
ALTER TABLE user_features ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_features_own ON user_features;
CREATE POLICY user_features_own ON user_features FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS user_features_admin ON user_features;
CREATE POLICY user_features_admin ON user_features
  FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- crm_daily_funnel_snapshot
ALTER TABLE crm_daily_funnel_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_daily_funnel_snapshot_admin ON crm_daily_funnel_snapshot;
CREATE POLICY crm_daily_funnel_snapshot_admin ON crm_daily_funnel_snapshot
  FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
