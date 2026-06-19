-- KPI Targets table for monthly sales targets
-- 2026-06-04
CREATE TABLE IF NOT EXISTS kpi_targets (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period        TEXT NOT NULL,           -- "2026-06"
    target_type   TEXT NOT NULL CHECK (target_type IN ('signing','collection')),
    target_amount NUMERIC(12,2) NOT NULL,
    assigned_to   UUID REFERENCES profiles(id),
    notes         TEXT,
    set_by        UUID REFERENCES profiles(id),
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now(),
    UNIQUE(period, target_type, assigned_to)
);

ALTER TABLE kpi_targets ENABLE ROW LEVEL SECURITY;

-- Admin/boss can do everything
DROP POLICY IF EXISTS "kpi_admin_all" ON kpi_targets;
CREATE POLICY "kpi_admin_all" ON kpi_targets FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- Sales can read their own targets
DROP POLICY IF EXISTS "kpi_sales_read_own" ON kpi_targets;
CREATE POLICY "kpi_sales_read_own" ON kpi_targets FOR SELECT
  USING (assigned_to = auth.uid() OR assigned_to IS NULL);

-- Also create index for dashboard performance
CREATE INDEX IF NOT EXISTS idx_kpi_targets_period ON kpi_targets(period);
