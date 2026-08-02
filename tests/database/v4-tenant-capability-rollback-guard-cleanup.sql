\set ON_ERROR_STOP on

SET ROLE service_role;

DELETE FROM public.products
WHERE sku = 'V4-ROLLBACK-GUARD';
DELETE FROM public.audit_events
WHERE organization_id IN (
  SELECT id FROM public.organizations
  WHERE slug = 'v4-capability-rollback-guard'
);
DELETE FROM public.organization_provisioning_requests
WHERE idempotency_key = 'v4:capability:rollback-guard';
DELETE FROM public.membership_roles
WHERE membership_id IN (
  SELECT membership.id
  FROM public.memberships membership
  JOIN public.organizations organization
    ON organization.id = membership.organization_id
  WHERE organization.slug = 'v4-capability-rollback-guard'
);
DELETE FROM public.memberships
WHERE organization_id IN (
  SELECT id FROM public.organizations
  WHERE slug = 'v4-capability-rollback-guard'
);
DELETE FROM public.organizations
WHERE slug = 'v4-capability-rollback-guard';

RESET ROLE;

DELETE FROM public.profiles
WHERE id = '78000000-0000-4000-8000-000000000099';
DELETE FROM auth.users
WHERE id = '78000000-0000-4000-8000-000000000099';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.products WHERE sku = 'V4-ROLLBACK-GUARD'
  ) OR EXISTS (
    SELECT 1 FROM public.organizations
    WHERE slug = 'v4-capability-rollback-guard'
  ) THEN
    RAISE EXCEPTION 'V4 rollback guard cleanup failed';
  END IF;
END
$$;

SELECT 'V4 tenant capability rollback guard cleanup passed' AS result;
