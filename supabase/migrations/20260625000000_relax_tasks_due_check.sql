-- 20260625000000_relax_tasks_due_check.sql
-- P0-7 Tasks 最小安全补丁：放宽 tasks_future_only，让 "今天" 可选（不被 CHECK 卡死）
--
-- 背景：原约束 CHECK (due_at > now()) 要求 due_at 严格在未来。但应用端 next_followup_date
-- 以 YYYY-MM-DD 形式写入（按 UTC 00:00 解释），"今天" 到了下午就已是过去时 → 插入失败。
-- 这导致 Lead Detail 设 follow-up / Quick Create 建 lead 时 task 写不进去（"被 CHECK 卡死"）。
--
-- 修复：放宽为 24h 宽限，CHECK (due_at > now() - interval '1 day')。
--   - "今天" 永远满足（最多比 now 早不到 24h）
--   - 明确的历史日期（昨天及更早）仍被拒绝，保留 "不可严重回填" 的语义
-- 幂等：DROP IF EXISTS + 守卫 ADD（标准 Postgres 无 ADD CONSTRAINT IF NOT EXISTS）。

DO $$
BEGIN
  IF to_regclass('public.tasks') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tasks_future_only'
      AND table_name = 'tasks'
      AND table_schema = current_schema()
  ) THEN
    ALTER TABLE tasks DROP CONSTRAINT tasks_future_only;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.tasks') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tasks_future_only'
      AND table_name = 'tasks'
      AND table_schema = current_schema()
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_future_only CHECK (due_at > now() - interval '1 day');
  END IF;
END $$;
