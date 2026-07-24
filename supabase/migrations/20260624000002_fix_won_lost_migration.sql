-- 20260624000002_fix_won_lost_migration.sql
-- P5: won/lost migration 补全
-- 补历史数据：won/lost 的 final_status + 里程碑 + current_milestone
-- 幂等：NOT EXISTS + WHERE final_status IS NULL


-- ═══════════════════════════════════════════════
-- 1. final_status
-- ═══════════════════════════════════════════════

-- 补 won 的 final_status（幂等：仅补 NULL 的）
UPDATE leads SET final_status = 'won'
WHERE stage = 'won' AND final_status IS NULL;

-- 补 lost 的 final_status（幂等）
UPDATE leads SET final_status = 'lost'
WHERE stage = 'lost' AND final_status IS NULL;

-- ═══════════════════════════════════════════════
-- 2. Won 线索里程碑（补全 7 步）
-- ═══════════════════════════════════════════════

INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'first_contact', NULL, 'auto-migrated from stage=won'
FROM leads l
WHERE l.stage = 'won'
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'first_contact'
  );

INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'basic_info', NULL, 'auto-migrated from stage=won'
FROM leads l
WHERE l.stage = 'won'
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'basic_info'
  );

INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'drawings', NULL, 'auto-migrated from stage=won'
FROM leads l
WHERE l.stage = 'won'
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'drawings'
  );

INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'requirements', NULL, 'auto-migrated from stage=won'
FROM leads l
WHERE l.stage = 'won'
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'requirements'
  );

INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'solution', NULL, 'auto-migrated from stage=won'
FROM leads l
WHERE l.stage = 'won'
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'solution'
  );

INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'quotation', NULL, 'auto-migrated from stage=won'
FROM leads l
WHERE l.stage = 'won'
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'quotation'
  );

INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'meeting', NULL, 'auto-migrated from stage=won'
FROM leads l
WHERE l.stage = 'won'
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'meeting'
  );

-- ═══════════════════════════════════════════════
-- 3. Lost 线索里程碑（按旧 stage 映射）
-- ═══════════════════════════════════════════════

-- first_contact for lost leads at early stages
INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'first_contact', NULL, 'auto-migrated from stage=' || l.stage
FROM leads l
WHERE l.stage = 'lost'
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'first_contact'
  );

-- ═══════════════════════════════════════════════
-- 4. 更新 current_milestone
-- ═══════════════════════════════════════════════

-- Won leads: 最高过程态为 meeting
UPDATE leads SET current_milestone = 'meeting'
WHERE stage = 'won' AND current_milestone IS DISTINCT FROM 'meeting';

-- 其他 leads（含 lost）：按已有 milestone 的最大 completed_at 更新
UPDATE leads l SET current_milestone = sub.max_milestone
FROM (
  SELECT lm.lead_id, lm.milestone_key as max_milestone
  FROM lead_milestones lm
  WHERE lm.lead_id IN (SELECT id FROM leads WHERE stage IN ('won', 'lost'))
    AND lm.completed_at = (
      SELECT MAX(completed_at) FROM lead_milestones lm2
      WHERE lm2.lead_id = lm.lead_id
    )
) sub
WHERE l.id = sub.lead_id AND l.current_milestone IS DISTINCT FROM sub.max_milestone;

-- ═══════════════════════════════════════════════
-- 5. CHECK 约束（NOT VALID——不校验已有行）
-- ═══════════════════════════════════════════════

ALTER TABLE lead_milestones ADD CONSTRAINT milestone_key_valid
  CHECK (milestone_key IN (
    'first_contact','basic_info','drawings','requirements',
    'solution','quotation','meeting'
  )) NOT VALID;

-- ═══════════════════════════════════════════════
-- 6. 验证
-- ═══════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM leads
    WHERE stage IN ('won', 'lost') AND final_status IS NULL
  ) THEN
    RAISE EXCEPTION 'P5 migration incomplete: won/lost leads still missing final_status';
  END IF;

  IF EXISTS (
    SELECT 1 FROM leads l
    WHERE l.stage = 'won'
      AND NOT EXISTS (
        SELECT 1 FROM lead_milestones lm
        WHERE lm.lead_id = l.id AND lm.milestone_key = 'meeting'
      )
  ) THEN
    RAISE EXCEPTION 'P5 migration incomplete: won leads missing meeting milestone';
  END IF;
END;
$$;
