BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam26_synthetic_audit_cleanup_rollback_requires_staging_or_test';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.v4_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'immutable_record';
END;
$$;

REVOKE ALL ON FUNCTION public.v4_reject_mutation()
  FROM PUBLIC, anon, authenticated;

COMMIT;
