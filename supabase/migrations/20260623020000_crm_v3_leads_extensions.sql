-- 20260623020000_crm_v3_leads_extensions.sql
-- leads 表扩展 + 里程碑函数/触发器

-- 新增列
ALTER TABLE leads ADD COLUMN IF NOT EXISTS current_milestone TEXT DEFAULT 'new';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS final_status TEXT DEFAULT NULL;

-- milestone_order 函数
CREATE OR REPLACE FUNCTION milestone_order(milestone TEXT)
RETURNS INTEGER AS $$
BEGIN
  RETURN CASE milestone
    WHEN 'new' THEN 0 WHEN 'first_contact' THEN 1
    WHEN 'basic_info' THEN 2 WHEN 'drawings' THEN 3
    WHEN 'requirements' THEN 4 WHEN 'solution' THEN 5
    WHEN 'quotation' THEN 6 WHEN 'meeting' THEN 7
    WHEN 'negotiation' THEN 8 ELSE 99
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 里程碑顺序校验触发器 (rule_006)
CREATE OR REPLACE FUNCTION check_milestone_order()
RETURNS TRIGGER AS $$
DECLARE
  last_key TEXT;
BEGIN
  SELECT milestone_key INTO last_key
  FROM lead_milestones WHERE lead_id = NEW.lead_id
  ORDER BY completed_at DESC LIMIT 1;
  IF last_key IS NOT NULL THEN
    IF milestone_order(NEW.milestone_key) <= milestone_order(last_key) THEN
      RAISE EXCEPTION 'Cannot go backwards: % -> %', last_key, NEW.milestone_key;
    END IF;
    IF milestone_order(NEW.milestone_key) > milestone_order(last_key) + 1 THEN
      RAISE EXCEPTION 'Cannot skip: % -> %', last_key, NEW.milestone_key;
    END IF;
  END IF;
  UPDATE leads SET current_milestone = NEW.milestone_key WHERE id = NEW.lead_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_check_milestone_order ON lead_milestones;
CREATE TRIGGER trg_check_milestone_order
  BEFORE INSERT ON lead_milestones
  FOR EACH ROW EXECUTE FUNCTION check_milestone_order();

-- follow-up auto-create task 触发器 (rule_016)
CREATE OR REPLACE FUNCTION auto_create_task_from_followup()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.next_action IS NOT NULL AND NEW.next_action != '' THEN
    INSERT INTO tasks (lead_id, title, assignee_id, due_at, source)
    VALUES (NEW.lead_id, NEW.next_action, NEW.user_id, now() + interval '24 hours', 'follow_up');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_auto_create_task ON follow_up_logs;
CREATE TRIGGER trg_auto_create_task
  AFTER INSERT ON follow_up_logs
  FOR EACH ROW
  WHEN (NEW.next_action IS NOT NULL AND NEW.next_action != '')
  EXECUTE FUNCTION auto_create_task_from_followup();
