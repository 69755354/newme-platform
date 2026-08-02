\set ON_ERROR_STOP on

INSERT INTO auth.users(id)
VALUES ('78000000-0000-4000-8000-000000000099');
INSERT INTO public.profiles(id, role, is_active)
VALUES ('78000000-0000-4000-8000-000000000099', 'admin', true);

SET ROLE service_role;

SELECT public.initialize_organization(
  'v4:capability:rollback-guard',
  'v4-capability-rollback-guard',
  'V4 Capability Rollback Guard',
  'retail',
  'starter',
  3,
  '78000000-0000-4000-8000-000000000099'
);

INSERT INTO public.products(
  organization_id, tenant_id, sku, name, unit_price
)
SELECT
  organization.id,
  organization.id,
  'V4-ROLLBACK-GUARD',
  'V4 rollback guard product',
  1
FROM public.organizations organization
WHERE organization.slug = 'v4-capability-rollback-guard';

RESET ROLE;

SELECT 'V4 tenant capability rollback guard fixture passed' AS result;
