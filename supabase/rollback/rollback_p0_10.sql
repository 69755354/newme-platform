-- P0-10 回滚脚本（仅在 migration 失败时使用）
-- 警告：回滚不会删除已回填的数据，只删除 trigger 和函数

-- 1. 删除新 trigger
DROP TRIGGER IF EXISTS trg_sync_lead_from_tasks ON tasks;
DROP TRIGGER IF EXISTS trg_sync_task_from_lead ON leads;

-- 2. 删除新函数
DROP FUNCTION IF EXISTS sync_lead_next_followup();
DROP FUNCTION IF EXISTS sync_task_from_lead();

-- 3. 删除部分唯一索引
DROP INDEX IF EXISTS idx_tasks_lead_system_pending;

-- 4. 恢复原始 auto_create_task_from_followup（写死 24h，SECURITY DEFINER）
-- 从 20260623020002_crm_v3_leads_extensions.sql 恢复
CREATE OR REPLACE FUNCTION auto_create_task_from_followup()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF NEW.next_action IS NOT NULL AND NEW.next_action != '' THEN
    INSERT INTO tasks (lead_id, title, assignee_id, due_at, source)
    VALUES (NEW.lead_id, NEW.next_action, NEW.user_id, now() + interval '24 hours', 'follow_up');
  END IF;
  RETURN NEW;
END;
$$;

-- 5. 不删除 follow_up_logs.next_followup_date 列（可能已有数据）
-- 不删除回填的 tasks（可能已被用户使用）

-- 6. 通知：回滚后 leads.next_followup_date 不再与 tasks 同步，需手动维护
