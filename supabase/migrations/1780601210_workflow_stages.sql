-- =============================================================================
-- Workflow Management — 5-stage tracking embedded in Lead detail
-- =============================================================================

CREATE TABLE lead_workflow_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL
    CHECK (stage_key IN ('requirement','design','quotation','negotiation','handover')),
  stage_order INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 20
    CHECK (weight IN (20,30,50,60,80)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','skipped')),
  assigned_to UUID REFERENCES profiles(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  notified_24h BOOLEAN DEFAULT false,
  notified_48h BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (lead_id, stage_key)
);

CREATE INDEX idx_wf_lead ON lead_workflow_stages(lead_id);
CREATE INDEX idx_wf_status ON lead_workflow_stages(status);
CREATE INDEX idx_wf_deadline ON lead_workflow_stages(deadline_at)
  WHERE status IN ('pending','in_progress');
CREATE INDEX idx_wf_assigned ON lead_workflow_stages(assigned_to);

ALTER TABLE lead_workflow_stages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wf_admin_all" ON lead_workflow_stages FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

CREATE POLICY "wf_sales_select" ON lead_workflow_stages FOR SELECT
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_workflow_stages.lead_id AND l.assigned_to = auth.uid()));

CREATE POLICY "wf_sales_insert" ON lead_workflow_stages FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id AND l.assigned_to = auth.uid()));

CREATE POLICY "wf_sales_update" ON lead_workflow_stages FOR UPDATE
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_workflow_stages.lead_id AND l.assigned_to = auth.uid()));

-- Required for this legacy migration to run before the later CRM-v2 migration in a clean room.\nALTER TABLE leads ADD COLUMN IF NOT EXISTS disqualified_candidate BOOLEAN DEFAULT false;\n\n-- Seed default 5 stages for existing leads that don't have any
INSERT INTO lead_workflow_stages (lead_id, stage_key, stage_order, weight, status)
SELECT l.id, 'requirement', 1, 20, 'pending'
FROM leads l
WHERE l.stage NOT IN ('won','lost')
  AND NOT COALESCE(l.disqualified_candidate, false)
  AND NOT EXISTS (SELECT 1 FROM lead_workflow_stages w WHERE w.lead_id = l.id AND w.stage_key = 'requirement');

INSERT INTO lead_workflow_stages (lead_id, stage_key, stage_order, weight, status)
SELECT l.id, 'design', 2, 30, 'pending'
FROM leads l
WHERE l.stage NOT IN ('won','lost')
  AND NOT COALESCE(l.disqualified_candidate, false)
  AND NOT EXISTS (SELECT 1 FROM lead_workflow_stages w WHERE w.lead_id = l.id AND w.stage_key = 'design');

INSERT INTO lead_workflow_stages (lead_id, stage_key, stage_order, weight, status)
SELECT l.id, 'quotation', 3, 50, 'pending'
FROM leads l
WHERE l.stage NOT IN ('won','lost')
  AND NOT COALESCE(l.disqualified_candidate, false)
  AND NOT EXISTS (SELECT 1 FROM lead_workflow_stages w WHERE w.lead_id = l.id AND w.stage_key = 'quotation');

INSERT INTO lead_workflow_stages (lead_id, stage_key, stage_order, weight, status)
SELECT l.id, 'negotiation', 4, 60, 'pending'
FROM leads l
WHERE l.stage NOT IN ('won','lost')
  AND NOT COALESCE(l.disqualified_candidate, false)
  AND NOT EXISTS (SELECT 1 FROM lead_workflow_stages w WHERE w.lead_id = l.id AND w.stage_key = 'negotiation');

INSERT INTO lead_workflow_stages (lead_id, stage_key, stage_order, weight, status)
SELECT l.id, 'handover', 5, 80, 'pending'
FROM leads l
WHERE l.stage NOT IN ('won','lost')
  AND NOT COALESCE(l.disqualified_candidate, false)
  AND NOT EXISTS (SELECT 1 FROM lead_workflow_stages w WHERE w.lead_id = l.id AND w.stage_key = 'handover');

NOTIFY pgrst, 'reload schema';
