BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '') NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'sam83_v4_synthetic_cleanup_marker_case_rollback_requires_staging_or_test';
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
  IF TG_OP = 'DELETE'
    AND current_user = 'service_role'
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization
      WHERE organization.id = OLD.organization_id
        AND organization.slug ~ '^v4-uat-[0-9a-f]{12}-[0-9a-f]{8}-(real_estate|retail)$'
        AND organization.name LIKE 'V4-UAT-%'
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retail_sam83_fact_is_append_only';
END;
$$;

REVOKE ALL ON FUNCTION public.retail_sam83_reject_mutation() FROM PUBLIC, anon, authenticated;

COMMIT;
