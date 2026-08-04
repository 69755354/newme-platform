BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam20_synthetic_support_cleanup_rollback_requires_staging_or_test';
  END IF;
END
$$;

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
        SELECT 1 FROM public.organizations AS organization
        WHERE organization.id = OLD.organization_id
          AND organization.slug = 'sam26-' || fixture_run_id
      )
      AND EXISTS (
        SELECT 1 FROM public.profiles AS profile
        WHERE profile.id = OLD.actor_id
          AND profile.email LIKE 'sam26-' || fixture_run_id || '-%@example.test'
      )
    THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'immutable_record';
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_guard_platform_action_approval_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable_record'; END IF;
  IF ROW(
    NEW.id, NEW.action_key, NEW.target_key, NEW.payload, NEW.payload_hash,
    NEW.requested_by_platform_staff_id, NEW.request_id,
    NEW.requested_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.action_key, OLD.target_key, OLD.payload, OLD.payload_hash,
    OLD.requested_by_platform_staff_id, OLD.request_id,
    OLD.requested_at, OLD.expires_at
  ) THEN RAISE EXCEPTION 'platform_approval_payload_immutable'; END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status = 'approved'
      AND NEW.approved_by_platform_staff_id IS NOT NULL
      AND NEW.approved_at IS NOT NULL
      AND NEW.consumption_key IS NULL AND NEW.consumed_at IS NULL
      AND NEW.execution_result IS NULL)
    OR (OLD.status = 'approved' AND NEW.status = 'consumed'
      AND NEW.approved_by_platform_staff_id = OLD.approved_by_platform_staff_id
      AND NEW.approved_at = OLD.approved_at
      AND NEW.consumption_key IS NOT NULL AND NEW.consumed_at IS NOT NULL
      AND NEW.execution_result IS NOT NULL)
  ) THEN RAISE EXCEPTION 'invalid_platform_approval_transition'; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.v4_reject_mutation()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v4_guard_platform_action_approval_update()
  FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.sam20_is_synthetic_support_approval(uuid);

COMMIT;
