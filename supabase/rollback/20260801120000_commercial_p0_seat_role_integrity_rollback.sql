\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_setting('newme.environment', true) IS NULL
    OR current_setting('newme.environment', true) NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION 'commercial_p0_rollback_requires_staging_or_test';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.organizations organization
    WHERE NOT (
      (organization.plan_key = 'starter' AND organization.billable_seat_limit = 5)
      OR (organization.plan_key = 'growth' AND organization.billable_seat_limit = 20)
      OR (
        organization.plan_key = 'scale'
        AND organization.billable_seat_limit >= 50
        AND organization.billable_seat_limit % 5 = 0
      )
    )
  ) THEN
    RAISE EXCEPTION 'commercial_p0_seat_tier_rollback_incompatible';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.provision_organization_member(
  uuid, uuid, text, uuid, text
);

ALTER TABLE public.organizations
  ALTER COLUMN billable_seat_limit SET DEFAULT 5,
  DROP CONSTRAINT IF EXISTS organizations_billable_seat_limit_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_billable_seat_limit_check
    CHECK (
      (plan_key = 'starter' AND billable_seat_limit = 5)
      OR (plan_key = 'growth' AND billable_seat_limit = 20)
      OR (
        plan_key = 'scale'
        AND billable_seat_limit >= 50
        AND billable_seat_limit % 5 = 0
      )
    );

CREATE OR REPLACE FUNCTION public.initialize_organization(
  p_idempotency_key text,
  p_slug text,
  p_name text,
  p_industry_key text,
  p_plan_key text,
  p_billable_seat_limit integer,
  p_owner_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  normalized_key text := lower(trim(p_idempotency_key));
  normalized_slug text := lower(trim(p_slug));
  normalized_name text := trim(p_name);
  payload jsonb;
  existing_request public.organization_provisioning_requests%ROWTYPE;
  inserted_key text;
  new_organization_id uuid := gen_random_uuid();
  new_owner_membership_id uuid := gen_random_uuid();
  owner_role_id uuid;
  response jsonb;
BEGIN
  IF current_setting('role', true) <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF normalized_key !~ '^[a-z0-9][a-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'invalid_organization_idempotency_key';
  END IF;
  IF normalized_slug !~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$' THEN
    RAISE EXCEPTION 'invalid_organization_slug';
  END IF;
  IF length(normalized_name) < 2 OR length(normalized_name) > 160 THEN
    RAISE EXCEPTION 'invalid_organization_name';
  END IF;
  IF p_industry_key NOT IN ('real_estate', 'retail') THEN
    RAISE EXCEPTION 'invalid_organization_industry';
  END IF;
  IF NOT (
    (p_plan_key = 'starter' AND p_billable_seat_limit = 5)
    OR (p_plan_key = 'growth' AND p_billable_seat_limit = 20)
    OR (
      p_plan_key = 'scale'
      AND p_billable_seat_limit >= 50
      AND p_billable_seat_limit % 5 = 0
    )
  ) THEN
    RAISE EXCEPTION 'invalid_organization_plan_seat_limit';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM auth.users auth_user
    JOIN public.profiles profile ON profile.id = auth_user.id
    WHERE auth_user.id = p_owner_user_id
      AND profile.is_active IS TRUE
  ) THEN
    RAISE EXCEPTION 'active_owner_profile_required';
  END IF;

  payload := jsonb_build_object(
    'slug', normalized_slug,
    'name', normalized_name,
    'industry_key', p_industry_key,
    'plan_key', p_plan_key,
    'billable_seat_limit', p_billable_seat_limit,
    'owner_user_id', p_owner_user_id
  );

  INSERT INTO public.organization_provisioning_requests (
    idempotency_key, request_payload
  ) VALUES (normalized_key, payload)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING idempotency_key INTO inserted_key;

  SELECT * INTO existing_request
  FROM public.organization_provisioning_requests request
  WHERE request.idempotency_key = normalized_key
  FOR UPDATE;

  IF existing_request.request_payload IS DISTINCT FROM payload THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505', MESSAGE = 'organization_idempotency_payload_mismatch';
  END IF;
  IF inserted_key IS NULL THEN
    IF existing_request.completed_at IS NULL OR existing_request.result IS NULL THEN
      RAISE EXCEPTION 'organization_initialization_incomplete';
    END IF;
    RETURN existing_request.result;
  END IF;

  INSERT INTO public.organizations (
    id, slug, name, industry_key, status, data_region, timezone,
    plan_key, billable_seat_limit, created_by
  ) VALUES (
    new_organization_id, normalized_slug, normalized_name, p_industry_key,
    'active', 'uae', 'Asia/Dubai', p_plan_key, p_billable_seat_limit,
    p_owner_user_id
  );

  INSERT INTO public.memberships (
    id, organization_id, user_id, status, invited_at, accepted_at
  ) VALUES (
    new_owner_membership_id, new_organization_id, p_owner_user_id,
    'active', now(), now()
  );

  SELECT role.id INTO owner_role_id
  FROM public.roles role
  WHERE role.scope = 'organization' AND role.role_key = 'org_owner';
  IF owner_role_id IS NULL THEN
    RAISE EXCEPTION 'organization_owner_role_missing';
  END IF;

  INSERT INTO public.membership_roles (membership_id, role_id)
  VALUES (new_owner_membership_id, owner_role_id);

  response := jsonb_build_object(
    'organization_id', new_organization_id,
    'owner_membership_id', new_owner_membership_id,
    'plan_key', p_plan_key,
    'billable_seat_limit', p_billable_seat_limit,
    'billable_seat_count', 1
  );

  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    new_organization_id, p_owner_user_id, 'organization_initialized',
    'organization', new_organization_id::text, 'success',
    'parameterized_idempotent_initialization', normalized_key,
    jsonb_build_object(
      'industry_key', p_industry_key,
      'plan_key', p_plan_key,
      'billable_seat_limit', p_billable_seat_limit
    )
  );

  UPDATE public.organization_provisioning_requests
  SET organization_id = new_organization_id,
      owner_membership_id = new_owner_membership_id,
      result = response,
      completed_at = now()
  WHERE idempotency_key = normalized_key;
  RETURN response;
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_organization(
  text, text, text, text, text, integer, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_organization(
  text, text, text, text, text, integer, uuid
) TO service_role;

COMMIT;
