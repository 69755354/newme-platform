BEGIN;

-- Retail inventory movements stay append-only for ordinary actors. The
-- service role may delete only V4 staging-acceptance fixtures that are
-- constrained by both the synthetic organisation slug and display name.
CREATE OR REPLACE FUNCTION public.retail_reject_mutable_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_user = 'service_role'
    AND TG_TABLE_NAME = 'retail_inventory_movements'
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

  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retail_inventory_movement_is_append_only';
END;
$$;

REVOKE ALL ON FUNCTION public.retail_reject_mutable_ledger()
  FROM PUBLIC, anon, authenticated;

-- The trigger runs as the deleting database role.  It may inspect only the
-- marker predicates required to decide whether this controlled cleanup applies.
GRANT SELECT (id, slug, name) ON TABLE public.organizations TO service_role;

COMMIT;
