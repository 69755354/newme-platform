-- P0-10 Migration #0: follow_up_logs 加 next_followup_date 列
-- 背景：现有 auto_create_task trigger 写死 due_at = now()+24h，因为 follow_up_logs 没有 next_followup_date 列
-- 修复：加列 + 分批回填历史数据（避免大表阻塞）

-- 加列
ALTER TABLE follow_up_logs 
  ADD COLUMN IF NOT EXISTS next_followup_date TIMESTAMPTZ;

COMMENT ON COLUMN follow_up_logs.next_followup_date IS '下次跟进日期（从 leads 同步），用于 auto_create_task trigger 读取';

-- 分批回填
DO $$
DECLARE
  v_batch_size INT := 500;
  v_count INT;
  v_total INT := 0;
BEGIN
  LOOP
    WITH cte AS (
      SELECT f.id, l.next_followup_date
      FROM follow_up_logs f
      JOIN leads l ON f.lead_id = l.id
      WHERE l.next_followup_date IS NOT NULL
        AND f.next_followup_date IS NULL
      LIMIT v_batch_size
    )
    UPDATE follow_up_logs f
    SET next_followup_date = cte.next_followup_date
    FROM cte
    WHERE f.id = cte.id;
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_total := v_total + v_count;
    RAISE NOTICE 'Backfill batch: % rows, total: %', v_count, v_total;
    EXIT WHEN v_count < v_batch_size;
    PERFORM pg_sleep(0.1);
  END LOOP;
  RAISE NOTICE 'Backfill complete: % total rows updated', v_total;
END $$;
