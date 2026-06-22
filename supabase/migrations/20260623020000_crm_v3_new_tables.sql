-- 20260623020000_crm_v3_new_tables.sql
-- CRM v3 Phase A Epic 1: 6 张新表创建
-- rule_009: 幂等 (IF NOT EXISTS)
-- rule_003: 所有 FK → profiles.id

-- 1. lead_milestones
CREATE TABLE IF NOT EXISTS lead_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  milestone_key TEXT NOT NULL,
  completed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(lead_id, milestone_key)
);
CREATE INDEX IF NOT EXISTS idx_lead_milestones_lead ON lead_milestones(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_milestones_completed ON lead_milestones(completed_at DESC);

-- 2. follow_up_logs (rule_001: immutable)
CREATE TABLE IF NOT EXISTS follow_up_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  contact_type TEXT NOT NULL DEFAULT 'phone',
  summary TEXT NOT NULL DEFAULT '',
  result TEXT,
  no_answer BOOLEAN NOT NULL DEFAULT false,
  next_action TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_follow_up_logs_lead ON follow_up_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_logs_created ON follow_up_logs(created_at DESC);

-- 3. tasks (rule_002: future only)
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  assignee_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  source TEXT DEFAULT 'manual' CHECK (source IN ('manual','follow_up','cron','system')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_future_only CHECK (due_at > now())
);
CREATE INDEX IF NOT EXISTS idx_tasks_lead ON tasks(lead_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at) WHERE status = 'pending';

-- 4. lead_documents
CREATE TABLE IF NOT EXISTS lead_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size BIGINT,
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_documents_lead ON lead_documents(lead_id);

-- 5. user_features (rule_012: feature flag per user)
CREATE TABLE IF NOT EXISTS user_features (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key)
);

-- 6. crm_daily_funnel_snapshot
CREATE TABLE IF NOT EXISTS crm_daily_funnel_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  current_milestone TEXT NOT NULL,
  lead_count INTEGER NOT NULL DEFAULT 0,
  total_value NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(snapshot_date, current_milestone)
);
