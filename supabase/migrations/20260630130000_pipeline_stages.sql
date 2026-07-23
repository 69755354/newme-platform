-- =============================================================================
-- Pipeline Stages — Reference/lookup table for lead sales pipeline stages
-- Defines the canonical stage list (new → contacted → … → won/lost)
-- =============================================================================

-- 1. Create pipeline_stages table (if not already present)
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  is_terminal BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Index on order_index (R7: idx_表名_列名)
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_order_index
  ON pipeline_stages(order_index);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_stages_name
  ON pipeline_stages(name);

-- 3. Enable RLS
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies (naming: policy_表名_操作_角色)
--    Per coding standards §5: no FOR ALL, explicit per-operation policies

DROP POLICY IF EXISTS policy_pipeline_stages_select_admin ON pipeline_stages;
DROP POLICY IF EXISTS policy_pipeline_stages_select_manager ON pipeline_stages;
DROP POLICY IF EXISTS policy_pipeline_stages_select_sales ON pipeline_stages;
DROP POLICY IF EXISTS policy_pipeline_stages_insert_admin ON pipeline_stages;
DROP POLICY IF EXISTS policy_pipeline_stages_update_admin ON pipeline_stages;
DROP POLICY IF EXISTS policy_pipeline_stages_delete_admin ON pipeline_stages;

-- SELECT: admin, boss, operator, finance and sales can read pipeline stage definitions
CREATE POLICY policy_pipeline_stages_select_admin
  ON pipeline_stages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

CREATE POLICY policy_pipeline_stages_select_sales
  ON pipeline_stages FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales'));

-- INSERT: admin only
CREATE POLICY policy_pipeline_stages_insert_admin
  ON pipeline_stages FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- UPDATE: admin only
CREATE POLICY policy_pipeline_stages_update_admin
  ON pipeline_stages FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- DELETE: admin only
CREATE POLICY policy_pipeline_stages_delete_admin
  ON pipeline_stages FOR DELETE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- 5. Seed default pipeline stages
--    Stages match leads.stage CHECK constraint values
--    won/lost are terminal stages (is_terminal = true)
INSERT INTO pipeline_stages (name, order_index, is_terminal) VALUES
  ('new',             1, false),
  ('contacted',       2, false),
  ('needs_analysis',  3, false),
  ('quoted',          4, false),
  ('negotiating',     5, false),
  ('won',             6, true),
  ('lost',            7, true)
ON CONFLICT (name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
