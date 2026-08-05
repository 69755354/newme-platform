BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '') NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'sam84_v4_synthetic_gateway_cleanup_boundary_rollback_requires_staging_or_test';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_agent_gateway_records_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'agent_gateway_record_immutable';
END;
$$;

REVOKE ALL ON FUNCTION public.v4_agent_gateway_records_immutable()
  FROM PUBLIC, anon, authenticated;

COMMIT;
