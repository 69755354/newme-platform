-- Fix CC-hallucinated columns: add missing columns, then add FKs

-- 1. leads.poor_reason (Tanya's high-priority requirement)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS poor_reason TEXT;

-- 2. follow_up_logs.created_by + FK (was referenced in code but column didn't exist)
ALTER TABLE follow_up_logs ADD COLUMN IF NOT EXISTS created_by UUID;
-- Populate from user_id if available
UPDATE follow_up_logs SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;
ALTER TABLE follow_up_logs DROP CONSTRAINT IF EXISTS fk_follow_up_logs_created_by;
ALTER TABLE follow_up_logs ADD CONSTRAINT fk_follow_up_logs_created_by FOREIGN KEY (created_by) REFERENCES profiles(id);

NOTIFY pgrst, 'reload schema';
