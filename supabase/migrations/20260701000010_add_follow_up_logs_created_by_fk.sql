-- Add FK: follow_up_logs.created_by → profiles.id
BEGIN;
ALTER TABLE follow_up_logs DROP CONSTRAINT IF EXISTS fk_follow_up_logs_created_by;
ALTER TABLE follow_up_logs ADD CONSTRAINT fk_follow_up_logs_created_by FOREIGN KEY (created_by) REFERENCES profiles(id);
NOTIFY pgrst, 'reload schema';
COMMIT;
