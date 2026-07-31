-- SAM-23: organization-owned commercial core and deterministic seats.
-- Scope: roles/membership roles, idempotent organization initialization,
-- Quote -> Contract -> Payment -> Project ownership, tasks/documents, and an
-- organization-scoped reporting view. This migration is staging-first and
-- intentionally leaves legacy authorization policies in place as the inner
-- RBAC layer while adding restrictive organization boundaries.

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS plan_key text NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS billable_seat_limit integer NOT NULL DEFAULT 5;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_plan_key_check,
  DROP CONSTRAINT IF EXISTS organizations_billable_seat_limit_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_plan_key_check
    CHECK (plan_key IN ('starter', 'growth', 'scale')),
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

CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL,
  scope text NOT NULL DEFAULT 'organization'
    CHECK (scope IN ('organization', 'platform')),
  display_name text NOT NULL,
  is_billable boolean NOT NULL DEFAULT false,
  can_write_business_data boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_scope_key_unique UNIQUE (scope, role_key),
  CONSTRAINT roles_billable_writer_check
    CHECK (NOT is_billable OR can_write_business_data)
);

CREATE TABLE public.membership_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL
    REFERENCES public.memberships(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE RESTRICT,
  granted_by_membership_id uuid NULL
    REFERENCES public.memberships(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL
);

CREATE UNIQUE INDEX membership_roles_active_unique
  ON public.membership_roles (membership_id, role_id)
  WHERE revoked_at IS NULL;
CREATE INDEX membership_roles_membership_lookup_idx
  ON public.membership_roles (membership_id, revoked_at, role_id);

CREATE TABLE public.organization_provisioning_requests (
  idempotency_key text PRIMARY KEY,
  request_payload jsonb NOT NULL
    CHECK (jsonb_typeof(request_payload) = 'object'),
  organization_id uuid NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  owner_membership_id uuid NULL
    REFERENCES public.memberships(id) ON DELETE RESTRICT,
  result jsonb NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT organization_provisioning_completion_check
    CHECK (
      (completed_at IS NULL AND organization_id IS NULL
        AND owner_membership_id IS NULL AND result IS NULL)
      OR
      (completed_at IS NOT NULL AND organization_id IS NOT NULL
        AND owner_membership_id IS NOT NULL AND result IS NOT NULL)
    )
);

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_provisioning_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.roles FROM anon, authenticated;
REVOKE ALL ON TABLE public.membership_roles FROM anon, authenticated;
REVOKE ALL ON TABLE public.organization_provisioning_requests
  FROM anon, authenticated;
GRANT SELECT ON TABLE public.roles, public.membership_roles TO authenticated;
GRANT ALL ON TABLE
  public.roles,
  public.membership_roles,
  public.organization_provisioning_requests
TO service_role;

CREATE POLICY sam23_roles_organization_catalog_read
  ON public.roles
  FOR SELECT
  TO authenticated
  USING (scope = 'organization');

CREATE POLICY sam23_membership_roles_organization_read
  ON public.membership_roles
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.memberships target_membership
      JOIN public.memberships caller_membership
        ON caller_membership.organization_id =
          target_membership.organization_id
       AND caller_membership.user_id = (SELECT auth.uid())
       AND caller_membership.status = 'active'
       AND caller_membership.accepted_at IS NOT NULL
      WHERE target_membership.id = membership_roles.membership_id
    )
  );

INSERT INTO public.roles (
  role_key,
  scope,
  display_name,
  is_billable,
  can_write_business_data
)
VALUES
  ('org_owner', 'organization', 'Organization owner', true, true),
  ('org_admin', 'organization', 'Organization administrator', true, true),
  ('manager', 'organization', 'Manager', true, true),
  ('sales_agent', 'organization', 'Sales agent', true, true),
  ('operations', 'organization', 'Operations', true, true),
  ('finance', 'organization', 'Finance', true, true),
  ('specialist', 'organization', 'Specialist', true, true),
  ('viewer', 'organization', 'Viewer', false, false),
  ('portal_user', 'organization', 'Portal user', false, false)
