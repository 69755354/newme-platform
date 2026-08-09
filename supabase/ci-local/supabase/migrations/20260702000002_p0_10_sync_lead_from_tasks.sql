-- P0-10 Migration #2: sync_lead_next_followup (tasks → leads)
-- 功能：tasks 表 INSERT/UPDATE/DELETE 时，同步 leads.next_followup_date = MIN(tasks.due_at WHERE pending)
-- 循环防护：pg_trigger_depth() > 1 时返回

CREATE OR REPLACE FUNCTION sync_lead_next_followup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_lead_id UUID;
  v_new_min TIMESTAMPTZ;
  v_current TIMESTAMPTZ;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_lead_id := COALESCE(NEW.lead_id, OLD.lead_id);
  
  SELECT MIN(due_at) INTO v_new_min
  FROM tasks WHERE lead_id = v_lead_id AND status = 'pending';
  
  SELECT next_followup_date INTO v_current
  FROM leads WHERE id = v_lead_id;
  
  IF v_new_min IS NOT DISTINCT FROM v_current THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  
  UPDATE leads SET next_followup_date = v_new_min WHERE id = v_lead_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_lead_from_tasks ON tasks;
CREATE TRIGGER trg_sync_lead_from_tasks
  AFTER INSERT OR UPDATE OR DELETE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION sync_lead_next_followup();

COMMENT ON FUNCTION sync_lead_next_followup() IS 'tasks 变更时同步 leads.next_followup_date。循环防护：pg_trigger_depth() > 1 时返回。蒸馏友好：无 SECURITY DEFINER。';
