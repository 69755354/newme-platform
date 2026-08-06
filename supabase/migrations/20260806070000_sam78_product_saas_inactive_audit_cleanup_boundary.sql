-- Permit deletion of only the exact synthetic Product/SaaS audit evidence
-- after its fixture actor has been deactivated by the UAT. All organization,
-- marker, membership, action, target and outcome predicates remain required.
BEGIN;

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
        'lead.import', 'organization_membership_role_created',
        'organization.member.deactivate', 'organization.customer_export.v4',
        'organization.exit_prepared', 'organization.exit_completed'
      )
      AND actor_profile.email LIKE organization.slug || '-%@invalid.test'
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
              AND target_membership.user_id::text = audit_event.metadata ->> 'user_id'
          ))
        OR (audit_event.action = 'organization.member.deactivate'
          AND audit_event.target_type = 'membership'
          AND EXISTS (
            SELECT 1 FROM public.memberships AS target_membership
            WHERE target_membership.id::text = audit_event.target_id
              AND target_membership.organization_id = organization.id
              AND target_membership.user_id::text = audit_event.metadata ->> 'target_user_id'
          ))
        OR (audit_event.action = 'organization.customer_export.v4'
          AND audit_event.target_type = 'organization'
          AND audit_event.target_id = organization.id::text
          AND audit_event.metadata ->> 'data_sha256' ~ '^[0-9a-f]{64}$')
        OR (audit_event.action IN ('organization.exit_prepared', 'organization.exit_completed')
          AND audit_event.target_type = 'organization'
          AND audit_event.target_id = organization.id::text
          AND EXISTS (
            SELECT 1 FROM public.platform_action_approvals AS approval
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

COMMIT;
