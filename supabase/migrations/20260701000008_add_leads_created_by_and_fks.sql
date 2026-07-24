-- Add created_by column and foreign keys on leads table
-- Enables native PostgREST joins for creator and assignee profiles


-- 1. Add created_by column
ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_by UUID;

-- 2. Populate existing leads: use imported_by as created_by
UPDATE leads SET created_by = imported_by WHERE created_by IS NULL AND imported_by IS NOT NULL;

-- 3. Foreign key: leads.created_by → profiles.id
ALTER TABLE leads DROP CONSTRAINT IF EXISTS fk_leads_created_by;
ALTER TABLE leads ADD CONSTRAINT fk_leads_created_by FOREIGN KEY (created_by) REFERENCES profiles(id);

-- 4. Foreign key: leads.assigned_to → profiles.id
ALTER TABLE leads DROP CONSTRAINT IF EXISTS fk_leads_assigned_to;
ALTER TABLE leads ADD CONSTRAINT fk_leads_assigned_to FOREIGN KEY (assigned_to) REFERENCES profiles(id);

-- 5. Notify PostgREST to refresh schema cache
NOTIFY pgrst, 'reload schema';
