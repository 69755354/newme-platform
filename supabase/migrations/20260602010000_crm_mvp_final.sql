-- ================================================
-- NewMe CRM Online MVP - Final migration
-- 2026-06-02 Night Build
-- ================================================

-- ═══════════════ 1. Business Events Table ═══════════════
CREATE TABLE IF NOT EXISTS business_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID REFERENCES leads(id) ON DELETE CASCADE,
  user_id        UUID REFERENCES profiles(id),
  event_type     TEXT NOT NULL,
  -- event_type values: stage_changed, note_added, followup_scheduled,
  --   quotation_sent, lost_reason_set, manager_review_flagged,
  --   lead_created, lead_assigned, status_changed, probability_changed,
  --   recovery_flagged, transfer_flagged
  event_data     JSONB DEFAULT '{}'::jsonb,
  description    TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_events_lead    ON business_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_business_events_type    ON business_events(event_type);
CREATE INDEX IF NOT EXISTS idx_business_events_created ON business_events(created_at DESC);

-- ═══════════════ 2. Attribution & UTM Columns ═══════════════
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_platform  TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_channel   TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id      TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_name    TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS adset_id         TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS adset_name       TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ad_id            TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ad_name          TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS creative_id      TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS creative_name    TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS form_id          TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS form_name        TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_source       TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_medium       TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_campaign     TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_content      TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_term         TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS fbclid           TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gclid            TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS landing_page     TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referrer         TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_touch_at   TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_touch_at    TIMESTAMPTZ;

-- ═══════════════ 3. Lead Status constraint update ═══════════════
-- lead_status already exists as TEXT, we just ensure values match the spec
-- (Hot, Warm, Cold, Dormant - stored internally as lowercase)

-- ═══════════════ 4. Migrate old stage data to funnel_stage ═══════════════
UPDATE leads
SET funnel_stage = CASE stage
    WHEN 'needs_analysis' THEN 'requirement_confirmed'
    WHEN 'quoted'         THEN 'quotation_submitted'
    WHEN 'negotiating'    THEN 'negotiation'
    ELSE stage
  END
WHERE funnel_stage IS NULL AND stage IS NOT NULL;

-- Set default for any remaining null funnel_stage
UPDATE leads SET funnel_stage = 'new' WHERE funnel_stage IS NULL;

-- ═══════════════ 5. Add quotation_value if missing ═══════════════
-- (already exists from earlier migration, just in case)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS quotation_value DECIMAL(12,2);

-- ═══════════════ 6. Indexes for new columns ═══════════════
CREATE INDEX IF NOT EXISTS idx_leads_funnel_stage      ON leads(funnel_stage);
CREATE INDEX IF NOT EXISTS idx_leads_lead_status       ON leads(lead_status);
CREATE INDEX IF NOT EXISTS idx_leads_win_probability   ON leads(win_probability);
CREATE INDEX IF NOT EXISTS idx_leads_next_followup     ON leads(next_followup_date);
CREATE INDEX IF NOT EXISTS idx_leads_recovery          ON leads(recovery_candidate) WHERE recovery_candidate = true;
CREATE INDEX IF NOT EXISTS idx_leads_transfer          ON leads(transfer_candidate) WHERE transfer_candidate = true;
CREATE INDEX IF NOT EXISTS idx_leads_sales_review      ON leads(sales_manager_review) WHERE sales_manager_review = true;
CREATE INDEX IF NOT EXISTS idx_leads_campaign          ON leads(campaign_name);
CREATE INDEX IF NOT EXISTS idx_leads_source_platform   ON leads(source_platform);

-- ═══════════════ 7. RLS for business_events ═══════════════
ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "be_admin_all" ON business_events FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')));

CREATE POLICY "be_sales_see" ON business_events FOR SELECT
  USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

CREATE POLICY "be_sales_create" ON business_events FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- ═══════════════ 8. Helper: computed days_since_last_contact ═══════════════
CREATE OR REPLACE FUNCTION days_since_last_contact(lead_id UUID)
RETURNS INTEGER AS $$
DECLARE
  last_contact DATE;
BEGIN
  SELECT leads.last_contact_date INTO last_contact FROM leads WHERE id = lead_id;
  IF last_contact IS NULL THEN RETURN NULL; END IF;
  RETURN (CURRENT_DATE - last_contact)::INTEGER;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ═══════════════ 9. View: Yellow/Red alert leads ═══════════════
DROP VIEW IF EXISTS lead_alerts;
CREATE VIEW lead_alerts AS
SELECT
  l.id, l.customer_name, l.phone, l.funnel_stage, l.lead_status,
  l.assigned_to, l.rep_name, l.last_contact_date,
  l.next_followup_date, l.next_action, l.followup_count,
  l.win_probability, l.quotation_value,
  l.recovery_candidate, l.transfer_candidate,
  l.sales_manager_review, l.hold_since,
  CASE
    WHEN l.last_contact_date IS NULL THEN 'red'
    WHEN (CURRENT_DATE - l.last_contact_date::DATE) >= 14 THEN 'red'
    WHEN (CURRENT_DATE - l.last_contact_date::DATE) >= 7  THEN 'yellow'
    ELSE 'green'
  END AS alert_color,
  (CURRENT_DATE - l.last_contact_date::DATE) AS days_since_contact
FROM leads l
WHERE l.funnel_stage NOT IN ('won', 'lost');

-- ═══════════════ 10. View: Pipeline summary ═══════════════
CREATE OR REPLACE VIEW pipeline_summary AS
SELECT
  funnel_stage,
  COUNT(*) AS lead_count,
  COUNT(*) FILTER (WHERE lead_status = 'hot') AS hot_count,
  COUNT(*) FILTER (WHERE recovery_candidate = true) AS recovery_count,
  COUNT(*) FILTER (WHERE transfer_candidate = true) AS transfer_count,
  SUM(quotation_value) AS total_value,
  AVG(win_probability) AS avg_probability,
  SUM(quotation_value * COALESCE(win_probability, 0) / 100.0) AS weighted_value
FROM leads
WHERE funnel_stage NOT IN ('won', 'lost')
GROUP BY funnel_stage
ORDER BY array_position(ARRAY['new','contacted','requirement_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision'], funnel_stage);
