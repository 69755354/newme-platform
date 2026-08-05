BEGIN;

-- Gateway records are append-only for all ordinary callers.  The V4 staging
-- acceptance runner is the sole deletion exception: service_role may remove
-- only rows owned by one of its exact marker-scoped synthetic organizations.
CREATE OR REPLACE FUNCTION public.v4_agent_gateway_records_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_user = 'service_role'
    AND TG_TABLE_NAME IN ('agent_gateway_commands', 'agent_gateway_events')
  THEN
    IF EXISTS (
      SELECT 1
      FROM public.organizations AS organization
      WHERE organization.id = OLD.organization_id
        AND organization.slug ~* '^v4-uat-[0-9a-f]{12}-[0-9a-f]{8}-(real_estate|retail)$'
        AND organization.name LIKE 'V4-UAT-%'
    ) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'agent_gateway_record_immutable';
END;
$$;

REVOKE ALL ON FUNCTION public.v4_agent_gateway_records_immutable()
  FROM PUBLIC, anon, authenticated;

COMMIT;
