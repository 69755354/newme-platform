-- N2: Add created_by field to leads table (for display only)
ALTER TABLE leads ADD COLUMN created_by UUID REFERENCES profiles(id);
CREATE INDEX idx_leads_created_by ON leads(created_by);

COMMENT ON COLUMN leads.created_by IS 'User who created this lead (for display only)';
