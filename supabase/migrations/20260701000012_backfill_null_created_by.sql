-- Backfill NULL created_by: use assigned_to (current owner) as creator fallback
UPDATE leads SET created_by = assigned_to WHERE created_by IS NULL AND assigned_to IS NOT NULL;
NOTIFY pgrst, 'reload schema';
