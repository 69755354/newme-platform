BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam78_v4_exit_digest_rollback_requires_staging_or_test';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.v4_complete_organization_customer_exit(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_approver_user_id uuid,
  p_idempotency_key text,
  p_expected_export_sha256 text,
  p_backup_evidence_ref text,
  p_customer_confirmation_ref text,
  p_retention_basis text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  RETURN public.complete_organization_customer_exit(
    p_organization_id,
    p_actor_user_id,
    p_approver_user_id,
    p_idempotency_key,
    p_expected_export_sha256,
    p_backup_evidence_ref,
    p_customer_confirmation_ref,
    p_retention_basis,
    p_request_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_complete_organization_customer_exit(
  uuid, uuid, uuid, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