ON CONFLICT (scope, role_key) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  is_billable = EXCLUDED.is_billable,
  can_write_business_data = EXCLUDED.can_write_business_data;

INSERT INTO public.membership_roles (membership_id, role_id)
SELECT membership.id, role.id
FROM public.memberships membership
JOIN public.profiles profile ON profile.id = membership.user_id
JOIN public.roles role
  ON role.scope = 'organization'
 AND role.role_key = CASE profile.role
   WHEN 'boss' THEN 'org_owner'
   WHEN 'admin' THEN 'org_admin'
   WHEN 'operator' THEN 'operations'
   WHEN 'sales' THEN 'sales_agent'
   WHEN 'finance' THEN 'finance'
   WHEN 'designer' THEN 'specialist'
   ELSE NULL
 END
WHERE role.role_key IS NOT NULL
ON CONFLICT (membership_id, role_id) WHERE revoked_at IS NULL DO NOTHING;

-- Existing organizations receive the smallest plan that can hold their
-- deterministic active, accepted, billable membership count. This prevents
-- legacy tenants from becoming over-limit while preserving the published
-- Starter/Growth/Scale seat boundaries.
WITH seat_counts AS (
  SELECT
    membership.organization_id,
    count(DISTINCT membership.id)::integer AS seat_count
  FROM public.memberships membership
  JOIN public.membership_roles membership_role
    ON membership_role.membership_id = membership.id
   AND membership_role.revoked_at IS NULL
  JOIN public.roles role
    ON role.id = membership_role.role_id
   AND role.scope = 'organization'
   AND role.is_billable IS TRUE
  WHERE membership.status = 'active'
    AND membership.accepted_at IS NOT NULL
  GROUP BY membership.organization_id
)
UPDATE public.organizations organization
SET
  plan_key = CASE
    WHEN COALESCE(seat_counts.seat_count, 0) <= 5 THEN 'starter'
    WHEN seat_counts.seat_count <= 20 THEN 'growth'
    ELSE 'scale'
  END,
  billable_seat_limit = CASE
    WHEN COALESCE(seat_counts.seat_count, 0) <= 5 THEN 5
    WHEN seat_counts.seat_count <= 20 THEN 20
    ELSE GREATEST(50, CEIL(seat_counts.seat_count / 5.0)::integer * 5)
  END
FROM seat_counts
WHERE organization.id = seat_counts.organization_id;

