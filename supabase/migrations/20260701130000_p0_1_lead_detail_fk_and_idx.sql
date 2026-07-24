-- 20260701130000_p0_1_lead_detail_fk_and_idx.sql
-- P0-1 性能优化：补缺失 FK 与索引
-- 配合 TASKBOARD P0-1 方案文档 §4：leads/[id] 详情页 embed JOIN 优化
-- 命名遵循：FK = fk_<table>_<col>（PostgREST embed hint 友好）
--         IDX = idx_<table>_<col(s)>

-- =========================================================================
-- A. 缺失的物理外键（子表 → profiles）
-- =========================================================================

-- A.1 follow_up_logs.user_id → profiles.id
-- 当前 DB 已有 follow_up_logs_user_id_fkey（默认命名），
-- 这里 alias 一份 fk_follow_up_logs_user_id 便于 PostgREST embed hint
ALTER TABLE follow_up_logs
  DROP CONSTRAINT IF EXISTS fk_follow_up_logs_user_id;
ALTER TABLE follow_up_logs
  ADD CONSTRAINT fk_follow_up_logs_user_id
  FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- A.2 follow_up_logs.created_by 已有 fk_follow_up_logs_created_by，跳过

-- A.3 lead_milestones.completed_by → profiles.id
ALTER TABLE lead_milestones
  DROP CONSTRAINT IF EXISTS fk_lead_milestones_completed_by;
ALTER TABLE lead_milestones
  ADD CONSTRAINT fk_lead_milestones_completed_by
  FOREIGN KEY (completed_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- A.4 business_events.lead_id 已有 business_events_lead_id_fkey，跳过
-- A.5 business_events.user_id 已有 fk_business_events_user_id，跳过

-- A.6 chat_messages.lead_id 已有 chat_messages_lead_id_fkey，跳过
-- A.7 chat_messages 无 user_id 列（实测），跳过

-- A.8 tasks.lead_id 已有 tasks_lead_id_fkey，跳过
-- A.9 tasks.assignee_id → profiles.id（缺则补）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'tasks'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name LIKE '%assignee_id%'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_assignee_id
      FOREIGN KEY (assignee_id) REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =========================================================================
-- B. 缺失的物理外键（→ leads / customers）
-- =========================================================================

-- B.1 leads.customer_id → customers.id
-- 注：生产 DB 已存在同名 FK `fk_leads_customer_id`（Codex 1 审 B1-1 实测），
--     用 DO $$ 包裹做幂等；不存在时新建，存在时保留原 ON DELETE 行为。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'leads'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'fk_leads_customer_id'
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT fk_leads_customer_id
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =========================================================================
-- C. 缺失的索引（覆盖 8 查询的 where 字段）
-- =========================================================================

-- C.1 follow_up_logs.lead_id
CREATE INDEX IF NOT EXISTS idx_follow_up_logs_lead_id
  ON follow_up_logs(lead_id);
-- C.2 follow_up_logs.user_id（用于子查询 / 审计）
CREATE INDEX IF NOT EXISTS idx_follow_up_logs_user_id
  ON follow_up_logs(user_id);

-- C.3 lead_milestones.lead_id
CREATE INDEX IF NOT EXISTS idx_lead_milestones_lead_id
  ON lead_milestones(lead_id);

-- C.4 business_events.lead_id + user_id
CREATE INDEX IF NOT EXISTS idx_business_events_lead_id
  ON business_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_business_events_user_id
  ON business_events(user_id);

-- C.5 chat_messages.lead_id
CREATE INDEX IF NOT EXISTS idx_chat_messages_lead_id
  ON chat_messages(lead_id);

-- C.6 tasks.lead_id + completed_at 复合索引（next_task 需 filter）
CREATE INDEX IF NOT EXISTS idx_tasks_lead_id_completed_at
  ON tasks(lead_id, completed_at);

-- C.7 v_lead_trace.lead_id（视图底层表，PostgREST 不识别视图关系；保留独立查）
-- 视图无法 CREATE INDEX；底层表索引假设已存在；不重复加。

-- C.8 profiles.role（dropdown filter）
CREATE INDEX IF NOT EXISTS idx_profiles_role
  ON profiles(role);

-- =========================================================================
-- D. NOTIFY PostgREST 刷新 schema cache（让 embed hint 立即生效）
-- =========================================================================
NOTIFY pgrst, 'reload schema';
