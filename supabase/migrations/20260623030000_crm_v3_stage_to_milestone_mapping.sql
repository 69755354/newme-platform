ALTER TABLE leads ADD COLUMN IF NOT EXISTS final_status TEXT;

CREATE TABLE IF NOT EXISTS lead_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  milestone_key TEXT NOT NULL,
  completed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, milestone_key)
);
ALTER TABLE lead_milestones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS policy_lead_milestones_select_sales ON lead_milestones;
DROP POLICY IF EXISTS policy_lead_milestones_select_admin ON lead_milestones;
DROP POLICY IF EXISTS policy_lead_milestones_insert_sales ON lead_milestones;
DROP POLICY IF EXISTS policy_lead_milestones_insert_admin ON lead_milestones;
DROP POLICY IF EXISTS policy_lead_milestones_update_sales ON lead_milestones;
DROP POLICY IF EXISTS policy_lead_milestones_update_admin ON lead_milestones;
CREATE POLICY policy_lead_milestones_select_sales ON lead_milestones FOR SELECT USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));
CREATE POLICY policy_lead_milestones_select_admin ON lead_milestones FOR SELECT USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
CREATE POLICY policy_lead_milestones_insert_sales ON lead_milestones FOR INSERT WITH CHECK (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));
CREATE POLICY policy_lead_milestones_insert_admin ON lead_milestones FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
CREATE POLICY policy_lead_milestones_update_sales ON lead_milestones FOR UPDATE USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));
CREATE POLICY policy_lead_milestones_update_admin ON lead_milestones FOR UPDATE USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- 20260623030000_crm_v3_stage_to_milestone_mapping.sql
-- CRM v3: 旧stage → Milestone 数据映射
-- 将生产已有lead的旧stage字段映射到新的lead_milestones表
-- 幂等: INSERT WHERE NOT EXISTS
-- 执行方式: 每次一篇SQL，通过 Management API 单条执行
-- 已在 prod 2026-06-23 执行验证通过

-- 1. first_contact (contacted, no_answered, fake → 无响应/首次联系)
INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'first_contact', NULL, 'auto-migrated from stage=' || l.stage
FROM leads l
WHERE l.stage IN ('contacted','no_answered','fake')
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'first_contact'
  );

-- 2. basic_info (requirement_confirmed+ → 已完成基础信息收集)
INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'basic_info', NULL, 'auto-migrated from stage=' || l.stage
FROM leads l
WHERE l.stage IN ('requirement_confirmed','quotation_submitted','negotiation')
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'basic_info'
  );

-- 3. drawings (已收集图纸)
INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'drawings', NULL, 'auto-migrated from stage=' || l.stage
FROM leads l
WHERE l.stage IN ('requirement_confirmed','quotation_submitted','negotiation')
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'drawings'
  );

-- 4. requirements (已确认需求)
INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'requirements', NULL, 'auto-migrated from stage=' || l.stage
FROM leads l
WHERE l.stage IN ('requirement_confirmed','quotation_submitted','negotiation')
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'requirements'
  );

-- 5. solution (已出方案)
INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'solution', NULL, 'auto-migrated from stage=' || l.stage
FROM leads l
WHERE l.stage IN ('quotation_submitted','negotiation')
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'solution'
  );

-- 6. quotation (已报价)
INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'quotation', NULL, 'auto-migrated from stage=' || l.stage
FROM leads l
WHERE l.stage IN ('quotation_submitted','negotiation')
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'quotation'
  );

-- 7. meeting (已面谈)
INSERT INTO lead_milestones (lead_id, milestone_key, completed_by, notes)
SELECT l.id, 'meeting', NULL, 'auto-migrated from stage=' || l.stage
FROM leads l
WHERE l.stage = 'negotiation'
  AND NOT EXISTS (
    SELECT 1 FROM lead_milestones lm
    WHERE lm.lead_id = l.id AND lm.milestone_key = 'meeting'
  );

-- 8. final_status for lost leads
UPDATE leads SET final_status = 'lost'
WHERE stage = 'lost' AND final_status IS NULL;

-- 9. Update current_milestone for migrated leads
UPDATE leads l SET current_milestone = sub.max_milestone
FROM (
  SELECT lm.lead_id, lm.milestone_key as max_milestone
  FROM lead_milestones lm
  WHERE lm.lead_id IN (SELECT id FROM leads WHERE stage != 'new')
    AND lm.completed_at = (
      SELECT MAX(completed_at) FROM lead_milestones lm2
      WHERE lm2.lead_id = lm.lead_id
    )
) sub
WHERE l.id = sub.lead_id AND l.current_milestone = 'new';

-- 验证: 不应有遗漏
-- SELECT stage, COUNT(*) as missing
-- FROM leads l
-- WHERE l.stage NOT IN ('new','lost')
--   AND NOT EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id)
-- GROUP BY stage;
-- 期望: 0行

-- 验证: new阶段lead不应有milestone
-- SELECT COUNT(*) as new_with_milestones
-- FROM leads l
-- WHERE l.stage = 'new'
--   AND EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id);
-- 期望: 0
