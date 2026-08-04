-- Permit service-role cleanup of only marker-bound SAM-26 staging PAGE_VISIT
-- evidence. Every other audit/lifecycle record remains immutable.
BEGIN;

CREATE OR REPLACE FUNCTION public.v4_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  fixture_run_id text;
BEGIN
  IF TG_OP = 'DELETE'
    AND TG_TABLE_SCHEMA = 'public'
    AND TG_TABLE_NAME = 'audit_logs'
  THEN
    fixture_run_id := OLD.details ->> 'fixture_run_id';
    IF current_user = 'service_role'
      AND OLD.action = 'PAGE_VISIT'
      AND OLD.details ->> 'fixture_scope' = 'sam26-staging-uat'
      AND fixture_run_id ~ '^\d{13}-[0-9a-f]{8}$'
      AND EXISTS (
        SELECT 1
        FROM public.organizations AS organization
        WHERE organization.id = OLD.organization_id
          AND organization.slug = 'sam26-' || fixture_run_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.profiles AS profile
        WHERE profile.id = OLD.actor_id
          AND profile.email LIKE 'sam26-' || fixture_run_id || '-%@example.test'
      )
    THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'immutable_record';
END;
$$;

REVOKE ALL ON FUNCTION public.v4_reject_mutation()
  FROM PUBLIC, anon, authenticated;

COMMIT;
