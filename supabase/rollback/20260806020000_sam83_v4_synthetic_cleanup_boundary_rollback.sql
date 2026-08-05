BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '') NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'sam83_v4_synthetic_cleanup_rollback_requires_staging_or_test';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.retail_sam83_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retail_sam83_fact_is_append_only';
END;
$$;

REVOKE ALL ON FUNCTION public.retail_sam83_reject_mutation() FROM PUBLIC, anon, authenticated;

COMMIT;
