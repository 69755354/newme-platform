-- SAM-20 staging/test-only rollback.
-- Fail closed unless the caller explicitly sets newme.environment to staging
-- or test and all non-legacy SAM-20 fixture data has already been removed.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  environment_name text := current_setting('newme.environment', true);
  legacy_organization_id constant uuid :=
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid;
BEGIN
  IF environment_name IS NULL
    OR environment_name NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'sam20_rollback_requires_staging_or_test';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.organizations
    WHERE id <> legacy_organization_id
  ) THEN
    RAISE EXCEPTION 'sam20_rollback_fixture_organizations_not_clean';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE organization_id <> legacy_organization_id
  ) THEN
    RAISE EXCEPTION 'sam20_rollback_fixture_memberships_not_clean';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leads
    WHERE organization_id <> legacy_organization_id
  ) THEN
    RAISE EXCEPTION 'sam20_rollback_fixture_leads_not_clean';
  END IF;

  IF EXISTS (SELECT 1 FROM public.platform_staff) THEN
    RAISE EXCEPTION 'sam20_rollback_fixture_platform_staff_not_clean';
  END IF;

  IF EXISTS (SELECT 1 FROM public.support_sessions) THEN
    RAISE EXCEPTION 'sam20_rollback_fixture_support_sessions_not_clean';
  END IF;

  IF EXISTS (SELECT 1 FROM public.audit_events) THEN
    RAISE EXCEPTION 'sam20_rollback_fixture_audit_events_not_clean';
  END IF;
END
$$;

DO $$
DECLARE
  child_table text;
BEGIN
  FOREACH child_table IN ARRAY ARRAY[
    'activities',
    'business_events',
    'chat_messages',
    'follow_up_logs',
    'lead_documents',
    'lead_milestones',
    'tasks'
  ]
  LOOP
    IF to_regclass('public.' || child_table) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS sam20_enforce_lead_child_organization_context
           ON public.%I',
        child_table
      );
      EXECUTE format(
        'DROP POLICY IF EXISTS sam20_%I_organization_boundary ON public.%I',
        child_table,
        child_table
      );
    END IF;
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS sam20_enforce_lead_organization_context
  ON public.leads;
DROP POLICY IF EXISTS sam20_leads_organization_boundary
  ON public.leads;

DROP FUNCTION IF EXISTS public.enforce_lead_child_organization_context();
DROP FUNCTION IF EXISTS public.enforce_lead_organization_context();
DROP FUNCTION IF EXISTS public.requested_organization_id();

DROP INDEX IF EXISTS public.leads_organization_updated_idx;
DROP INDEX IF EXISTS public.leads_organization_id_id_unique;
ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_organization_id_fkey;
ALTER TABLE public.leads
  DROP COLUMN IF EXISTS organization_id;

DROP POLICY IF EXISTS sam20_organizations_member_read
  ON public.organizations;
DROP POLICY IF EXISTS sam20_memberships_self_read
  ON public.memberships;

DO $$
BEGIN
  IF to_regclass('public.v_lead_trace') IS NOT NULL THEN
    ALTER VIEW public.v_lead_trace RESET (security_invoker);
  END IF;
END
$$;

DROP TABLE IF EXISTS public.audit_events;
DROP TABLE IF EXISTS public.support_sessions;
DROP TABLE IF EXISTS public.platform_staff;
DROP TABLE IF EXISTS public.memberships;
DROP TABLE IF EXISTS public.organizations;

NOTIFY pgrst, 'reload schema';

COMMIT;
