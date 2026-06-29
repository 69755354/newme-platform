-- P0-10 Migration #4: 数据回填
-- 为所有有 next_followup_date 但无 system source pending task 的 leads 创建 task
-- CHECK 约束放宽为 30 天（允许 overdue leads 回填）

DO $$
DECLARE
  v_batch_size INT := 500;
  v_count INT;
  v_total INT := 0;
BEGIN
  -- 临时放宽约束
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_future_only;
  ALTER TABLE tasks ADD CONSTRAINT tasks_future_only CHECK (due_at > now() - interval '30 days');
  
  LOOP
    WITH cte AS (
      SELECT l.id, l.assigned_to, l.next_followup_date
      FROM leads l
      WHERE l.next_followup_date IS NOT NULL
        AND l.archived = false
        AND NOT EXISTS (
          SELECT 1 FROM tasks t 
          WHERE t.lead_id = l.id AND t.status = 'pending' AND t.source = 'system'
        )
      LIMIT v_batch_size
    )
    INSERT INTO tasks (lead_id, title, assignee_id, due_at, source)
    SELECT id, 'Follow up (backfill)', assigned_to, next_followup_date, 'system'
    FROM cte;
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_total := v_total + v_count;
    RAISE NOTICE 'Backfill batch: % rows, total: %', v_count, v_total;
    EXIT WHEN v_count < v_batch_size;
    PERFORM pg_sleep(0.1);
  END LOOP;
  RAISE NOTICE 'Backfill complete: % total rows inserted', v_total;
END $$;
