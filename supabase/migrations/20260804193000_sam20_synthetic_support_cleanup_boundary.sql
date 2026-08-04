-- Allow cleanup of only the exact SAM-20 synthetic support approval chain.
-- All non-marker and non-service-role approval/audit records stay immutable.
BEGIN;

CREATE OR REPLACE FUNCTION public.sam20_is_synthetic_support_approval(
  p_approval_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.platform_action_approvals AS approval
    JOIN public.organizations AS organization
      ON approval.target_key = organization.id::text
    JOIN public.platform_staff AS requester
      ON requester.id = approval.requested_by_platform_staff_id
    LEFT JOIN public.platform_staff AS approver
      ON approver.id = approval.approved_by_platform_staff_id
    JOIN public.platform_staff AS support_staff
      ON support_staff.user_id = (approval.payload ->> 'support_user_id')::uuid
    WHERE approval.id = p_approval_id
      AND approval.action_key = 'support.session.start'
      AND approval.status IN ('pending', 'approved', 'consumed')
      AND organization.slug ~ '^sam20-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-org-a$'
      AND organization.name = 'Synthetic org-a'
      AND approval.payload ->> 'organization_id' = organization.id::text
      AND approval.payload ->> 'ticket_ref' = regexp_replace(organization.slug, '-org-a$', '-ticket')
      AND approval.request_id = regexp_replace(organization.slug, '-org-a$', '-support-request')
      AND (
        (approval.status IN ('pending', 'approved')
          AND approval.consumption_key IS NULL
          AND approval.execution_result IS NULL)
        OR (approval.status = 'consumed'
          AND approval.consumption_key = regexp_replace(organization.slug, '-org-a$', '-support-consume')
          AND approval.execution_result ->> 'organization_id' = organization.id::text
          AND approval.execution_result ->> 'support_user_id' = requester.user_id::text
          AND approval.execution_result ->> 'status' = 'active')
      )
      AND requester.staff_ref = regexp_replace(organization.slug, '-org-a$', '-support')
      AND requester.role_key = 'platform_ops'
      AND requester.status = 'active'
      AND support_staff.id = requester.id
      AND (
        (approval.status = 'pending'
          AND approval.approved_by_platform_staff_id IS NULL)
        OR (approval.status IN ('approved', 'consumed')
          AND approver.staff_ref = regexp_replace(organization.slug, '-org-a$', '-approver')
          AND approver.role_key = 'platform_owner'
          AND approver.status = 'active')
      )
  )
$$;

REVOKE ALL ON FUNCTION public.sam20_is_synthetic_support_approval(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sam20_is_synthetic_support_approval(uuid)
  TO service_role;

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

  IF TG_OP = 'DELETE'
    AND TG_TABLE_SCHEMA = 'public'
    AND TG_TABLE_NAME = 'platform_action_approval_events'
  THEN
    IF current_user = 'service_role'
      AND OLD.action IN ('requested', 'approved', 'consumed')
      AND public.sam20_is_synthetic_support_approval(OLD.approval_request_id)
    THEN RETURN OLD; END IF;
  END IF;

  IF TG_OP = 'DELETE'
    AND TG_TABLE_SCHEMA = 'public'
    AND TG_TABLE_NAME = 'audit_events'
  THEN
    IF current_user = 'service_role'
      AND OLD.action IN ('support.session.start', 'support.lead:read', 'support.session.end')
      AND OLD.outcome IN ('success', 'denied')
      AND EXISTS (
        SELECT 1
        FROM public.platform_action_approvals AS approval
        WHERE public.sam20_is_synthetic_support_approval(approval.id)
          AND approval.execution_result ->> 'support_session_id' = OLD.support_session_id::text
          AND approval.execution_result ->> 'organization_id' = OLD.organization_id::text
      )
    THEN RETURN OLD; END IF;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'immutable_record';
END;
$$;

REVOKE ALL ON FUNCTION public.v4_reject_mutation()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.v4_guard_platform_action_approval_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = 'service_role'
      AND public.sam20_is_synthetic_support_approval(OLD.id)
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'immutable_record';
  END IF;
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

REVOKE ALL ON FUNCTION public.v4_guard_platform_action_approval_update()
  FROM PUBLIC, anon, authenticated;

COMMIT;
