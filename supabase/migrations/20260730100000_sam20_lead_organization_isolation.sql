-- SAM-20: Lead vertical-slice organization isolation prototype.
-- This migration follows the SAM-19 phased model: it adds the tenant boundary,
-- backfills the existing single-tenant data into one Legacy organization, and
-- keeps the existing profile.role authorization rules as the inner RBAC layer.
-- It does not copy production data and must not be applied to production in the
-- staging-only delivery window.

BEGIN;

CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  industry_key text NOT NULL CHECK (industry_key IN ('real_estate', 'retail')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('provisioning', 'active', 'read_only', 'suspended', 'closed')),
  data_region text NOT NULL DEFAULT 'uae',
  timezone text NOT NULL DEFAULT 'Asia/Dubai',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz NULL,
  CONSTRAINT organizations_closed_state_check
    CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_lower_unique
  ON public.organizations (lower(slug));

CREATE TABLE IF NOT EXISTS public.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'inactive', 'suspended')),
  invited_by_membership_id uuid NULL
    REFERENCES public.memberships(id) ON DELETE SET NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz NULL,
  deactivated_at timestamptz NULL,
  recovery_deadline timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT memberships_organization_user_unique
    UNIQUE (organization_id, user_id),
  CONSTRAINT memberships_active_accepted_check
    CHECK (status <> 'active' OR accepted_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS memberships_user_status_idx
  ON public.memberships (user_id, status, organization_id);

CREATE TABLE IF NOT EXISTS public.platform_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'offboarded')),
  staff_ref text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  offboarded_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS public.support_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  platform_staff_id uuid NOT NULL
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  ticket_ref text NOT NULL,
  reason text NOT NULL,
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'array'),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'active', 'expired', 'revoked', 'denied')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by_platform_staff_id uuid NULL
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  approved_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_sessions_max_duration_check
    CHECK (
      expires_at > requested_at
      AND expires_at <= requested_at + interval '4 hours'
    ),
  CONSTRAINT support_sessions_active_approval_check
    CHECK (
      status NOT IN ('approved', 'active')
      OR (
        approved_by_platform_staff_id IS NOT NULL
        AND approved_at IS NOT NULL
        AND approved_by_platform_staff_id <> platform_staff_id
      )
    )
);

CREATE INDEX IF NOT EXISTS support_sessions_active_lookup_idx
  ON public.support_sessions (id, organization_id, platform_staff_id, expires_at)
  WHERE status = 'active' AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_platform_staff_id uuid NULL
    REFERENCES public.platform_staff(id) ON DELETE SET NULL,
  support_session_id uuid NULL
    REFERENCES public.support_sessions(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  reason text NULL,
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_org_occurred_idx
  ON public.audit_events (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_support_session_idx
  ON public.audit_events (support_session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_request_idx
  ON public.audit_events (request_id);

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.organizations FROM anon, authenticated;
REVOKE ALL ON TABLE public.memberships FROM anon, authenticated;
REVOKE ALL ON TABLE public.platform_staff FROM anon, authenticated;
REVOKE ALL ON TABLE public.support_sessions FROM anon, authenticated;
REVOKE ALL ON TABLE public.audit_events FROM anon, authenticated;

GRANT SELECT ON TABLE public.organizations TO authenticated;
GRANT SELECT ON TABLE public.memberships TO authenticated;
GRANT ALL ON TABLE public.organizations TO service_role;
GRANT ALL ON TABLE public.memberships TO service_role;
GRANT ALL ON TABLE public.platform_staff TO service_role;
GRANT ALL ON TABLE public.support_sessions TO service_role;
GRANT ALL ON TABLE public.audit_events TO service_role;

DROP POLICY IF EXISTS sam20_memberships_self_read ON public.memberships;
CREATE POLICY sam20_memberships_self_read
  ON public.memberships
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND status = 'active'
  );

DROP POLICY IF EXISTS sam20_organizations_member_read ON public.organizations;
CREATE POLICY sam20_organizations_member_read
  ON public.organizations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.memberships membership
      WHERE membership.organization_id = organizations.id
        AND membership.user_id = (SELECT auth.uid())
        AND membership.status = 'active'
    )
  );

CREATE OR REPLACE FUNCTION public.requested_organization_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  request_headers jsonb;
  raw_organization_id text;
BEGIN
  request_headers := COALESCE(
    NULLIF(current_setting('request.headers', true), ''),
    '{}'
  )::jsonb;
  raw_organization_id := NULLIF(
    request_headers ->> 'x-newme-organization-id',
    ''
  );
  IF raw_organization_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN raw_organization_id::uuid;
EXCEPTION
  WHEN invalid_text_representation OR invalid_parameter_value THEN
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.requested_organization_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.requested_organization_id()
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_lead_organization_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  caller_id uuid := auth.uid();
  requested_id uuid;
  row_organization_id uuid;
