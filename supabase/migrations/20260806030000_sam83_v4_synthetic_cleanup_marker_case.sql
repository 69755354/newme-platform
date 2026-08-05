BEGIN;

-- The first cleanup-boundary migration is already part of the immutable
-- staging history.  The V4 runner's marker is uppercase, so use an
-- explicitly case-insensitive match without widening the marker shape.
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
        AND organization.slug ~* '^v4-uat-[0-9a-f]{12}-[0-9a-f]{8}-(real_estate|retail)$'
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
