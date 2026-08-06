BEGIN;

-- Product/SaaS UAT uses the SAM-79 commercial control-plane staff references
-- for its exact synthetic exit approvals.  Preserve every other cleanup
-- predicate while binding the witness to that real, SHA-scoped fixture shape.
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
    JOIN public.organizations AS organization ON approval.target_key = organization.id::text
    JOIN public.platform_staff AS requester ON requester.id = approval.requested_by_platform_staff_id
    JOIN public.profiles AS requester_profile ON requester_profile.id = requester.user_id
    LEFT JOIN public.platform_staff AS approver ON approver.id = approval.approved_by_platform_staff_id
    LEFT JOIN public.profiles AS approver_profile ON approver_profile.id = approver.user_id
    WHERE approval.id = p_approval_id
      AND public.product_saas_is_synthetic_organization(organization.id)
      AND approval.action_key IN ('organization.exit.prepare', 'organization.exit.complete')
      AND approval.status IN ('pending', 'approved', 'consumed')
      AND approval.payload ->> 'organization_id' = organization.id::text
      AND approval.payload ->> 'idempotency_key' = 'exit-' || substring(organization.slug FROM 14)
      AND approval.request_id = 'exit:' || split_part(approval.action_key, '.', 3)
        || ':exit-' || substring(organization.slug FROM 14)
      AND requester.staff_ref = 'SAM79-' || left(substring(organization.slug FROM 14), 8) || '-OP'
      AND requester.role_key = 'platform_ops'
      AND requester.status = 'active'
      AND requester_profile.email = organization.slug || '-admin@invalid.test'
      AND (
        (approval.action_key = 'organization.exit.prepare'
          AND approval.payload ->> 'reason' = 'Synthetic customer-approved staging exit verification')
        OR (approval.action_key = 'organization.exit.complete'
          AND approval.payload ->> 'expected_export_sha256' ~ '^[0-9a-f]{64}$'
          AND approval.payload ->> 'backup_evidence_ref' ~ '^staging-backup-[0-9a-f]{40}$'
          AND approval.payload ->> 'customer_confirmation_ref' = 'synthetic-confirmation-' || substring(organization.slug FROM 14)
          AND approval.payload ->> 'retention_basis' = 'synthetic-staging-seven-year-contractual-retention')
      )
      AND (
        (approval.status = 'pending'
          AND approval.approved_by_platform_staff_id IS NULL
          AND approval.approved_at IS NULL
          AND approval.consumption_key IS NULL
          AND approval.consumed_at IS NULL
          AND approval.execution_result IS NULL)
        OR (approval.status = 'approved'
          AND approver.staff_ref = 'SAM79-' || left(substring(organization.slug FROM 14), 8) || '-APP'
          AND approver.role_key = 'platform_owner'
          AND approver.status = 'active'
          AND approver_profile.email = organization.slug || '-boss@invalid.test'
          AND approval.approved_at IS NOT NULL
          AND approval.consumption_key IS NULL
          AND approval.consumed_at IS NULL
          AND approval.execution_result IS NULL)
        OR (approval.status = 'consumed'
          AND approver.staff_ref = 'SAM79-' || left(substring(organization.slug FROM 14), 8) || '-APP'
          AND approver.role_key = 'platform_owner'
          AND approver.status = 'active'
          AND approver_profile.email = organization.slug || '-boss@invalid.test'
          AND approval.approved_at IS NOT NULL
          AND approval.consumption_key = 'exit-' || split_part(approval.action_key, '.', 3)
            || '-' || substring(organization.slug FROM 14)
          AND approval.consumed_at IS NOT NULL
          AND approval.execution_result ->> 'organization_id' = organization.id::text
          AND ((approval.action_key = 'organization.exit.prepare'
              AND approval.execution_result ->> 'status' = 'prepared'
              AND approval.execution_result ->> 'organization_status' = 'read_only')
            OR (approval.action_key = 'organization.exit.complete'
              AND approval.execution_result ->> 'status' = 'completed'
              AND approval.execution_result ->> 'organization_status' = 'closed')))
      )
  )
$$;

REVOKE ALL ON FUNCTION public.product_saas_is_synthetic_exit_approval(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_saas_is_synthetic_exit_approval(uuid)
  TO service_role;

COMMIT;
