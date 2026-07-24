-- Add contact_time to follow_up_logs for first_contact gate and timeline accuracy

ALTER TABLE public.follow_up_logs
  ADD COLUMN IF NOT EXISTS contact_time timestamptz;

-- Backfill from created_at for historical rows
UPDATE public.follow_up_logs
SET contact_time = COALESCE(contact_time, created_at)
WHERE contact_time IS NULL;

-- Enforce non-null after backfill for new writes only
ALTER TABLE public.follow_up_logs
  ALTER COLUMN contact_time SET NOT NULL;

NOTIFY pgrst, 'reload schema';
