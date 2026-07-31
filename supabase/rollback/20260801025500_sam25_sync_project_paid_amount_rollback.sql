DO $$
BEGIN
  IF current_setting('newme.environment', true) NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam25_project_payment_sync_rollback_requires_staging_or_test';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS sam25_sync_project_paid_amount
  ON public.payments;
DROP FUNCTION IF EXISTS public.sam25_sync_project_paid_amount();

NOTIFY pgrst, 'reload schema';
