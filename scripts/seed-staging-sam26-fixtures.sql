-- SAM-26 staging-only synthetic fixtures.
--
-- This file never creates auth.users or public.profiles. It succeeds only after
-- one active, pre-provisioned non-production profile exists for each required
-- role. Run only with:
--   PGOPTIONS='-c app.newme.staging_fixture_target=bfsiibofuzoglziltgyd' \
--   psql $STAGING_DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/seed-staging-sam26-fixtures.sql
--
-- It is idempotent: every fixture uses a fixed UUID and conflicts are no-ops.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  missing_roles text[];
BEGIN
  IF current_setting('app.newme.staging_fixture_target', true) IS DISTINCT FROM 'bfsiibofuzoglziltgyd' THEN
    RAISE EXCEPTION 'SAM-26 fixtures refuse to run outside staging project bfsiibofuzoglziltgyd';
  END IF;

  SELECT array_agg(required_role ORDER BY required_role)
    INTO missing_roles
  FROM unnest(ARRAY['boss', 'admin', 'operator', 'sales', 'finance', 'designer']::text[]) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.profiles profile
    WHERE profile.role = required_role
      AND profile.is_active IS TRUE
  );

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'SAM-26 fixtures require pre-provisioned active staging profiles for roles: %', missing_roles;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leads
    WHERE id = ANY (ARRAY[
      '8a260001-2c66-4d00-8000-000000000001'::uuid,
      '8a260001-2c66-4d00-8000-000000000002'::uuid,
      '8a260001-2c66-4d00-8000-000000000003'::uuid,
      '8a260001-2c66-4d00-8000-000000000004'::uuid,
      '8a260001-2c66-4d00-8000-000000000005'::uuid,
      '8a260001-2c66-4d00-8000-000000000006'::uuid
    ])
      AND metadata ->> 'fixture_scope' IS DISTINCT FROM 'staging-sam26'
  ) THEN
    RAISE EXCEPTION 'SAM-26 fixture UUID collision with a non-fixture lead';
  END IF;
END $$;

WITH role_profiles AS (
  SELECT DISTINCT ON (role) role, id
  FROM public.profiles
  WHERE role = ANY (ARRAY['boss', 'admin', 'operator', 'sales', 'finance', 'designer']::text[])
    AND is_active IS TRUE
  ORDER BY role, id
), fixture_rows AS (
  SELECT *
  FROM (VALUES
    ('boss',     'boss',     '8a260001-2c66-4d00-8000-000000000001'::uuid, 'new',                    'SAM-26 Synthetic boss'),
    ('admin',    'admin',    '8a260001-2c66-4d00-8000-000000000002'::uuid, 'contacted',              'SAM-26 Synthetic admin'),
    ('operator', 'operator', '8a260001-2c66-4d00-8000-000000000003'::uuid, 'requirement_confirmed', 'SAM-26 Synthetic operator'),
    ('sales',    'sales',    '8a260001-2c66-4d00-8000-000000000004'::uuid, 'solution_submitted',    'SAM-26 Synthetic sales'),
    ('finance',  'sales',    '8a260001-2c66-4d00-8000-000000000005'::uuid, 'quotation_submitted',   'SAM-26 Synthetic finance'),
    ('designer', 'operator', '8a260001-2c66-4d00-8000-000000000006'::uuid, 'negotiation',            'SAM-26 Synthetic designer')
  ) AS fixture_rows(role, assignee_role, id, stage, customer_name)
)
INSERT INTO public.leads (
  id, source, customer_name, email, property_type, location, budget_range,
  service_needs, quality, stage, assigned_to, assigned_to_uuid, owner_uuid,
  created_by, contact_result, project_type, emirate, metadata, archived
)
SELECT
  fixture_rows.id,
  'website',
  fixture_rows.customer_name,
  'sam26+' || fixture_rows.role || '@invalid.test',
  'villa',
  'Synthetic District',
  '100k-250k',
  ARRAY['automation']::text[],
  'good',
  fixture_rows.stage,
  assignee_profiles.id,
  assignee_profiles.id,
  fixture_profiles.id,
  fixture_profiles.id,
  'interested',
  'villa',
  'Dubai',
  jsonb_build_object('fixture_scope', 'staging-sam26', 'synthetic', true, 'role', fixture_rows.role),
  false
FROM fixture_rows
JOIN role_profiles AS fixture_profiles ON fixture_profiles.role = fixture_rows.role
JOIN role_profiles AS assignee_profiles ON assignee_profiles.role = fixture_rows.assignee_role
ON CONFLICT (id) DO NOTHING;

