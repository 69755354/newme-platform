-- CRM v2 schema migration for NewMe business platform
-- Based on ChatGPT recommendations + user feedback (2026-06-02)

-- Funnel & status
ALTER TABLE leads ADD COLUMN IF NOT EXISTS funnel_stage TEXT DEFAULT 'new';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_status TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS win_probability INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage_changed_at TIMESTAMPTZ;

-- Decision info
ALTER TABLE leads ADD COLUMN IF NOT EXISTS decision_maker TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS decision_date DATE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS competitor TEXT;

-- Follow-up
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contact_date DATE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_followup_date DATE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_count INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action TEXT;

-- Disqualified
ALTER TABLE leads ADD COLUMN IF NOT EXISTS disqualified_candidate BOOLEAN DEFAULT false;

-- Manager oversight
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales_manager_review BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS recovery_candidate BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS transfer_candidate BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS hold_since DATE;

-- Migration tracking
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_sheets_row_id TEXT;
