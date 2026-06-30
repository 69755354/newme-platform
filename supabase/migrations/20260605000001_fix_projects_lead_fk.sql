-- Fix: Add FK constraint on projects.lead_id → leads.id
-- The column was added without a FK, breaking PostgREST !lead_id joins

-- Step 1: Set invalid lead_ids to NULL (orphaned references)
UPDATE projects SET lead_id = NULL 
WHERE lead_id IS NOT NULL 
  AND lead_id NOT IN (SELECT id FROM leads);

-- Step 2: Add the FK constraint
ALTER TABLE projects 
  DROP CONSTRAINT IF EXISTS fk_projects_lead;

ALTER TABLE projects 
  ADD CONSTRAINT fk_projects_lead 
  FOREIGN KEY (lead_id) REFERENCES leads(id) 
  ON DELETE SET NULL;