CREATE OR REPLACE FUNCTION public.organization_billable_seat_count(
  p_organization_id uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  caller_id uuid := auth.uid();
  caller_role text := current_setting('role', true);
  seat_count integer;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'organization_id_required';
  END IF;

  IF caller_role <> 'service_role' AND (
    caller_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.memberships caller_membership
      WHERE caller_membership.organization_id = p_organization_id
        AND caller_membership.user_id = caller_id
        AND caller_membership.status = 'active'
        AND caller_membership.accepted_at IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active_organization_membership_required';
  END IF;

  SELECT count(*)::integer
  INTO seat_count
  FROM public.memberships membership
  WHERE membership.organization_id = p_organization_id
    AND membership.status = 'active'
    AND membership.accepted_at IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.membership_roles membership_role
      JOIN public.roles role ON role.id = membership_role.role_id
      WHERE membership_role.membership_id = membership.id
        AND membership_role.revoked_at IS NULL
        AND role.scope = 'organization'
        AND role.is_billable IS TRUE
        AND role.can_write_business_data IS TRUE
    );

  RETURN seat_count;
END;
$$;

REVOKE ALL ON FUNCTION public.organization_billable_seat_count(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organization_billable_seat_count(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sam23_enforce_billable_seat_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_membership_id uuid;
  target_organization_id uuid;
  target_role_id uuid;
  will_be_active boolean;
  already_billable boolean;
  role_is_billable boolean;
  current_seats integer;
  seat_limit integer;
BEGIN
  IF TG_TABLE_NAME = 'memberships' THEN
    target_membership_id := NEW.id;
    target_organization_id := NEW.organization_id;
    will_be_active :=
      NEW.status = 'active' AND NEW.accepted_at IS NOT NULL;
    IF NOT will_be_active OR (
      TG_OP = 'UPDATE'
      AND OLD.status = 'active'
      AND OLD.accepted_at IS NOT NULL
    ) THEN
      RETURN NEW;
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.membership_roles membership_role
      JOIN public.roles role ON role.id = membership_role.role_id
      WHERE membership_role.membership_id = NEW.id
        AND membership_role.revoked_at IS NULL
        AND role.scope = 'organization'
        AND role.is_billable IS TRUE
        AND role.can_write_business_data IS TRUE
    )
    INTO role_is_billable;
  ELSE
    target_membership_id := NEW.membership_id;
    target_role_id := NEW.role_id;
    SELECT membership.organization_id,
           membership.status = 'active'
             AND membership.accepted_at IS NOT NULL
    INTO target_organization_id, will_be_active
    FROM public.memberships membership
    WHERE membership.id = target_membership_id;
    IF target_organization_id IS NULL THEN
      RAISE EXCEPTION 'sam23_membership_role_membership_missing';
    END IF;

    SELECT role.scope = 'organization'
             AND role.is_billable IS TRUE
             AND role.can_write_business_data IS TRUE
    INTO role_is_billable
    FROM public.roles role
    WHERE role.id = target_role_id;
    IF role_is_billable IS NULL THEN
      RAISE EXCEPTION 'sam23_membership_role_role_missing';
    END IF;

    IF NEW.revoked_at IS NOT NULL OR NOT will_be_active
      OR NOT role_is_billable
    THEN
      RETURN NEW;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.membership_roles membership_role
      JOIN public.roles role ON role.id = membership_role.role_id
      WHERE membership_role.membership_id = target_membership_id
        AND membership_role.revoked_at IS NULL
        AND role.scope = 'organization'
        AND role.is_billable IS TRUE
        AND role.can_write_business_data IS TRUE
        AND (
          TG_OP = 'INSERT'
          OR membership_role.id <> NEW.id
        )
    )
    INTO already_billable;
    IF already_billable THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NOT COALESCE(role_is_billable, false) THEN
    RETURN NEW;
  END IF;

  SELECT organization.billable_seat_limit
  INTO seat_limit
  FROM public.organizations organization
  WHERE organization.id = target_organization_id
  FOR UPDATE;
  IF seat_limit IS NULL THEN
    RAISE EXCEPTION 'sam23_seat_organization_missing';
  END IF;

  SELECT count(*)::integer
  INTO current_seats
  FROM public.memberships membership
  WHERE membership.organization_id = target_organization_id
    AND membership.status = 'active'
    AND membership.accepted_at IS NOT NULL
    AND membership.id <> target_membership_id
    AND EXISTS (
      SELECT 1
      FROM public.membership_roles membership_role
      JOIN public.roles role ON role.id = membership_role.role_id
      WHERE membership_role.membership_id = membership.id
        AND membership_role.revoked_at IS NULL
        AND role.scope = 'organization'
        AND role.is_billable IS TRUE
        AND role.can_write_business_data IS TRUE
    );

  IF current_seats >= seat_limit THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billable_seat_limit_reached',
      DETAIL = format(
        'organization=%s current=%s limit=%s',
        target_organization_id,
        current_seats,
        seat_limit
      );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sam23_enforce_billable_seat_limit()
  FROM PUBLIC;

CREATE TRIGGER sam23_membership_seat_limit
  BEFORE INSERT OR UPDATE OF status, accepted_at
  ON public.memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.sam23_enforce_billable_seat_limit();

CREATE TRIGGER sam23_membership_role_seat_limit
  BEFORE INSERT OR UPDATE OF role_id, revoked_at
  ON public.membership_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.sam23_enforce_billable_seat_limit();

CREATE OR REPLACE FUNCTION public.sam23_enforce_membership_role_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  membership_organization_id uuid;
  grantor_organization_id uuid;
  role_scope text;
BEGIN
  SELECT membership.organization_id
  INTO membership_organization_id
  FROM public.memberships membership
  WHERE membership.id = NEW.membership_id;

  SELECT role.scope
  INTO role_scope
  FROM public.roles role
  WHERE role.id = NEW.role_id;

  IF membership_organization_id IS NULL OR role_scope <> 'organization' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'organization_membership_role_required';
  END IF;

  IF NEW.granted_by_membership_id IS NOT NULL THEN
    SELECT membership.organization_id
    INTO grantor_organization_id
    FROM public.memberships membership
    WHERE membership.id = NEW.granted_by_membership_id
      AND membership.status = 'active'
      AND membership.accepted_at IS NOT NULL;
    IF grantor_organization_id IS DISTINCT FROM membership_organization_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'membership_role_cross_organization_grant';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sam23_enforce_membership_role_scope()
  FROM PUBLIC;

CREATE TRIGGER sam23_membership_role_scope
  BEFORE INSERT OR UPDATE OF membership_id, role_id, granted_by_membership_id
  ON public.membership_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.sam23_enforce_membership_role_scope();

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
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service_role_required';
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
    idempotency_key,
    request_payload
  )
  VALUES (normalized_key, payload)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING idempotency_key INTO inserted_key;

  SELECT *
  INTO existing_request
  FROM public.organization_provisioning_requests request
  WHERE request.idempotency_key = normalized_key
  FOR UPDATE;

  IF existing_request.request_payload IS DISTINCT FROM payload THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'organization_idempotency_payload_mismatch';
  END IF;

  IF inserted_key IS NULL THEN
    IF existing_request.completed_at IS NULL OR existing_request.result IS NULL THEN
      RAISE EXCEPTION 'organization_initialization_incomplete';
    END IF;
    RETURN existing_request.result;
  END IF;

  INSERT INTO public.organizations (
    id,
    slug,
    name,
    industry_key,
    status,
    data_region,
    timezone,
    plan_key,
    billable_seat_limit,
    created_by
  )
  VALUES (
    new_organization_id,
    normalized_slug,
    normalized_name,
    p_industry_key,
    'active',
    'uae',
    'Asia/Dubai',
    p_plan_key,
    p_billable_seat_limit,
    p_owner_user_id
  );

  INSERT INTO public.memberships (
    id,
    organization_id,
    user_id,
    status,
    invited_at,
    accepted_at
  )
  VALUES (
    new_owner_membership_id,
    new_organization_id,
    p_owner_user_id,
    'active',
    now(),
    now()
  );

  SELECT role.id
  INTO owner_role_id
  FROM public.roles role
  WHERE role.scope = 'organization'
    AND role.role_key = 'org_owner';
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
    organization_id,
    actor_user_id,
    action,
    target_type,
    target_id,
    outcome,
    reason,
    request_id,
    metadata
  )
  VALUES (
    new_organization_id,
    p_owner_user_id,
    'organization_initialized',
    'organization',
    new_organization_id::text,
    'success',
    'parameterized_idempotent_initialization',
    normalized_key,
    jsonb_build_object(
      'industry_key', p_industry_key,
      'plan_key', p_plan_key,
      'billable_seat_limit', p_billable_seat_limit
    )
  );

  UPDATE public.organization_provisioning_requests
  SET
    organization_id = new_organization_id,
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

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'quotations',
    'contracts',
    'contract_approvals',
    'installment_plans',
    'payments',
    'payment_allocations',
    'projects',
    'tasks',
    'lead_documents'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'SAM-23 required commercial table is missing: %',
        table_name;
    END IF;
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS organization_id uuid',
      table_name
    );
  END LOOP;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.quotations quotation
    LEFT JOIN public.leads lead_row ON lead_row.id = quotation.lead_id
    LEFT JOIN public.contracts contract ON contract.id = quotation.contract_id
    WHERE lead_row.id IS NULL
      OR (
        quotation.contract_id IS NOT NULL
        AND (
          contract.id IS NULL
          OR contract.lead_id <> quotation.lead_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'sam23_quotation_parent_missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.contracts contract
    LEFT JOIN public.leads lead_row ON lead_row.id = contract.lead_id
    LEFT JOIN public.quotations quotation
      ON quotation.id = contract.quotation_id
    WHERE lead_row.id IS NULL
      OR (
        contract.quotation_id IS NOT NULL
        AND (
          quotation.id IS NULL
          OR quotation.lead_id <> contract.lead_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'sam23_contract_parent_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.installment_plans plan
    LEFT JOIN public.contracts contract ON contract.id = plan.contract_id
    WHERE contract.id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.payments payment
    LEFT JOIN public.contracts contract ON contract.id = payment.contract_id
    LEFT JOIN public.installment_plans plan
      ON plan.id = payment.installment_plan_id
    WHERE contract.id IS NULL
      OR (
        payment.installment_plan_id IS NOT NULL
        AND (
          plan.id IS NULL
          OR plan.contract_id <> payment.contract_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'sam23_payment_parent_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.contract_approvals approval
    LEFT JOIN public.contracts contract ON contract.id = approval.contract_id
    WHERE contract.id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.payment_allocations allocation
    LEFT JOIN public.payments payment ON payment.id = allocation.payment_id
    LEFT JOIN public.installment_plans plan ON plan.id = allocation.plan_id
    WHERE payment.id IS NULL
      OR plan.id IS NULL
      OR payment.contract_id <> plan.contract_id
  ) THEN
    RAISE EXCEPTION 'sam23_commercial_child_parent_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.projects project
    LEFT JOIN public.leads lead_row ON lead_row.id = project.lead_id
    LEFT JOIN public.contracts contract ON contract.id = project.contract_id
    WHERE (project.lead_id IS NULL AND project.contract_id IS NULL)
      OR (project.lead_id IS NOT NULL AND lead_row.id IS NULL)
      OR (project.contract_id IS NOT NULL AND contract.id IS NULL)
      OR (
        lead_row.id IS NOT NULL
        AND contract.id IS NOT NULL
        AND contract.lead_id <> lead_row.id
      )
  ) THEN
    RAISE EXCEPTION 'sam23_project_parent_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tasks task
    LEFT JOIN public.leads lead_row ON lead_row.id = task.lead_id
    WHERE lead_row.id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.lead_documents document
    LEFT JOIN public.leads lead_row ON lead_row.id = document.lead_id
    WHERE lead_row.id IS NULL
  ) THEN
    RAISE EXCEPTION 'sam23_lead_child_parent_missing';
  END IF;
END
$$;

UPDATE public.quotations quotation
SET organization_id = lead_row.organization_id
FROM public.leads lead_row
WHERE lead_row.id = quotation.lead_id;

UPDATE public.contracts contract
SET organization_id = lead_row.organization_id
FROM public.leads lead_row
WHERE lead_row.id = contract.lead_id;

UPDATE public.installment_plans plan
SET organization_id = contract.organization_id
FROM public.contracts contract
WHERE contract.id = plan.contract_id;

UPDATE public.payments payment
SET organization_id = contract.organization_id
FROM public.contracts contract
WHERE contract.id = payment.contract_id;

UPDATE public.contract_approvals approval
SET
  organization_id = contract.organization_id,
  tenant_id = contract.organization_id
FROM public.contracts contract
WHERE contract.id = approval.contract_id;

UPDATE public.payment_allocations allocation
SET
  organization_id = payment.organization_id,
  tenant_id = payment.organization_id
FROM public.payments payment
WHERE payment.id = allocation.payment_id;

UPDATE public.projects project
SET organization_id = COALESCE(
  (
    SELECT contract.organization_id
    FROM public.contracts contract
    WHERE contract.id = project.contract_id
  ),
  (
    SELECT lead_row.organization_id
    FROM public.leads lead_row
    WHERE lead_row.id = project.lead_id
  )
);

UPDATE public.tasks task
SET organization_id = lead_row.organization_id
FROM public.leads lead_row
WHERE lead_row.id = task.lead_id;

UPDATE public.lead_documents document
SET organization_id = lead_row.organization_id
FROM public.leads lead_row
WHERE lead_row.id = document.lead_id;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'quotations',
    'contracts',
    'contract_approvals',
    'installment_plans',
    'payments',
    'payment_allocations',
    'projects',
    'tasks',
    'lead_documents'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE public.%I
         ADD CONSTRAINT %I
         FOREIGN KEY (organization_id)
         REFERENCES public.organizations(id)
         ON DELETE RESTRICT
         NOT VALID',
      table_name,
      table_name || '_organization_id_fkey'
    );
    EXECUTE format(
      'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
      table_name,
      table_name || '_organization_id_fkey'
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX %I ON public.%I (organization_id, id)',
      table_name || '_organization_id_id_unique',
      table_name
    );
    EXECUTE format(
      'CREATE INDEX %I ON public.%I (organization_id)',
      table_name || '_organization_lookup_idx',
      table_name
    );
  END LOOP;
END
$$;

ALTER TABLE public.quotations
  DROP CONSTRAINT IF EXISTS quotations_quote_no_key;
ALTER TABLE public.contracts
  DROP CONSTRAINT IF EXISTS contracts_contract_no_key;
CREATE UNIQUE INDEX quotations_organization_quote_no_unique
  ON public.quotations (organization_id, quote_no);
CREATE UNIQUE INDEX contracts_organization_contract_no_unique
  ON public.contracts (organization_id, contract_no);
CREATE UNIQUE INDEX installment_plans_organization_contract_seq_unique
  ON public.installment_plans (organization_id, contract_id, seq);

ALTER TABLE public.quotations
  ADD CONSTRAINT quotations_organization_lead_fkey
  FOREIGN KEY (organization_id, lead_id)
  REFERENCES public.leads (organization_id, id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT quotations_organization_contract_fkey
  FOREIGN KEY (organization_id, contract_id)
  REFERENCES public.contracts (organization_id, id)
  ON DELETE RESTRICT;
ALTER TABLE public.contracts
  ADD CONSTRAINT contracts_organization_lead_fkey
  FOREIGN KEY (organization_id, lead_id)
  REFERENCES public.leads (organization_id, id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT contracts_organization_quotation_fkey
  FOREIGN KEY (organization_id, quotation_id)
  REFERENCES public.quotations (organization_id, id)
  ON DELETE RESTRICT;
ALTER TABLE public.installment_plans
  ADD CONSTRAINT installment_plans_organization_contract_fkey
  FOREIGN KEY (organization_id, contract_id)
  REFERENCES public.contracts (organization_id, id)
  ON DELETE CASCADE;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_organization_contract_fkey
  FOREIGN KEY (organization_id, contract_id)
  REFERENCES public.contracts (organization_id, id)
  ON DELETE CASCADE,
  ADD CONSTRAINT payments_organization_installment_fkey
  FOREIGN KEY (organization_id, installment_plan_id)
  REFERENCES public.installment_plans (organization_id, id)
  ON DELETE RESTRICT;
ALTER TABLE public.contract_approvals
  ADD CONSTRAINT contract_approvals_organization_contract_fkey
  FOREIGN KEY (organization_id, contract_id)
  REFERENCES public.contracts (organization_id, id)
  ON DELETE CASCADE;
ALTER TABLE public.payment_allocations
  ADD CONSTRAINT payment_allocations_organization_payment_fkey
  FOREIGN KEY (organization_id, payment_id)
  REFERENCES public.payments (organization_id, id)
  ON DELETE CASCADE,
  ADD CONSTRAINT payment_allocations_organization_plan_fkey
  FOREIGN KEY (organization_id, plan_id)
  REFERENCES public.installment_plans (organization_id, id)
  ON DELETE CASCADE;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_organization_parent_required
  CHECK (lead_id IS NOT NULL OR contract_id IS NOT NULL),
  ADD CONSTRAINT projects_organization_lead_fkey
  FOREIGN KEY (organization_id, lead_id)
  REFERENCES public.leads (organization_id, id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT projects_organization_contract_fkey
  FOREIGN KEY (organization_id, contract_id)
  REFERENCES public.contracts (organization_id, id)
  ON DELETE RESTRICT;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_organization_lead_fkey
  FOREIGN KEY (organization_id, lead_id)
  REFERENCES public.leads (organization_id, id)
  ON DELETE CASCADE;
ALTER TABLE public.lead_documents
  ADD CONSTRAINT lead_documents_organization_lead_fkey
  FOREIGN KEY (organization_id, lead_id)
  REFERENCES public.leads (organization_id, id)
  ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.sam23_assign_commercial_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  primary_parent_id uuid;
  secondary_parent_id uuid;
  expected_organization_id uuid;
  secondary_organization_id uuid;
  assignee_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'quotations' THEN
      primary_parent_id := NULLIF(row_data ->> 'lead_id', '')::uuid;
      secondary_parent_id := NULLIF(row_data ->> 'contract_id', '')::uuid;
      SELECT lead_row.organization_id INTO expected_organization_id
      FROM public.leads lead_row WHERE lead_row.id = primary_parent_id;
      IF secondary_parent_id IS NOT NULL THEN
        SELECT contract.organization_id INTO secondary_organization_id
        FROM public.contracts contract
        WHERE contract.id = secondary_parent_id;
      END IF;
    WHEN 'contracts' THEN
      primary_parent_id := NULLIF(row_data ->> 'lead_id', '')::uuid;
      secondary_parent_id := NULLIF(row_data ->> 'quotation_id', '')::uuid;
      SELECT lead_row.organization_id INTO expected_organization_id
      FROM public.leads lead_row WHERE lead_row.id = primary_parent_id;
      IF secondary_parent_id IS NOT NULL THEN
        SELECT quotation.organization_id INTO secondary_organization_id
        FROM public.quotations quotation
        WHERE quotation.id = secondary_parent_id;
      END IF;
    WHEN 'installment_plans', 'contract_approvals' THEN
      primary_parent_id := NULLIF(row_data ->> 'contract_id', '')::uuid;
      SELECT contract.organization_id INTO expected_organization_id
      FROM public.contracts contract WHERE contract.id = primary_parent_id;
    WHEN 'payments' THEN
      primary_parent_id := NULLIF(row_data ->> 'contract_id', '')::uuid;
      secondary_parent_id :=
        NULLIF(row_data ->> 'installment_plan_id', '')::uuid;
      SELECT contract.organization_id INTO expected_organization_id
      FROM public.contracts contract WHERE contract.id = primary_parent_id;
      IF secondary_parent_id IS NOT NULL THEN
        SELECT plan.organization_id INTO secondary_organization_id
        FROM public.installment_plans plan
        WHERE plan.id = secondary_parent_id;
      END IF;
    WHEN 'payment_allocations' THEN
      primary_parent_id := NULLIF(row_data ->> 'payment_id', '')::uuid;
      secondary_parent_id := NULLIF(row_data ->> 'plan_id', '')::uuid;
      SELECT payment.organization_id INTO expected_organization_id
      FROM public.payments payment WHERE payment.id = primary_parent_id;
      SELECT plan.organization_id INTO secondary_organization_id
      FROM public.installment_plans plan WHERE plan.id = secondary_parent_id;
    WHEN 'projects' THEN
      primary_parent_id := NULLIF(row_data ->> 'contract_id', '')::uuid;
      secondary_parent_id := NULLIF(row_data ->> 'lead_id', '')::uuid;
      IF primary_parent_id IS NOT NULL THEN
        SELECT contract.organization_id INTO expected_organization_id
        FROM public.contracts contract WHERE contract.id = primary_parent_id;
      END IF;
      IF secondary_parent_id IS NOT NULL THEN
        SELECT lead_row.organization_id INTO secondary_organization_id
        FROM public.leads lead_row WHERE lead_row.id = secondary_parent_id;
      END IF;
      IF expected_organization_id IS NULL THEN
        expected_organization_id := secondary_organization_id;
        secondary_organization_id := NULL;
      END IF;
    WHEN 'tasks', 'lead_documents' THEN
      primary_parent_id := NULLIF(row_data ->> 'lead_id', '')::uuid;
      SELECT lead_row.organization_id INTO expected_organization_id
      FROM public.leads lead_row WHERE lead_row.id = primary_parent_id;
    ELSE
      RAISE EXCEPTION 'sam23_unsupported_commercial_table:%', TG_TABLE_NAME;
  END CASE;

  IF expected_organization_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'commercial_parent_organization_missing';
  END IF;
  IF secondary_parent_id IS NOT NULL
    AND secondary_organization_id IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'commercial_secondary_parent_missing';
  END IF;
  IF secondary_organization_id IS NOT NULL
    AND secondary_organization_id <> expected_organization_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial_cross_organization_parent';
  END IF;

  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := expected_organization_id;
  ELSIF NEW.organization_id <> expected_organization_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial_organization_parent_mismatch';
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.organization_id IS DISTINCT FROM OLD.organization_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial_organization_is_immutable';
  END IF;

  IF TG_TABLE_NAME IN ('contract_approvals', 'payment_allocations') THEN
    NEW.tenant_id := expected_organization_id;
  END IF;

  IF TG_TABLE_NAME = 'tasks' THEN
    assignee_id := NULLIF(row_data ->> 'assignee_id', '')::uuid;
    IF assignee_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.memberships membership
      WHERE membership.organization_id = expected_organization_id
        AND membership.user_id = assignee_id
        AND membership.status = 'active'
        AND membership.accepted_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'task_assignee_active_organization_membership_required';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sam23_assign_commercial_organization()
  FROM PUBLIC;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'quotations',
    'contracts',
    'contract_approvals',
    'installment_plans',
    'payments',
    'payment_allocations',
    'projects',
    'tasks',
    'lead_documents'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS sam23_assign_commercial_organization
         ON public.%I',
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER sam23_assign_commercial_organization
         BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW
         EXECUTE FUNCTION public.sam23_assign_commercial_organization()',
      table_name
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'DROP POLICY IF EXISTS sam23_%I_organization_boundary ON public.%I',
      table_name,
      table_name
    );
    EXECUTE format(
      'CREATE POLICY sam23_%I_organization_boundary
         ON public.%I
         AS RESTRICTIVE
         FOR ALL
         TO authenticated
         USING (
           organization_id = (SELECT public.requested_organization_id())
           AND EXISTS (
             SELECT 1
             FROM public.memberships membership
             WHERE membership.organization_id = %I.organization_id
               AND membership.user_id = (SELECT auth.uid())
               AND membership.status = ''active''
               AND membership.accepted_at IS NOT NULL
           )
         )
         WITH CHECK (
           organization_id = (SELECT public.requested_organization_id())
           AND EXISTS (
             SELECT 1
             FROM public.memberships membership
             WHERE membership.organization_id = %I.organization_id
               AND membership.user_id = (SELECT auth.uid())
               AND membership.status = ''active''
               AND membership.accepted_at IS NOT NULL
           )
         )',
      table_name,
      table_name,
      table_name,
      table_name
    );
  END LOOP;
END
$$;

CREATE OR REPLACE VIEW public.v_sam23_organization_commercial_summary
WITH (security_invoker = true)
AS
SELECT
  organization.id AS organization_id,
  (
    SELECT count(*)::bigint
    FROM public.quotations quotation
    WHERE quotation.organization_id = organization.id
  ) AS quotation_count,
  (
    SELECT count(*)::bigint
    FROM public.contracts contract
    WHERE contract.organization_id = organization.id
  ) AS contract_count,
  (
    SELECT COALESCE(sum(payment.amount), 0)::numeric
    FROM public.payments payment
    WHERE payment.organization_id = organization.id
      AND payment.confirmed IS TRUE
  ) AS confirmed_payment_amount,
  (
    SELECT count(*)::bigint
    FROM public.projects project
    WHERE project.organization_id = organization.id
  ) AS project_count,
  (
    SELECT count(*)::bigint
    FROM public.tasks task
    WHERE task.organization_id = organization.id
  ) AS task_count,
  (
    SELECT count(*)::bigint
    FROM public.lead_documents document
    WHERE document.organization_id = organization.id
  ) AS document_count
FROM public.organizations organization
WHERE organization.id = public.requested_organization_id();

REVOKE ALL ON TABLE public.v_sam23_organization_commercial_summary
  FROM anon;
GRANT SELECT ON TABLE public.v_sam23_organization_commercial_summary
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
