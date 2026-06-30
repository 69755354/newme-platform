-- 20260624000001_fix_milestone_order.sql
-- P4: milestone 跳序校准

-- 1. 更新 check_milestone_order 触发器：添加 won/lost 阻断 + 首步保护
CREATE OR REPLACE FUNCTION check_milestone_order()
RETURNS TRIGGER AS $$
DECLARE
  last_key TEXT;
  lead_status TEXT;
BEGIN
  -- 检查 lead 是否 won/lost（rule_007: won/lost 不允许继续推进里程碑）
  SELECT final_status INTO lead_status FROM leads WHERE id = NEW.lead_id;
  IF lead_status IN ('won', 'lost') THEN
    RAISE EXCEPTION 'Cannot complete milestone on won/lost lead';
  END IF;

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
  ELSE
    -- 首步保护：只允许 first_contact（order=1）作为第一个里程碑
    IF milestone_order(NEW.milestone_key) != 1 THEN
      RAISE EXCEPTION 'First milestone must be first_contact, got: %', NEW.milestone_key;
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
