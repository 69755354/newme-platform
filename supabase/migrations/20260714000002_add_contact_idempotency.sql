-- Make structured contact retries idempotent without changing legacy rows.
BEGIN;

ALTER TABLE public.follow_up_logs
  ADD COLUMN IF NOT EXISTS contact_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_up_logs_contact_fingerprint
  ON public.follow_up_logs (contact_fingerprint);

NOTIFY pgrst, 'reload schema';
COMMIT;
