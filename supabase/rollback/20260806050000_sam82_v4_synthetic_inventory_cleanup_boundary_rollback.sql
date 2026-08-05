BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '') NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'sam82_v4_synthetic_inventory_cleanup_boundary_rollback_requires_staging_or_test';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.retail_reject_mutable_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retail_inventory_ledger_is_append_only';
END;
$$;

REVOKE ALL ON FUNCTION public.retail_reject_mutable_ledger()
  FROM PUBLIC, anon, authenticated;

COMMIT;
