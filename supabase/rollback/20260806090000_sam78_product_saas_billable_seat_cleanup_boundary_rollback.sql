BEGIN;

DO $$
BEGIN
  IF current_setting('newme.environment', true) NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam78_product_saas_billable_seat_cleanup_rollback_requires_staging_or_test';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.product_saas_is_synthetic_organization(
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organizations AS organization
    JOIN public.memberships AS membership ON membership.organization_id = organization.id
    JOIN public.profiles AS profile ON profile.id = membership.user_id
    WHERE organization.id = p_organization_id
      AND organization.slug ~ '^product-saas-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND organization.name = '[PRODUCT-UAT ' || substring(organization.slug FROM 14) || '] organization'
      AND organization.industry_key = 'real_estate'
      AND organization.plan_key = 'growth'
      AND organization.billable_seat_limit = 10
      AND organization.status IN ('active', 'read_only', 'closed')
      AND profile.email = organization.slug || '-admin@invalid.test'
      AND profile.role = 'admin'
      AND membership.status IN ('active', 'inactive')
  )
$$;

REVOKE ALL ON FUNCTION public.product_saas_is_synthetic_organization(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_saas_is_synthetic_organization(uuid)
  TO service_role;

COMMIT;