WITH role_profiles AS (
  SELECT DISTINCT ON (role) role, id
  FROM public.profiles
  WHERE role = ANY (ARRAY['boss', 'admin', 'operator', 'sales', 'finance', 'designer']::text[])
    AND is_active IS TRUE
  ORDER BY role, id
), fixture_rows AS (
  SELECT *
  FROM (VALUES
    ('sales', '8a260101-2c66-4d00-8000-000000000001'::uuid, '8a260001-2c66-4d00-8000-000000000004'::uuid),
    ('operator', '8a260101-2c66-4d00-8000-000000000002'::uuid, '8a260001-2c66-4d00-8000-000000000003'::uuid)
  ) AS fixture_rows(role, id, lead_id)
)
INSERT INTO public.activities (id, lead_id, user_id, type, content, is_completed, due_at, priority, metadata)
SELECT
  fixture_rows.id,
  fixture_rows.lead_id,
  role_profiles.id,
  'note',
  'SAM-26 synthetic activity for ' || fixture_rows.role,
  true,
  now() + interval '1 day',
  'normal',
  jsonb_build_object('fixture_scope', 'staging-sam26', 'synthetic', true)
FROM fixture_rows
JOIN role_profiles USING (role)
ON CONFLICT (id) DO NOTHING;

WITH role_profiles AS (
  SELECT DISTINCT ON (role) role, id
  FROM public.profiles
  WHERE role = ANY (ARRAY['boss', 'admin', 'operator', 'sales', 'finance', 'designer']::text[])
    AND is_active IS TRUE
  ORDER BY role, id
), fixture_rows AS (
  SELECT *
  FROM (VALUES
    ('sales', '8a260201-2c66-4d00-8000-000000000001'::uuid, '8a260001-2c66-4d00-8000-000000000004'::uuid),
    ('finance', '8a260201-2c66-4d00-8000-000000000002'::uuid, '8a260001-2c66-4d00-8000-000000000005'::uuid)
  ) AS fixture_rows(role, id, lead_id)
)
INSERT INTO public.tasks (id, lead_id, title, description, assignee_id, due_at, status, source, priority)
SELECT
  fixture_rows.id,
  fixture_rows.lead_id,
  'SAM-26 synthetic follow-up',
  'fixture_scope=staging-sam26; synthetic task for ' || fixture_rows.role,
  role_profiles.id,
  now() + interval '2 days',
  'pending',
  'manual',
  'medium'
FROM fixture_rows
JOIN role_profiles USING (role)
ON CONFLICT (id) DO NOTHING;

WITH role_profiles AS (
  SELECT DISTINCT ON (role) role, id
  FROM public.profiles
  WHERE role = ANY (ARRAY['boss', 'admin', 'operator', 'sales', 'finance', 'designer']::text[])
    AND is_active IS TRUE
  ORDER BY role, id
), fixture_rows AS (
  SELECT *
  FROM (VALUES
    ('admin', '8a260301-2c66-4d00-8000-000000000001'::uuid, '8a260001-2c66-4d00-8000-000000000002'::uuid),
    ('designer', '8a260301-2c66-4d00-8000-000000000002'::uuid, '8a260001-2c66-4d00-8000-000000000006'::uuid)
  ) AS fixture_rows(role, id, lead_id)
)
INSERT INTO public.business_events (id, lead_id, entity_type, entity_id, created_by, user_id, event_type, event_data, description)
SELECT
  fixture_rows.id,
  fixture_rows.lead_id,
  'lead',
  fixture_rows.lead_id,
  role_profiles.id,
  role_profiles.id,
  'note_added',
  jsonb_build_object('fixture_scope', 'staging-sam26', 'synthetic', true, 'role', fixture_rows.role),
  'SAM-26 synthetic business event'
FROM fixture_rows
JOIN role_profiles USING (role)
ON CONFLICT (id) DO NOTHING;

WITH role_profiles AS (
  SELECT DISTINCT ON (role) role, id
  FROM public.profiles
  WHERE role = ANY (ARRAY['boss', 'admin', 'operator', 'sales', 'finance', 'designer']::text[])
    AND is_active IS TRUE
  ORDER BY role, id
), fixture_rows AS (
  SELECT *
  FROM (VALUES
    ('boss',     '8a260401-2c66-4d00-8000-000000000001'::uuid, '8a260001-2c66-4d00-8000-000000000001'::uuid),
    ('admin',    '8a260401-2c66-4d00-8000-000000000002'::uuid, '8a260001-2c66-4d00-8000-000000000002'::uuid),
    ('operator', '8a260401-2c66-4d00-8000-000000000003'::uuid, '8a260001-2c66-4d00-8000-000000000003'::uuid),
    ('sales',    '8a260401-2c66-4d00-8000-000000000004'::uuid, '8a260001-2c66-4d00-8000-000000000004'::uuid),
    ('finance',  '8a260401-2c66-4d00-8000-000000000005'::uuid, '8a260001-2c66-4d00-8000-000000000005'::uuid),
    ('designer', '8a260401-2c66-4d00-8000-000000000006'::uuid, '8a260001-2c66-4d00-8000-000000000006'::uuid)
  ) AS fixture_rows(role, id, lead_id)
)
INSERT INTO public.notifications (id, user_id, type, title, body, related_id, related_type, is_read)
SELECT
  fixture_rows.id,
  role_profiles.id,
  'lead_assigned',
  '[SAM-26] synthetic lead assignment',
  'Synthetic notification for ' || fixture_rows.role,
  fixture_rows.lead_id,
  'lead',
  false
FROM fixture_rows
JOIN role_profiles USING (role)
ON CONFLICT (id) DO NOTHING;

COMMIT;
