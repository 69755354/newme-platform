-- P0-10 Migration #1: 修复 auto_create_task_from_followup
-- 修复 1: due_at 从 NEW.next_followup_date 读取（不再写死 24h）
-- 修复 2: 去掉 SECURITY DEFINER（蒸馏友好）
-- 修复 3: ON CONFLICT 改为 DO UPDATE，只处理重复插入（不吞掉约束违反）

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
    ON CONFLICT (lead_id) WHERE source = 'follow_up' AND status = 'pending'
    DO UPDATE SET due_at = EXCLUDED.due_at, title = EXCLUDED.title;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION auto_create_task_from_followup() IS '从 follow_up_log 自动创建 task。due_at 优先读 next_followup_date，否则默认 24h 后。ON CONFLICT 只处理重复插入，约束违反会报错。蒸馏友好：无 SECURITY DEFINER。';
