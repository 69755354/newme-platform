\set ON_ERROR_STOP on

-- A real pre-V4 platform_staff row proves the migration fails closed without
-- an explicit operator-approved mapping. Its global profile role is
-- deliberately high and must never be consulted by the V4 migration.
INSERT INTO public.platform_staff(id, user_id, status, staff_ref)
VALUES (
  '78000000-0099-4000-8000-000000000099',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'active',
  'sam78-explicit-role-mapping-probe'
);
