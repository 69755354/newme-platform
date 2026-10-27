-- P0-10 Migration #3: sync_task_from_lead (leads.next_followup_date → tasks)
-- 功能：leads.next_followup_date 变更时，UPSERT system source 的 pending task
-- 循环防护：pg_trigger_depth() > 1 时返回
-- 变化检测：OLD.next_followup_date IS NOT DISTINCT FROM NEW.next_followup_date 时返回

CREATE OR REPLACE FUNCTION sync_task_from_lead()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF OLD.next_followup_date IS NOT DISTINCT FROM NEW.next_followup_date THEN
    RETURN NEW;
  END IF;
  
  IF NEW.next_followup_date IS NULL THEN
    UPDATE tasks SET status = 'cancelled', completed_at = now()
    WHERE lead_id = NEW.id AND status = 'pending' AND source = 'system';
    RETURN NEW;
  END IF;
  
  INSERT INTO tasks (lead_id, title, assignee_id, due_at, source)
  VALUES (NEW.id, 'Follow up', NEW.assigned_to, NEW.next_followup_date, 'system')
  ON CONFLICT (lead_id) WHERE source = 'system' AND status = 'pending'
  DO UPDATE SET due_at = EXCLUDED.due_at, assignee_id = EXCLUDED.assignee_id;
  
  RETURN NEW;
END;
$$;

-- 部分唯一索引：每个 lead 最多一条 system source 的 pending task
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_lead_system_pending 
  ON tasks(lead_id) 
  WHERE source = 'system' AND status = 'pending';

DROP TRIGGER IF EXISTS trg_sync_task_from_lead ON leads;
CREATE TRIGGER trg_sync_task_from_lead
  AFTER UPDATE OF next_followup_date ON leads
  FOR EACH ROW
  EXECUTE FUNCTION sync_task_from_lead();

COMMENT ON FUNCTION sync_task_from_lead() IS 'leads.next_followup_date 变更时同步 tasks。循环防护：pg_trigger_depth() > 1。变化检测：OLD IS NOT DISTINCT FROM NEW。蒸馏友好：无 SECURITY DEFINER。';