BEGIN
  -- Trusted migration and service_role paths have no auth.uid(). They remain
  -- responsible for their own explicit authorization and audit boundary.
  IF caller_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  requested_id := public.requested_organization_id();
  IF requested_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'organization_context_required';
  END IF;

  IF TG_OP = 'DELETE' THEN
    row_organization_id := OLD.organization_id;
  ELSE
    row_organization_id := NEW.organization_id;
  END IF;

  IF row_organization_id IS NULL OR row_organization_id <> requested_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'lead_organization_context_mismatch';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'lead_organization_is_immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships membership
    WHERE membership.organization_id = requested_id
      AND membership.user_id = caller_id
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active_organization_membership_required';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_lead_organization_context() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_lead_child_organization_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  caller_id uuid := auth.uid();
  requested_id uuid;
  child_row jsonb;
  parent_lead_id uuid;
BEGIN
  IF caller_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  requested_id := public.requested_organization_id();
  IF requested_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'organization_context_required';
  END IF;

  IF TG_OP = 'DELETE' THEN
    child_row := to_jsonb(OLD);
  ELSE
    child_row := to_jsonb(NEW);
  END IF;
  parent_lead_id := NULLIF(child_row ->> 'lead_id', '')::uuid;

  -- Non-Lead records in shared activity/task tables remain outside SAM-20.
  IF parent_lead_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.leads lead_row
    JOIN public.memberships membership
      ON membership.organization_id = lead_row.organization_id
     AND membership.user_id = caller_id
     AND membership.status = 'active'
    WHERE lead_row.id = parent_lead_id
      AND lead_row.organization_id = requested_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'lead_child_organization_context_mismatch';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_lead_child_organization_context() FROM PUBLIC;

INSERT INTO public.organizations (
  id,
  slug,
  name,
  industry_key,
  status,
  data_region,
  timezone
)
VALUES (
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid,
  'legacy',
  'Legacy organization',
  'real_estate',
  'active',
  'uae',
  'Asia/Dubai'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.memberships (
  organization_id,
  user_id,
  status,
  invited_at,
  accepted_at
)
SELECT
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid,
  profile.id,
  'active',
  now(),
  now()
FROM public.profiles profile
WHERE profile.is_active IS TRUE
ON CONFLICT (organization_id, user_id) DO NOTHING;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS organization_id uuid;

UPDATE public.leads
SET organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
WHERE organization_id IS NULL;

ALTER TABLE public.leads
  ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leads_organization_id_fkey'
      AND conrelid = 'public.leads'::regclass
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES public.organizations(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.leads
  VALIDATE CONSTRAINT leads_organization_id_fkey;

CREATE INDEX IF NOT EXISTS leads_organization_updated_idx
  ON public.leads (organization_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS leads_organization_id_id_unique
  ON public.leads (organization_id, id);

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sam20_leads_organization_boundary ON public.leads;
CREATE POLICY sam20_leads_organization_boundary
  ON public.leads
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (
    organization_id = (SELECT public.requested_organization_id())
    AND EXISTS (
      SELECT 1
      FROM public.memberships membership
      WHERE membership.organization_id = leads.organization_id
        AND membership.user_id = (SELECT auth.uid())
        AND membership.status = 'active'
    )
  )
  WITH CHECK (
    organization_id = (SELECT public.requested_organization_id())
    AND EXISTS (
      SELECT 1
      FROM public.memberships membership
      WHERE membership.organization_id = leads.organization_id
        AND membership.user_id = (SELECT auth.uid())
        AND membership.status = 'active'
    )
  );

DROP TRIGGER IF EXISTS sam20_enforce_lead_organization_context
  ON public.leads;
CREATE TRIGGER sam20_enforce_lead_organization_context
  BEFORE INSERT OR UPDATE OR DELETE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_lead_organization_context();

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
    IF to_regclass('public.' || child_table) IS NULL THEN
      RAISE EXCEPTION 'SAM-20 required Lead child table is missing: %', child_table;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      child_table
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS sam20_%I_organization_boundary ON public.%I',
      child_table,
      child_table
    );
    EXECUTE format(
      'CREATE POLICY sam20_%I_organization_boundary
         ON public.%I
         AS RESTRICTIVE
         FOR ALL
         TO authenticated
         USING (
           %I.lead_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM public.leads lead_row
             WHERE lead_row.id = %I.lead_id
               AND lead_row.organization_id =
                 (SELECT public.requested_organization_id())
           )
         )
         WITH CHECK (
           %I.lead_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM public.leads lead_row
             WHERE lead_row.id = %I.lead_id
               AND lead_row.organization_id =
                 (SELECT public.requested_organization_id())
           )
         )',
      child_table,
      child_table,
      child_table,
      child_table,
      child_table,
      child_table
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS sam20_enforce_lead_child_organization_context
         ON public.%I',
      child_table
    );
    EXECUTE format(
      'CREATE TRIGGER sam20_enforce_lead_child_organization_context
         BEFORE INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW
         EXECUTE FUNCTION public.enforce_lead_child_organization_context()',
      child_table
    );
  END LOOP;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.v_lead_trace') IS NOT NULL THEN
    ALTER VIEW public.v_lead_trace SET (security_invoker = true);
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
