-- P0-10 Migration #1: 修复 auto_create_task_from_followup
-- 修复 1: due_at 从 NEW.next_followup_date 读取（不再写死 24h）
-- 修复 2: 去掉 SECURITY DEFINER（蒸馏友好）
-- 修复 3: 加 RAISE NOTICE 日志（避免 ON CONFLICT DO NOTHING 吞错误）

CREATE OR REPLACE FUNCTION auto_create_task_from_followup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.next_action IS NOT NULL AND NEW.next_action != '' THEN
    INSERT INTO tasks (lead_id, title, assignee_id, due_at, source)
    VALUES (
      NEW.lead_id, 
      NEW.next_action, 
      NEW.user_id, 
      COALESCE(NEW.next_followup_date, now() + interval '24 hours'),
      'follow_up'
    )
    ON CONFLICT DO NOTHING;
    
    IF NOT FOUND THEN
      RAISE NOTICE 'auto_create_task: skipped duplicate for lead_id=%, title=%', NEW.lead_id, NEW.next_action;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION auto_create_task_from_followup() IS '从 follow_up_log 自动创建 task。due_at 优先读 next_followup_date，否则默认 24h 后。蒸馏友好：无 SECURITY DEFINER。';
