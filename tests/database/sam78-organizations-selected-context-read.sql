\set ON_ERROR_STOP on

INSERT INTO auth.users(id)
VALUES ('78120000-0000-4000-8000-000000000001');
INSERT INTO public.profiles(id, role, is_active)
VALUES ('78120000-0000-4000-8000-000000000001', 'admin', true);

INSERT INTO public.organizations(id, slug, name, industry_key, status)
VALUES
  ('78120000-0000-4000-8000-000000000101',
   'sam78-selected-context-a', 'SAM-78 selected context A', 'real_estate', 'active'),
  ('78120000-0000-4000-8000-000000000102',
   'sam78-selected-context-b', 'SAM-78 selected context B', 'retail', 'active');
INSERT INTO public.memberships(organization_id, user_id, status, accepted_at)
VALUES
  ('78120000-0000-4000-8000-000000000101',
   '78120000-0000-4000-8000-000000000001', 'active', now()),
  ('78120000-0000-4000-8000-000000000102',
   '78120000-0000-4000-8000-000000000001', 'active', now());

SET ROLE authenticated;
SET request.jwt.claim.sub = '78120000-0000-4000-8000-000000000001';
SELECT set_config(
  'request.headers',
  '{"x-newme-organization-id":"78120000-0000-4000-8000-000000000101"}',
  false
);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.organizations
      WHERE id IN ('78120000-0000-4000-8000-000000000101',
                   '78120000-0000-4000-8000-000000000102')) <> 1
  THEN
    RAISE EXCEPTION 'selected organization read boundary did not restrict count';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations
             WHERE id = '78120000-0000-4000-8000-000000000102') THEN
    RAISE EXCEPTION 'selected organization read boundary exposed foreign organization';
  END IF;
END
$$;
SELECT set_config(
  'request.headers',
  '{"x-newme-organization-id":"78120000-0000-4000-8000-000000000102"}',
  false
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations
                 WHERE id = '78120000-0000-4000-8000-000000000102') THEN
    RAISE EXCEPTION 'selected organization read boundary hid selected organization';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations
             WHERE id = '78120000-0000-4000-8000-000000000101') THEN
    RAISE EXCEPTION 'selected organization read boundary leaked previous organization';
  END IF;
END
$$;
SELECT set_config('request.headers', '{}', false);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id IN ('78120000-0000-4000-8000-000000000101',
                 '78120000-0000-4000-8000-000000000102')
  ) THEN
    RAISE EXCEPTION 'multi-organization headerless read was not fail-closed';
  END IF;
END
$$;
RESET ROLE;

DELETE FROM public.memberships
WHERE organization_id IN (
  '78120000-0000-4000-8000-000000000101',
  '78120000-0000-4000-8000-000000000102'
);
DELETE FROM public.organizations
WHERE id IN (
  '78120000-0000-4000-8000-000000000101',
  '78120000-0000-4000-8000-000000000102'
);
DELETE FROM public.profiles
WHERE id = '78120000-0000-4000-8000-000000000001';
DELETE FROM auth.users
WHERE id = '78120000-0000-4000-8000-000000000001';
