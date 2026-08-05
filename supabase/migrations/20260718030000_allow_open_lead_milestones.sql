-- A reopened milestone remains as an auditable row, but is no longer completed.
-- The timestamp therefore represents a completed fact and must be nullable.
BEGIN;

ALTER TABLE public.lead_milestones
  ALTER COLUMN completed_at DROP NOT NULL;

COMMIT;
