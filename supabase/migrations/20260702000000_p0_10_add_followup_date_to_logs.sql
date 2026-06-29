-- P0-10 Migration #0: follow_up_logs 加 next_followup_date 列
-- 背景：现有 auto_create_task trigger 写死 due_at = now()+24h，因为 follow_up_logs 没有 next_followup_date 列
-- 修复：加列 + 回填历史数据

ALTER TABLE follow_up_logs 
  ADD COLUMN IF NOT EXISTS next_followup_date TIMESTAMPTZ;

-- 回填：每条 follow_up_log 对应的 lead 的 next_followup_date
UPDATE follow_up_logs f
SET next_followup_date = l.next_followup_date
FROM leads l
WHERE f.lead_id = l.id
  AND l.next_followup_date IS NOT NULL
  AND f.next_followup_date IS NULL;

COMMENT ON COLUMN follow_up_logs.next_followup_date IS '下次跟进日期（从 leads 同步），用于 auto_create_task trigger 读取';
