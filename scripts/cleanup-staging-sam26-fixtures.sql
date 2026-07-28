-- Deletes only fixed, explicitly marked SAM-26 staging fixtures.
-- Never deletes profiles or auth users.
-- Run only with:
--   PGOPTIONS='-c app.newme.staging_fixture_target=bfsiibofuzoglziltgyd' \
--   psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/cleanup-staging-sam26-fixtures.sql

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_setting('app.newme.staging_fixture_target', true) IS DISTINCT FROM 'bfsiibofuzoglziltgyd' THEN
    RAISE EXCEPTION 'SAM-26 cleanup refuses to run outside staging project bfsiibofuzoglziltgyd';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.leads
    WHERE id = ANY (ARRAY[
      '8a260001-2c66-4d00-8000-000000000001'::uuid,
      '8a260001-2c66-4d00-8000-000000000002'::uuid,
      '8a260001-2c66-4d00-8000-000000000003'::uuid,
      '8a260001-2c66-4d00-8000-000000000004'::uuid,
      '8a260001-2c66-4d00-8000-000000000005'::uuid,
      '8a260001-2c66-4d00-8000-000000000006'::uuid
    ]) AND metadata ->> 'fixture_scope' IS DISTINCT FROM 'staging-sam26'
  ) THEN
    RAISE EXCEPTION 'SAM-26 cleanup found a lead UUID collision outside fixture scope';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.activities
    WHERE id = ANY (ARRAY[
      '8a260101-2c66-4d00-8000-000000000001'::uuid,
      '8a260101-2c66-4d00-8000-000000000002'::uuid
    ]) AND metadata ->> 'fixture_scope' IS DISTINCT FROM 'staging-sam26'
  ) THEN
    RAISE EXCEPTION 'SAM-26 cleanup found an activity UUID collision outside fixture scope';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tasks
    WHERE id = ANY (ARRAY[
      '8a260201-2c66-4d00-8000-000000000001'::uuid,
      '8a260201-2c66-4d00-8000-000000000002'::uuid
    ]) AND description NOT LIKE 'fixture_scope=staging-sam26;%'
  ) THEN
    RAISE EXCEPTION 'SAM-26 cleanup found a task UUID collision outside fixture scope';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.business_events
    WHERE id = ANY (ARRAY[
      '8a260301-2c66-4d00-8000-000000000001'::uuid,
      '8a260301-2c66-4d00-8000-000000000002'::uuid
    ]) AND event_data ->> 'fixture_scope' IS DISTINCT FROM 'staging-sam26'
  ) THEN
    RAISE EXCEPTION 'SAM-26 cleanup found a business-event UUID collision outside fixture scope';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.notifications
    WHERE id = ANY (ARRAY[
      '8a260401-2c66-4d00-8000-000000000001'::uuid,
      '8a260401-2c66-4d00-8000-000000000002'::uuid,
      '8a260401-2c66-4d00-8000-000000000003'::uuid,
      '8a260401-2c66-4d00-8000-000000000004'::uuid,
      '8a260401-2c66-4d00-8000-000000000005'::uuid,
      '8a260401-2c66-4d00-8000-000000000006'::uuid
    ]) AND title IS DISTINCT FROM '[SAM-26] synthetic lead assignment'
  ) THEN
    RAISE EXCEPTION 'SAM-26 cleanup found a notification UUID collision outside fixture scope';
  END IF;
END $$;

DELETE FROM public.notifications
WHERE id = ANY (ARRAY[
  '8a260401-2c66-4d00-8000-000000000001'::uuid,
  '8a260401-2c66-4d00-8000-000000000002'::uuid,
  '8a260401-2c66-4d00-8000-000000000003'::uuid,
  '8a260401-2c66-4d00-8000-000000000004'::uuid,
  '8a260401-2c66-4d00-8000-000000000005'::uuid,
  '8a260401-2c66-4d00-8000-000000000006'::uuid
]) AND title = '[SAM-26] synthetic lead assignment';

DELETE FROM public.business_events
WHERE id = ANY (ARRAY[
  '8a260301-2c66-4d00-8000-000000000001'::uuid,
  '8a260301-2c66-4d00-8000-000000000002'::uuid
]) AND event_data ->> 'fixture_scope' = 'staging-sam26';

DELETE FROM public.activities
WHERE id = ANY (ARRAY[
  '8a260101-2c66-4d00-8000-000000000001'::uuid,
  '8a260101-2c66-4d00-8000-000000000002'::uuid
]) AND metadata ->> 'fixture_scope' = 'staging-sam26';

DELETE FROM public.tasks
WHERE id = ANY (ARRAY[
  '8a260201-2c66-4d00-8000-000000000001'::uuid,
  '8a260201-2c66-4d00-8000-000000000002'::uuid
]) AND description LIKE 'fixture_scope=staging-sam26;%';

DELETE FROM public.leads
WHERE id = ANY (ARRAY[
  '8a260001-2c66-4d00-8000-000000000001'::uuid,
  '8a260001-2c66-4d00-8000-000000000002'::uuid,
  '8a260001-2c66-4d00-8000-000000000003'::uuid,
  '8a260001-2c66-4d00-8000-000000000004'::uuid,
  '8a260001-2c66-4d00-8000-000000000005'::uuid,
  '8a260001-2c66-4d00-8000-000000000006'::uuid
]) AND metadata ->> 'fixture_scope' = 'staging-sam26';

COMMIT;
