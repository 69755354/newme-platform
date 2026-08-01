-- Keep the one-day creation grace without making historical rows invalid as
-- wall-clock time advances. A CHECK constraint must be stable so logical
-- backups remain restorable after tasks become overdue.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tasks') IS NULL THEN
    RAISE EXCEPTION 'tasks_table_required_for_restorable_due_constraint';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tasks
    WHERE due_at <= created_at - interval '1 day'
  ) THEN
    RAISE EXCEPTION 'tasks_stable_due_constraint_existing_violation';
  END IF;

  ALTER TABLE public.tasks
    DROP CONSTRAINT IF EXISTS tasks_future_only;

  ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_future_only
    CHECK (due_at > created_at - interval '1 day')
    NOT VALID;

  ALTER TABLE public.tasks
    VALIDATE CONSTRAINT tasks_future_only;
END
$$;

COMMIT;
