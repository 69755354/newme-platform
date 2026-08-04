-- Allow service-role cleanup of only exact Product/SaaS staging UAT evidence.
-- Existing SAM-26 and SAM-20 immutable-record exceptions remain unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.product_saas_is_synthetic_organization(
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organizations AS organization
    JOIN public.memberships AS membership
      ON membership.organization_id = organization.id
    JOIN public.profiles AS profile
      ON profile.id = membership.user_id
    WHERE organization.id = p_organization_id
      AND organization.slug ~ '^product-saas-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND organization.name = '[PRODUCT-UAT '
        || substring(organization.slug FROM 14) || '] organization'
      AND organization.industry_key = 'real_estate'
      AND organization.plan_key = 'growth'
      AND organization.billable_seat_limit = 10
      AND organization.status = 'active'
      AND profile.email = organization.slug || '-admin@invalid.test'
      AND profile.role = 'admin'
      AND profile.is_active IS TRUE
      AND membership.status IN ('active', 'inactive')
  )
$$;

REVOKE ALL ON FUNCTION public.product_saas_is_synthetic_organization(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_saas_is_synthetic_organization(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.product_saas_is_synthetic_exit_approval(
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
    JOIN public.profiles AS requester_profile
      ON requester_profile.id = requester.user_id
    LEFT JOIN public.platform_staff AS approver
      ON approver.id = approval.approved_by_platform_staff_id
    LEFT JOIN public.profiles AS approver_profile
      ON approver_profile.id = approver.user_id
    WHERE approval.id = p_approval_id
      AND public.product_saas_is_synthetic_organization(organization.id)
      AND approval.action_key IN (
        'organization.exit.prepare', 'organization.exit.complete'
      )
      AND approval.status IN ('pending', 'approved', 'consumed')
      AND approval.payload ->> 'organization_id' = organization.id::text
      AND approval.payload ->> 'idempotency_key' =
        'exit-' || substring(organization.slug FROM 14)
      AND approval.request_id = 'exit:'
        || split_part(approval.action_key, '.', 3)
        || ':exit-' || substring(organization.slug FROM 14)
      AND requester.staff_ref = 'EXIT-'
        || left(substring(organization.slug FROM 14), 8) || '-OP'
      AND requester.role_key = 'platform_ops'
      AND requester.status = 'active'
      AND requester_profile.email = organization.slug || '-admin@invalid.test'
      AND requester_profile.is_active IS TRUE
      AND (
        (approval.action_key = 'organization.exit.prepare'
          AND approval.payload ->> 'reason' =
            'Synthetic customer-approved staging exit verification')
        OR (approval.action_key = 'organization.exit.complete'
          AND approval.payload ->> 'expected_export_sha256' ~ '^[0-9a-f]{64}$'
          AND approval.payload ->> 'backup_evidence_ref' ~ '^staging-backup-[0-9a-f]{40}$'
          AND approval.payload ->> 'customer_confirmation_ref' =
            'synthetic-confirmation-' || substring(organization.slug FROM 14)
          AND approval.payload ->> 'retention_basis' =
            'synthetic-staging-seven-year-contractual-retention')
      )
      AND (
        (approval.status = 'pending'
          AND approval.approved_by_platform_staff_id IS NULL
          AND approval.approved_at IS NULL
          AND approval.consumption_key IS NULL
          AND approval.consumed_at IS NULL
          AND approval.execution_result IS NULL)
        OR (approval.status = 'approved'
          AND approver.staff_ref = 'EXIT-'
            || left(substring(organization.slug FROM 14), 8) || '-APP'
          AND approver.role_key = 'platform_owner'
          AND approver.status = 'active'
          AND approver_profile.email = organization.slug || '-boss@invalid.test'
          AND approver_profile.is_active IS TRUE
          AND approval.approved_at IS NOT NULL
          AND approval.consumption_key IS NULL
          AND approval.consumed_at IS NULL
          AND approval.execution_result IS NULL)
        OR (approval.status = 'consumed'
          AND approver.staff_ref = 'EXIT-'
            || left(substring(organization.slug FROM 14), 8) || '-APP'
          AND approver.role_key = 'platform_owner'
          AND approver.status = 'active'
          AND approver_profile.email = organization.slug || '-boss@invalid.test'
          AND approver_profile.is_active IS TRUE
          AND approval.approved_at IS NOT NULL
          AND approval.consumption_key = 'exit-'
            || split_part(approval.action_key, '.', 3)
            || '-' || substring(organization.slug FROM 14)
          AND approval.consumed_at IS NOT NULL
          AND approval.execution_result ->> 'organization_id' = organization.id::text
          AND (
            (approval.action_key = 'organization.exit.prepare'
              AND approval.execution_result ->> 'status' = 'prepared'
              AND approval.execution_result ->> 'organization_status' = 'read_only')
            OR (approval.action_key = 'organization.exit.complete'
              AND approval.execution_result ->> 'status' = 'completed'
              AND approval.execution_result ->> 'organization_status' = 'closed')
          ))
      )
  )
$$;

REVOKE ALL ON FUNCTION public.product_saas_is_synthetic_exit_approval(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_saas_is_synthetic_exit_approval(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.product_saas_is_synthetic_audit_log(
  p_audit_log_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.audit_logs AS audit_log
    JOIN public.organizations AS organization
      ON organization.id = audit_log.organization_id
    JOIN public.profiles AS actor_profile
      ON actor_profile.id = audit_log.actor_id
    WHERE audit_log.id = p_audit_log_id
      AND public.product_saas_is_synthetic_organization(organization.id)
      AND audit_log.action = 'PAGE_VISIT'
      AND actor_profile.email LIKE organization.slug || '-%@invalid.test'
      AND actor_profile.is_active IS TRUE
      AND audit_log.details ->> 'page' LIKE '/%'
      AND length(audit_log.details ->> 'page') <= 2048
  )
$$;

REVOKE ALL ON FUNCTION public.product_saas_is_synthetic_audit_log(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_saas_is_synthetic_audit_log(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.product_saas_is_synthetic_audit_event(
  p_audit_event_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.audit_events AS audit_event
    JOIN public.organizations AS organization
      ON organization.id = audit_event.organization_id
    JOIN public.profiles AS actor_profile
      ON actor_profile.id = audit_event.actor_user_id
    JOIN public.memberships AS actor_membership
      ON actor_membership.organization_id = organization.id
     AND actor_membership.user_id = actor_profile.id
    WHERE audit_event.id = p_audit_event_id
      AND public.product_saas_is_synthetic_organization(organization.id)
      AND audit_event.outcome = 'success'
      AND audit_event.action IN (
        'lead.import',
        'organization_membership_role_created',
        'organization.member.deactivate',
        'organization.customer_export.v4',
        'organization.exit_prepared',
        'organization.exit_completed'
      )
      AND actor_profile.email LIKE organization.slug || '-%@invalid.test'
      AND actor_profile.is_active IS TRUE
      AND (
        (audit_event.action = 'lead.import'
          AND audit_event.target_type = 'import_batch'
          AND audit_event.target_id ~ '^[0-9a-f-]{36}$')
        OR (audit_event.action = 'organization_membership_role_created'
          AND audit_event.target_type = 'membership'
          AND EXISTS (
            SELECT 1 FROM public.memberships AS target_membership
            WHERE target_membership.id::text = audit_event.target_id
              AND target_membership.organization_id = organization.id
              AND target_membership.user_id::text =
                audit_event.metadata ->> 'user_id'
          ))
        OR (audit_event.action = 'organization.member.deactivate'
          AND audit_event.target_type = 'membership'
          AND EXISTS (
            SELECT 1 FROM public.memberships AS target_membership
            WHERE target_membership.id::text = audit_event.target_id
              AND target_membership.organization_id = organization.id
              AND target_membership.user_id::text =
                audit_event.metadata ->> 'target_user_id'
          ))
        OR (audit_event.action = 'organization.customer_export.v4'
          AND audit_event.target_type = 'organization'
          AND audit_event.target_id = organization.id::text
          AND audit_event.metadata ->> 'data_sha256' ~ '^[0-9a-f]{64}$')
        OR (audit_event.action IN (
              'organization.exit_prepared', 'organization.exit_completed'
            )
          AND audit_event.target_type = 'organization'
          AND audit_event.target_id = organization.id::text
          AND EXISTS (
            SELECT 1
            FROM public.platform_action_approvals AS approval
            WHERE public.product_saas_is_synthetic_exit_approval(approval.id)
              AND audit_event.request_id = 'approval-execute:' || approval.id::text
              AND approval.action_key = CASE audit_event.action
                WHEN 'organization.exit_prepared' THEN 'organization.exit.prepare'
                ELSE 'organization.exit.complete'
              END
          ))
      )
  )
$$;

REVOKE ALL ON FUNCTION public.product_saas_is_synthetic_audit_event(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_saas_is_synthetic_audit_event(uuid)
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

    IF current_user = 'service_role'
      AND public.product_saas_is_synthetic_audit_log(OLD.id)
    THEN RETURN OLD; END IF;
  END IF;

  IF TG_OP = 'DELETE'
    AND TG_TABLE_SCHEMA = 'public'
    AND TG_TABLE_NAME = 'platform_action_approval_events'
  THEN
    IF current_user = 'service_role'
      AND OLD.action IN ('requested', 'approved', 'consumed')
      AND (
        public.sam20_is_synthetic_support_approval(OLD.approval_request_id)
        OR public.product_saas_is_synthetic_exit_approval(
          OLD.approval_request_id
        )
      )
    THEN RETURN OLD; END IF;
  END IF;

  IF TG_OP = 'DELETE'
    AND TG_TABLE_SCHEMA = 'public'
    AND TG_TABLE_NAME = 'audit_events'
  THEN
    IF current_user = 'service_role'
      AND OLD.action IN (
        'support.session.start', 'support.lead:read', 'support.session.end'
      )
      AND OLD.outcome IN ('success', 'denied')
      AND EXISTS (
        SELECT 1
        FROM public.platform_action_approvals AS approval
        WHERE public.sam20_is_synthetic_support_approval(approval.id)
          AND approval.execution_result ->> 'support_session_id' =
            OLD.support_session_id::text
          AND approval.execution_result ->> 'organization_id' =
            OLD.organization_id::text
      )
    THEN RETURN OLD; END IF;

    IF current_user = 'service_role'
      AND public.product_saas_is_synthetic_audit_event(OLD.id)
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
      AND (
        public.sam20_is_synthetic_support_approval(OLD.id)
        OR public.product_saas_is_synthetic_exit_approval(OLD.id)
      )
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
