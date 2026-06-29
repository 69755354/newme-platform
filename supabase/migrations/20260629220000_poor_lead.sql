ALTER TABLE leads ADD COLUMN IF NOT EXISTS poor_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_quality ON leads(quality);
