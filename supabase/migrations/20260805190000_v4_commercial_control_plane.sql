-- SAM-79 / V4 commercial control plane.
-- Plans and invoice references are deliberately provider-neutral. Until an
-- external billing provider is approved, invoice_mode/source must be manual.

BEGIN;

CREATE TABLE public.commercial_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key text NOT NULL CHECK (plan_key IN ('starter', 'growth', 'scale')),
  version integer NOT NULL CHECK (version > 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  paid_seat_limit integer NOT NULL CHECK (paid_seat_limit > 0),
  organization_limit integer CHECK (organization_limit IS NULL OR organization_limit > 0),
  included_entitlements jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(included_entitlements) = 'object'),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_key, version),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  CHECK (
    (plan_key = 'starter' AND paid_seat_limit = 5 AND organization_limit = 1)
    OR (plan_key = 'growth' AND paid_seat_limit = 20 AND organization_limit = 3)
    OR (plan_key = 'scale' AND paid_seat_limit >= 50 AND paid_seat_limit % 5 = 0)
  )
);

CREATE UNIQUE INDEX commercial_plan_versions_active_unique
  ON public.commercial_plan_versions (plan_key) WHERE is_active;

CREATE TABLE public.organization_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL
    REFERENCES public.commercial_plan_versions(id) ON DELETE RESTRICT,
  lifecycle_state text NOT NULL DEFAULT 'trialing'
    CHECK (lifecycle_state IN (
      'trialing', 'active', 'grace', 'read_only', 'suspended', 'closed'
    )),
  invoice_mode text NOT NULL DEFAULT 'manual' CHECK (invoice_mode = 'manual'),
  paid_seat_limit integer NOT NULL CHECK (paid_seat_limit > 0),
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end IS NULL OR current_period_end > current_period_start),
  CHECK ((lifecycle_state = 'grace') = (grace_ends_at IS NOT NULL)),
  CHECK (lifecycle_state <> 'trialing' OR trial_ends_at IS NOT NULL)
);

CREATE TABLE public.commercial_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  entitlement_key text NOT NULL
    CHECK (entitlement_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  enabled boolean NOT NULL DEFAULT true,
  numeric_limit bigint CHECK (numeric_limit IS NULL OR numeric_limit >= 0),
  source text NOT NULL CHECK (source IN ('plan', 'approved_override')),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) >= 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, entitlement_key)
);

CREATE TABLE public.paid_seat_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL REFERENCES public.memberships(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  allocation_key text NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, membership_id),
  UNIQUE (organization_id, allocation_key),
  CHECK ((status = 'released') = (released_at IS NOT NULL))
);

CREATE UNIQUE INDEX paid_seat_allocations_active_membership_unique
  ON public.paid_seat_allocations (membership_id) WHERE status = 'active';

CREATE TABLE public.commercial_seat_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  allocation_id uuid NOT NULL REFERENCES public.paid_seat_allocations(id) ON DELETE RESTRICT,
  delta smallint NOT NULL CHECK (delta IN (-1, 1)),
  seats_before integer NOT NULL CHECK (seats_before >= 0),
  seats_after integer NOT NULL CHECK (seats_after >= 0),
  event_key text NOT NULL,
  actor_platform_staff_id uuid REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, event_key),
  CHECK (seats_after = seats_before + delta)
);

CREATE TABLE public.commercial_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  metric_key text NOT NULL
    CHECK (metric_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  quantity bigint NOT NULL CHECK (quantity > 0),
  idempotency_key text NOT NULL,
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 100),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, metric_key, idempotency_key),
  CHECK (period_end > period_start)
);

CREATE INDEX commercial_usage_period_idx
  ON public.commercial_usage_events (organization_id, metric_key, period_start, period_end);

CREATE TABLE public.commercial_invoice_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  invoice_ref text NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  status text NOT NULL CHECK (status IN ('open', 'paid', 'overdue', 'void')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  due_at timestamptz,
  paid_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, invoice_ref),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);

CREATE TABLE public.commercial_action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  action_key text NOT NULL CHECK (action_key IN (
    'subscription.plan.change', 'subscription.state.transition',
    'seat.allocate', 'seat.release', 'entitlement.override', 'invoice.record'
  )),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'consumed')),
  requested_by_platform_staff_id uuid NOT NULL
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  approved_by_platform_staff_id uuid
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  request_key text NOT NULL UNIQUE,
  execution_key text UNIQUE,
  execution_result jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  CHECK (
    approved_by_platform_staff_id IS NULL
    OR approved_by_platform_staff_id <> requested_by_platform_staff_id
  ),
  CHECK ((status = 'pending') = (approved_at IS NULL)),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'consumed') = (execution_result IS NOT NULL)),
  CHECK (expires_at > requested_at)
);

CREATE TABLE public.commercial_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.commercial_action_requests(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  actor_platform_staff_id uuid NOT NULL REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('requested', 'approved', 'consumed')),
  event_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.commercial_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES public.organization_subscriptions(id) ON DELETE RESTRICT,
  from_state text NOT NULL,
  to_state text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  action_request_id uuid REFERENCES public.commercial_action_requests(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.commercial_migration_org_snapshots (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
  plan_key text NOT NULL,
  billable_seat_limit integer NOT NULL,
  organization_status text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commercial_plan_versions', 'organization_subscriptions',
    'commercial_entitlements', 'paid_seat_allocations', 'commercial_seat_events',
    'commercial_usage_events', 'commercial_invoice_references',
    'commercial_action_requests', 'commercial_action_events',
    'commercial_state_events', 'commercial_migration_org_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;

REVOKE ALL ON TABLE public.commercial_plan_versions,
  public.organization_subscriptions, public.commercial_entitlements,
  public.paid_seat_allocations, public.commercial_seat_events,
  public.commercial_usage_events, public.commercial_invoice_references,
  public.commercial_action_requests, public.commercial_action_events,
  public.commercial_state_events, public.commercial_migration_org_snapshots
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.commercial_plan_versions,
  public.organization_subscriptions, public.commercial_entitlements,
  public.paid_seat_allocations, public.commercial_seat_events,
  public.commercial_usage_events, public.commercial_invoice_references,
  public.commercial_action_requests, public.commercial_action_events,
  public.commercial_state_events, public.commercial_migration_org_snapshots
  TO service_role;
GRANT SELECT ON TABLE public.commercial_plan_versions,
  public.organization_subscriptions, public.commercial_entitlements,
  public.paid_seat_allocations, public.commercial_seat_events,
  public.commercial_usage_events, public.commercial_invoice_references,
  public.commercial_state_events TO authenticated;

CREATE POLICY commercial_plan_catalog_read ON public.commercial_plan_versions
  FOR SELECT TO authenticated USING (is_active OR effective_until IS NOT NULL);

CREATE POLICY organization_subscriptions_read ON public.organization_subscriptions
  FOR SELECT TO authenticated USING (
    public.v4_actor_has_capability(
      organization_id, auth.uid(), 'commercial.read', 'read'
    )
  );
CREATE POLICY commercial_entitlements_read ON public.commercial_entitlements
  FOR SELECT TO authenticated USING (
    public.v4_actor_has_capability(
      organization_id, auth.uid(), 'commercial.read', 'read'
    )
  );
CREATE POLICY paid_seat_allocations_read ON public.paid_seat_allocations
  FOR SELECT TO authenticated USING (
    public.v4_actor_has_capability(
      organization_id, auth.uid(), 'commercial.read', 'read'
    )
  );
CREATE POLICY commercial_seat_events_read ON public.commercial_seat_events
  FOR SELECT TO authenticated USING (
    public.v4_actor_has_capability(
      organization_id, auth.uid(), 'commercial.read', 'read'
    )
  );
CREATE POLICY commercial_usage_events_read ON public.commercial_usage_events
  FOR SELECT TO authenticated USING (
    public.v4_actor_has_capability(
      organization_id, auth.uid(), 'commercial.read', 'read'
    )
  );
CREATE POLICY commercial_invoice_references_read ON public.commercial_invoice_references
  FOR SELECT TO authenticated USING (
    public.v4_actor_has_capability(
      organization_id, auth.uid(), 'commercial.read', 'read'
    )
  );
CREATE POLICY commercial_state_events_read ON public.commercial_state_events
  FOR SELECT TO authenticated USING (
    public.v4_actor_has_capability(
      organization_id, auth.uid(), 'commercial.read', 'read'
    )
  );

INSERT INTO public.capabilities (capability_key, scope, description)
VALUES ('commercial.read', 'organization', 'Read organization commercial state')
ON CONFLICT (scope, capability_key) DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id
FROM public.roles role
CROSS JOIN public.capabilities capability
WHERE role.scope = 'organization'
  AND role.role_key IN ('org_owner', 'org_admin', 'operations', 'finance')
  AND capability.scope = 'organization'
  AND capability.capability_key = 'commercial.read'
ON CONFLICT (role_id, capability_id) DO NOTHING;

INSERT INTO public.commercial_plan_versions (
  plan_key, version, display_name, paid_seat_limit, organization_limit,
  included_entitlements, effective_from
)
VALUES
  ('starter', 1, 'Starter', 5, 1, '{"feature.core_crm": true}'::jsonb,
    '2026-08-01T00:00:00Z'),
  ('growth', 1, 'Growth', 20, 3,
    '{"feature.core_crm": true, "feature.automation": true, "feature.audit": true}'::jsonb,
    '2026-08-01T00:00:00Z'),
  ('scale', 1, 'Scale', 50, NULL,
    '{"feature.core_crm": true, "feature.automation": true, "feature.audit": true, "feature.sso": true}'::jsonb,
    '2026-08-01T00:00:00Z');

INSERT INTO public.commercial_migration_org_snapshots (
  organization_id, plan_key, billable_seat_limit, organization_status
)
SELECT id, plan_key, billable_seat_limit, status FROM public.organizations;

ALTER TABLE public.organizations
  ALTER COLUMN billable_seat_limit SET DEFAULT 5,
  DROP CONSTRAINT organizations_billable_seat_limit_check;
UPDATE public.organizations
SET billable_seat_limit = CASE plan_key
  WHEN 'starter' THEN GREATEST(billable_seat_limit, 5)
  WHEN 'growth' THEN GREATEST(billable_seat_limit, 20)
  ELSE GREATEST(50, CEIL(billable_seat_limit / 5.0)::integer * 5)
END;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_billable_seat_limit_check CHECK (
    (plan_key = 'starter' AND billable_seat_limit = 5)
    OR (plan_key = 'growth' AND billable_seat_limit = 20)
    OR (plan_key = 'scale' AND billable_seat_limit >= 50 AND billable_seat_limit % 5 = 0)
  );

INSERT INTO public.organization_subscriptions (
  organization_id, plan_version_id, lifecycle_state, paid_seat_limit,
  trial_ends_at, current_period_end
)
SELECT organization.id, plan.id,
  CASE organization.status
    WHEN 'read_only' THEN 'read_only'
    WHEN 'suspended' THEN 'suspended'
    WHEN 'closed' THEN 'closed'
    ELSE 'active'
  END,
  organization.billable_seat_limit, NULL, now() + interval '1 month'
FROM public.organizations organization
JOIN public.commercial_plan_versions plan
  ON plan.plan_key = organization.plan_key AND plan.is_active;

INSERT INTO public.commercial_entitlements (
  organization_id, entitlement_key, enabled, numeric_limit, source, source_ref
)
SELECT subscription.organization_id, item.key,
  CASE jsonb_typeof(item.value) WHEN 'boolean' THEN (item.value #>> '{}')::boolean ELSE true END,
  CASE jsonb_typeof(item.value) WHEN 'number' THEN (item.value #>> '{}')::bigint ELSE NULL END,
  'plan', 'plan-version:' || plan.id::text
FROM public.organization_subscriptions subscription
JOIN public.commercial_plan_versions plan ON plan.id = subscription.plan_version_id
CROSS JOIN LATERAL jsonb_each(plan.included_entitlements) item;

INSERT INTO public.paid_seat_allocations (
  organization_id, membership_id, status, allocation_key
)
SELECT DISTINCT membership.organization_id, membership.id, 'active',
  'migration:' || membership.id::text
FROM public.memberships membership
JOIN public.membership_roles membership_role
  ON membership_role.membership_id = membership.id AND membership_role.revoked_at IS NULL
JOIN public.roles role ON role.id = membership_role.role_id AND role.is_billable
WHERE membership.status = 'active' AND membership.accepted_at IS NOT NULL;

INSERT INTO public.commercial_seat_events (
  organization_id, allocation_id, delta, seats_before, seats_after, event_key
)
SELECT allocation.organization_id, allocation.id, 1,
  row_number() OVER (PARTITION BY allocation.organization_id ORDER BY allocation.id)::integer - 1,
  row_number() OVER (PARTITION BY allocation.organization_id ORDER BY allocation.id)::integer,
  'migration:' || allocation.id::text
FROM public.paid_seat_allocations allocation;

CREATE OR REPLACE FUNCTION public.v4_commercial_payload_hash(p_payload jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(
    extensions.digest(convert_to(COALESCE(p_payload, 'null'::jsonb)::text, 'UTF8'), 'sha256'),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION public.v4_bootstrap_organization_subscription()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE selected_plan public.commercial_plan_versions%ROWTYPE;
BEGIN
  SELECT * INTO selected_plan FROM public.commercial_plan_versions
  WHERE plan_key = NEW.plan_key AND is_active;
  IF selected_plan.id IS NULL THEN RAISE EXCEPTION 'commercial_active_plan_not_found'; END IF;
  IF NEW.billable_seat_limit <> selected_plan.paid_seat_limit THEN
    RAISE EXCEPTION 'commercial_plan_seat_limit_mismatch';
  END IF;
  INSERT INTO public.organization_subscriptions (
    organization_id, plan_version_id, lifecycle_state, paid_seat_limit,
    current_period_end
  ) VALUES (
    NEW.id, selected_plan.id,
    CASE NEW.status WHEN 'read_only' THEN 'read_only'
      WHEN 'suspended' THEN 'suspended' WHEN 'closed' THEN 'closed' ELSE 'active' END,
    selected_plan.paid_seat_limit, now() + interval '1 month'
  );
  INSERT INTO public.commercial_entitlements (
    organization_id, entitlement_key, enabled, numeric_limit, source, source_ref
  )
  SELECT NEW.id, item.key,
    CASE jsonb_typeof(item.value) WHEN 'boolean' THEN (item.value #>> '{}')::boolean ELSE true END,
    CASE jsonb_typeof(item.value) WHEN 'number' THEN (item.value #>> '{}')::bigint ELSE NULL END,
    'plan', 'plan-version:' || selected_plan.id::text
  FROM jsonb_each(selected_plan.included_entitlements) item;
  RETURN NEW;
END;
$$;

CREATE TRIGGER v4_bootstrap_organization_subscription
AFTER INSERT ON public.organizations FOR EACH ROW
EXECUTE FUNCTION public.v4_bootstrap_organization_subscription();

CREATE OR REPLACE FUNCTION public.v4_sync_subscription_from_organization()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE subscription_row public.organization_subscriptions%ROWTYPE;
DECLARE target_state text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  SELECT * INTO subscription_row FROM public.organization_subscriptions
  WHERE organization_id = NEW.id FOR UPDATE;
  IF subscription_row.id IS NULL THEN RETURN NEW; END IF;
  target_state := CASE NEW.status
    WHEN 'read_only' THEN 'read_only' WHEN 'suspended' THEN 'suspended'
    WHEN 'closed' THEN 'closed'
    ELSE CASE WHEN subscription_row.lifecycle_state IN ('read_only', 'suspended', 'closed')
      THEN 'active' ELSE subscription_row.lifecycle_state END
  END;
  IF target_state IS DISTINCT FROM subscription_row.lifecycle_state THEN
    UPDATE public.organization_subscriptions SET
      lifecycle_state = target_state,
      grace_ends_at = CASE WHEN target_state = 'grace' THEN grace_ends_at ELSE NULL END,
      version = version + 1, updated_at = now()
    WHERE id = subscription_row.id;
    INSERT INTO public.commercial_state_events (
      organization_id, subscription_id, from_state, to_state, reason
    ) VALUES (
      NEW.id, subscription_row.id, subscription_row.lifecycle_state,
      target_state, 'organization_status_sync'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER v4_sync_subscription_from_organization
AFTER UPDATE OF status ON public.organizations FOR EACH ROW
EXECUTE FUNCTION public.v4_sync_subscription_from_organization();

CREATE OR REPLACE FUNCTION public.v4_sync_membership_paid_seat()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target_membership_id uuid;
DECLARE membership_row public.memberships%ROWTYPE;
DECLARE subscription_row public.organization_subscriptions%ROWTYPE;
DECLARE allocation_row public.paid_seat_allocations%ROWTYPE;
DECLARE should_be_active boolean;
DECLARE active_seats integer;
DECLARE event_key text;
BEGIN
  target_membership_id := CASE WHEN TG_TABLE_NAME = 'memberships'
    THEN COALESCE(NEW.id, OLD.id) ELSE COALESCE(NEW.membership_id, OLD.membership_id) END;
  SELECT * INTO membership_row FROM public.memberships WHERE id = target_membership_id;
  IF membership_row.id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT * INTO subscription_row FROM public.organization_subscriptions
  WHERE organization_id = membership_row.organization_id FOR UPDATE;
  IF subscription_row.id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  should_be_active := membership_row.status = 'active'
    AND membership_row.accepted_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.membership_roles mr
      JOIN public.roles role ON role.id = mr.role_id AND role.is_billable
      WHERE mr.membership_id = membership_row.id AND mr.revoked_at IS NULL
    );
  SELECT * INTO allocation_row FROM public.paid_seat_allocations
  WHERE organization_id = membership_row.organization_id
    AND membership_id = membership_row.id FOR UPDATE;
  SELECT count(*) INTO active_seats FROM public.paid_seat_allocations
  WHERE organization_id = membership_row.organization_id AND status = 'active';
  event_key := 'membership-sync:' || membership_row.id::text || ':'
    || txid_current()::text || ':' || TG_OP;
  IF should_be_active AND (allocation_row.id IS NULL OR allocation_row.status = 'released') THEN
    IF active_seats >= subscription_row.paid_seat_limit THEN
      RAISE EXCEPTION 'commercial_seat_limit_reached';
    END IF;
    INSERT INTO public.paid_seat_allocations (
      organization_id, membership_id, status, allocation_key
    ) VALUES (
      membership_row.organization_id, membership_row.id, 'active', event_key
    ) ON CONFLICT (organization_id, membership_id) DO UPDATE SET
      status = 'active', released_at = NULL, allocation_key = EXCLUDED.allocation_key
    RETURNING * INTO allocation_row;
    INSERT INTO public.commercial_seat_events (
      organization_id, allocation_id, delta, seats_before, seats_after, event_key
    ) VALUES (
      membership_row.organization_id, allocation_row.id, 1,
      active_seats, active_seats + 1, event_key
    );
  ELSIF NOT should_be_active AND allocation_row.status = 'active' THEN
    UPDATE public.paid_seat_allocations SET status = 'released', released_at = now()
    WHERE id = allocation_row.id;
    INSERT INTO public.commercial_seat_events (
      organization_id, allocation_id, delta, seats_before, seats_after, event_key
    ) VALUES (
      membership_row.organization_id, allocation_row.id, -1,
      active_seats, active_seats - 1, event_key
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER v4_sync_membership_paid_seat_membership
AFTER INSERT OR UPDATE OF status, accepted_at ON public.memberships
FOR EACH ROW EXECUTE FUNCTION public.v4_sync_membership_paid_seat();
CREATE TRIGGER v4_sync_membership_paid_seat_role
AFTER INSERT OR UPDATE OF revoked_at OR DELETE ON public.membership_roles
FOR EACH ROW EXECUTE FUNCTION public.v4_sync_membership_paid_seat();

CREATE OR REPLACE FUNCTION public.v4_request_commercial_action(
  p_organization_id uuid, p_action_key text, p_payload jsonb, p_request_key text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor_staff public.platform_staff%ROWTYPE;
  request_row public.commercial_action_requests%ROWTYPE;
  inserted_id uuid;
  payload_hash_value text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF p_action_key NOT IN (
    'subscription.plan.change', 'subscription.state.transition',
    'seat.allocate', 'seat.release', 'entitlement.override', 'invoice.record'
  ) THEN RAISE EXCEPTION 'invalid_commercial_action'; END IF;
  IF jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'commercial_payload_required'; END IF;
  IF length(btrim(COALESCE(p_request_key, ''))) < 8 THEN
    RAISE EXCEPTION 'commercial_request_key_required';
  END IF;
  SELECT staff.* INTO actor_staff
  FROM public.platform_staff staff
  JOIN public.profiles profile ON profile.id = staff.user_id AND profile.is_active
  WHERE staff.user_id = auth.uid() AND staff.status = 'active'
    AND staff.role_key IN ('platform_owner', 'platform_ops');
  IF actor_staff.id IS NULL THEN RAISE EXCEPTION 'commercial_platform_staff_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
    RAISE EXCEPTION 'commercial_organization_not_found';
  END IF;
  payload_hash_value := public.v4_commercial_payload_hash(p_payload);
  INSERT INTO public.commercial_action_requests (
    organization_id, action_key, payload, payload_hash,
    requested_by_platform_staff_id, request_key
  ) VALUES (
    p_organization_id, p_action_key, p_payload, payload_hash_value,
    actor_staff.id, btrim(p_request_key)
  ) ON CONFLICT (request_key) DO NOTHING RETURNING id INTO inserted_id;
  SELECT * INTO request_row FROM public.commercial_action_requests
  WHERE request_key = btrim(p_request_key) FOR UPDATE;
  IF request_row.organization_id <> p_organization_id
    OR request_row.action_key <> p_action_key
    OR request_row.payload_hash <> payload_hash_value
    OR request_row.requested_by_platform_staff_id <> actor_staff.id
  THEN RAISE EXCEPTION 'commercial_request_idempotency_mismatch'; END IF;
  IF inserted_id IS NOT NULL THEN
    INSERT INTO public.commercial_action_events (
      request_id, organization_id, actor_platform_staff_id, event_type, event_key, metadata
    ) VALUES (
      request_row.id, p_organization_id, actor_staff.id, 'requested',
      'request:' || btrim(p_request_key), jsonb_build_object('payload_hash', payload_hash_value)
    );
  END IF;
  RETURN jsonb_build_object(
    'request_id', request_row.id, 'status', request_row.status,
    'payload_hash', request_row.payload_hash, 'idempotent', inserted_id IS NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_approve_commercial_action(
  p_request_id uuid, p_event_key text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  approver_staff public.platform_staff%ROWTYPE;
  request_row public.commercial_action_requests%ROWTYPE;
BEGIN
  SELECT staff.* INTO approver_staff
  FROM public.platform_staff staff
  JOIN public.profiles profile ON profile.id = staff.user_id AND profile.is_active
  WHERE staff.user_id = auth.uid() AND staff.status = 'active'
    AND staff.role_key IN ('platform_owner', 'platform_ops');
  IF approver_staff.id IS NULL THEN RAISE EXCEPTION 'commercial_platform_staff_required'; END IF;
  SELECT * INTO request_row FROM public.commercial_action_requests
  WHERE id = p_request_id FOR UPDATE;
  IF request_row.id IS NULL THEN RAISE EXCEPTION 'commercial_request_not_found'; END IF;
  IF request_row.expires_at <= now() THEN RAISE EXCEPTION 'commercial_request_expired'; END IF;
  IF request_row.requested_by_platform_staff_id = approver_staff.id THEN
    RAISE EXCEPTION 'commercial_independent_approval_required';
  END IF;
  IF request_row.status = 'pending' THEN
    UPDATE public.commercial_action_requests SET
      status = 'approved', approved_by_platform_staff_id = approver_staff.id,
      approved_at = now()
    WHERE id = request_row.id;
    INSERT INTO public.commercial_action_events (
      request_id, organization_id, actor_platform_staff_id, event_type, event_key
    ) VALUES (
      request_row.id, request_row.organization_id, approver_staff.id,
      'approved', btrim(p_event_key)
    );
  ELSIF request_row.approved_by_platform_staff_id <> approver_staff.id THEN
    RAISE EXCEPTION 'commercial_request_already_approved';
  END IF;
  RETURN jsonb_build_object('request_id', request_row.id, 'status', 'approved');
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_execute_commercial_action(
  p_request_id uuid, p_execution_key text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  request_row public.commercial_action_requests%ROWTYPE;
  subscription public.organization_subscriptions%ROWTYPE;
  plan public.commercial_plan_versions%ROWTYPE;
  allocation public.paid_seat_allocations%ROWTYPE;
  membership public.memberships%ROWTYPE;
  active_seats integer;
  old_state text;
  result jsonb;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF length(btrim(COALESCE(p_execution_key, ''))) < 8 THEN
    RAISE EXCEPTION 'commercial_execution_key_required';
  END IF;
  SELECT * INTO request_row FROM public.commercial_action_requests
  WHERE id = p_request_id FOR UPDATE;
  IF request_row.id IS NULL THEN RAISE EXCEPTION 'commercial_request_not_found'; END IF;
  IF request_row.status = 'consumed' THEN
    IF request_row.execution_key <> btrim(p_execution_key) THEN
      RAISE EXCEPTION 'commercial_execution_idempotency_mismatch';
    END IF;
    RETURN request_row.execution_result;
  END IF;
  IF request_row.status <> 'approved' OR request_row.expires_at <= now() THEN
    RAISE EXCEPTION 'commercial_approved_request_required';
  END IF;
  SELECT * INTO subscription FROM public.organization_subscriptions
  WHERE organization_id = request_row.organization_id FOR UPDATE;
  IF subscription.id IS NULL THEN RAISE EXCEPTION 'commercial_subscription_not_found'; END IF;

  CASE request_row.action_key
    WHEN 'subscription.plan.change' THEN
      SELECT * INTO plan FROM public.commercial_plan_versions
      WHERE plan_key = request_row.payload ->> 'plan_key' AND is_active FOR UPDATE;
      IF plan.id IS NULL THEN RAISE EXCEPTION 'commercial_active_plan_not_found'; END IF;
      SELECT count(*) INTO active_seats FROM public.paid_seat_allocations
      WHERE organization_id = request_row.organization_id AND status = 'active';
      IF active_seats > plan.paid_seat_limit THEN RAISE EXCEPTION 'commercial_plan_seat_limit_exceeded'; END IF;
      UPDATE public.organization_subscriptions SET
        plan_version_id = plan.id, paid_seat_limit = plan.paid_seat_limit,
        version = version + 1, updated_at = now()
      WHERE id = subscription.id;
      UPDATE public.organizations SET plan_key = plan.plan_key,
        billable_seat_limit = plan.paid_seat_limit, updated_at = now()
      WHERE id = request_row.organization_id;
      DELETE FROM public.commercial_entitlements
      WHERE organization_id = request_row.organization_id AND source = 'plan';
      INSERT INTO public.commercial_entitlements (
        organization_id, entitlement_key, enabled, numeric_limit, source, source_ref
      )
      SELECT request_row.organization_id, item.key,
        CASE jsonb_typeof(item.value) WHEN 'boolean' THEN (item.value #>> '{}')::boolean ELSE true END,
        CASE jsonb_typeof(item.value) WHEN 'number' THEN (item.value #>> '{}')::bigint ELSE NULL END,
        'plan', 'plan-version:' || plan.id::text
      FROM jsonb_each(plan.included_entitlements) item
      ON CONFLICT (organization_id, entitlement_key) DO UPDATE SET
        enabled = EXCLUDED.enabled, numeric_limit = EXCLUDED.numeric_limit,
        source = EXCLUDED.source, source_ref = EXCLUDED.source_ref, updated_at = now();
      result := jsonb_build_object('plan_key', plan.plan_key, 'paid_seat_limit', plan.paid_seat_limit);
    WHEN 'subscription.state.transition' THEN
      old_state := subscription.lifecycle_state;
      IF request_row.payload ->> 'to_state' NOT IN (
        'trialing', 'active', 'grace', 'read_only', 'suspended', 'closed'
      ) THEN RAISE EXCEPTION 'commercial_state_invalid'; END IF;
      UPDATE public.organization_subscriptions SET
        lifecycle_state = request_row.payload ->> 'to_state',
        trial_ends_at = CASE WHEN request_row.payload ->> 'to_state' = 'trialing'
          THEN (request_row.payload ->> 'trial_ends_at')::timestamptz ELSE NULL END,
        grace_ends_at = CASE WHEN request_row.payload ->> 'to_state' = 'grace'
          THEN (request_row.payload ->> 'grace_ends_at')::timestamptz ELSE NULL END,
        version = version + 1, updated_at = now()
      WHERE id = subscription.id;
      UPDATE public.organizations SET
        status = CASE request_row.payload ->> 'to_state'
          WHEN 'read_only' THEN 'read_only' WHEN 'suspended' THEN 'suspended'
          WHEN 'closed' THEN 'closed' ELSE 'active' END,
        closed_at = CASE WHEN request_row.payload ->> 'to_state' = 'closed' THEN now() ELSE NULL END,
        updated_at = now()
      WHERE id = request_row.organization_id;
      INSERT INTO public.commercial_state_events (
        organization_id, subscription_id, from_state, to_state, reason, action_request_id
      ) VALUES (
        request_row.organization_id, subscription.id, old_state,
        request_row.payload ->> 'to_state', request_row.payload ->> 'reason', request_row.id
      );
      result := jsonb_build_object('from_state', old_state, 'to_state', request_row.payload ->> 'to_state');
    WHEN 'seat.allocate' THEN
      SELECT * INTO membership FROM public.memberships
      WHERE id = (request_row.payload ->> 'membership_id')::uuid
        AND organization_id = request_row.organization_id FOR UPDATE;
      IF membership.id IS NULL OR membership.status <> 'active' OR membership.accepted_at IS NULL THEN
        RAISE EXCEPTION 'commercial_active_membership_required';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.membership_roles mr JOIN public.roles role ON role.id = mr.role_id
        WHERE mr.membership_id = membership.id AND mr.revoked_at IS NULL AND role.is_billable
      ) THEN RAISE EXCEPTION 'commercial_billable_role_required'; END IF;
      SELECT count(*) INTO active_seats FROM public.paid_seat_allocations
      WHERE organization_id = request_row.organization_id AND status = 'active';
      IF active_seats >= subscription.paid_seat_limit THEN RAISE EXCEPTION 'commercial_seat_limit_reached'; END IF;
      INSERT INTO public.paid_seat_allocations (
        organization_id, membership_id, status, allocation_key
      ) VALUES (
        request_row.organization_id, membership.id, 'active', p_execution_key
      ) ON CONFLICT (organization_id, membership_id) DO UPDATE SET
        status = 'active', released_at = NULL, allocation_key = EXCLUDED.allocation_key
      RETURNING * INTO allocation;
      INSERT INTO public.commercial_seat_events (
        organization_id, allocation_id, delta, seats_before, seats_after,
        event_key, actor_platform_staff_id
      ) VALUES (
        request_row.organization_id, allocation.id, 1, active_seats, active_seats + 1,
        p_execution_key, request_row.approved_by_platform_staff_id
      );
      result := jsonb_build_object('allocation_id', allocation.id, 'active_seats', active_seats + 1);
    WHEN 'seat.release' THEN
      SELECT * INTO allocation FROM public.paid_seat_allocations
      WHERE organization_id = request_row.organization_id
        AND membership_id = (request_row.payload ->> 'membership_id')::uuid
        AND status = 'active' FOR UPDATE;
      IF allocation.id IS NULL THEN RAISE EXCEPTION 'commercial_active_seat_not_found'; END IF;
      SELECT count(*) INTO active_seats FROM public.paid_seat_allocations
      WHERE organization_id = request_row.organization_id AND status = 'active';
      UPDATE public.paid_seat_allocations SET status = 'released', released_at = now()
      WHERE id = allocation.id;
      INSERT INTO public.commercial_seat_events (
        organization_id, allocation_id, delta, seats_before, seats_after,
        event_key, actor_platform_staff_id
      ) VALUES (
        request_row.organization_id, allocation.id, -1, active_seats, active_seats - 1,
        p_execution_key, request_row.approved_by_platform_staff_id
      );
      result := jsonb_build_object('allocation_id', allocation.id, 'active_seats', active_seats - 1);
    WHEN 'entitlement.override' THEN
      INSERT INTO public.commercial_entitlements (
        organization_id, entitlement_key, enabled, numeric_limit, source, source_ref
      ) VALUES (
        request_row.organization_id, request_row.payload ->> 'entitlement_key',
        (request_row.payload ->> 'enabled')::boolean,
        (request_row.payload ->> 'numeric_limit')::bigint,
        'approved_override', p_execution_key
      ) ON CONFLICT (organization_id, entitlement_key) DO UPDATE SET
        enabled = EXCLUDED.enabled, numeric_limit = EXCLUDED.numeric_limit,
        source = EXCLUDED.source, source_ref = EXCLUDED.source_ref, updated_at = now();
      result := jsonb_build_object('entitlement_key', request_row.payload ->> 'entitlement_key');
    WHEN 'invoice.record' THEN
      INSERT INTO public.commercial_invoice_references (
        organization_id, invoice_ref, source, status, amount_minor, currency,
        due_at, paid_at, metadata
      ) VALUES (
        request_row.organization_id, request_row.payload ->> 'invoice_ref', 'manual',
        request_row.payload ->> 'status', (request_row.payload ->> 'amount_minor')::bigint,
        request_row.payload ->> 'currency',
        (request_row.payload ->> 'due_at')::timestamptz,
        (request_row.payload ->> 'paid_at')::timestamptz,
        COALESCE(request_row.payload -> 'metadata', '{}'::jsonb)
      ) ON CONFLICT (organization_id, invoice_ref) DO UPDATE SET
        status = EXCLUDED.status, amount_minor = EXCLUDED.amount_minor,
        currency = EXCLUDED.currency, due_at = EXCLUDED.due_at,
        paid_at = EXCLUDED.paid_at, metadata = EXCLUDED.metadata, updated_at = now();
      result := jsonb_build_object('invoice_ref', request_row.payload ->> 'invoice_ref', 'source', 'manual');
  END CASE;
  UPDATE public.commercial_action_requests SET
    status = 'consumed', execution_key = btrim(p_execution_key),
    execution_result = result, consumed_at = now()
  WHERE id = request_row.id;
  INSERT INTO public.commercial_action_events (
    request_id, organization_id, actor_platform_staff_id, event_type, event_key, metadata
  ) VALUES (
    request_row.id, request_row.organization_id,
    request_row.approved_by_platform_staff_id, 'consumed',
    'execute:' || btrim(p_execution_key), result
  );
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_record_commercial_usage(
  p_organization_id uuid, p_metric_key text, p_quantity bigint,
  p_idempotency_key text, p_source text, p_period_start timestamptz,
  p_period_end timestamptz, p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  subscription public.organization_subscriptions%ROWTYPE;
  existing_event public.commercial_usage_events%ROWTYPE;
  quota_limit bigint;
  usage_before bigint;
  inserted_id uuid;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  SELECT * INTO subscription FROM public.organization_subscriptions
  WHERE organization_id = p_organization_id FOR UPDATE;
  IF subscription.lifecycle_state NOT IN ('trialing', 'active', 'grace') THEN
    RAISE EXCEPTION 'commercial_subscription_not_writable';
  END IF;
  SELECT numeric_limit INTO quota_limit FROM public.commercial_entitlements
  WHERE organization_id = p_organization_id AND entitlement_key = p_metric_key
    AND enabled AND numeric_limit IS NOT NULL;
  IF quota_limit IS NULL THEN RAISE EXCEPTION 'commercial_quota_not_configured'; END IF;
  SELECT * INTO existing_event FROM public.commercial_usage_events
  WHERE organization_id = p_organization_id AND metric_key = p_metric_key
    AND idempotency_key = btrim(p_idempotency_key);
  IF existing_event.id IS NOT NULL THEN
    IF existing_event.quantity <> p_quantity
      OR existing_event.period_start <> p_period_start
      OR existing_event.period_end <> p_period_end
    THEN RAISE EXCEPTION 'commercial_usage_idempotency_mismatch'; END IF;
    SELECT COALESCE(sum(quantity), 0) INTO usage_before
    FROM public.commercial_usage_events
    WHERE organization_id = p_organization_id AND metric_key = p_metric_key
      AND period_start = p_period_start AND period_end = p_period_end;
    RETURN jsonb_build_object(
      'event_id', existing_event.id, 'used', usage_before,
      'limit', quota_limit, 'idempotent', true
    );
  END IF;
  SELECT COALESCE(sum(quantity), 0) INTO usage_before
  FROM public.commercial_usage_events
  WHERE organization_id = p_organization_id AND metric_key = p_metric_key
    AND period_start = p_period_start AND period_end = p_period_end;
  IF usage_before + p_quantity > quota_limit THEN RAISE EXCEPTION 'commercial_quota_exceeded'; END IF;
  INSERT INTO public.commercial_usage_events (
    organization_id, metric_key, quantity, idempotency_key, source,
    period_start, period_end, metadata
  ) VALUES (
    p_organization_id, p_metric_key, p_quantity, btrim(p_idempotency_key),
    btrim(p_source), p_period_start, p_period_end, COALESCE(p_metadata, '{}'::jsonb)
  ) ON CONFLICT (organization_id, metric_key, idempotency_key) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    SELECT * INTO existing_event FROM public.commercial_usage_events
    WHERE organization_id = p_organization_id AND metric_key = p_metric_key
      AND idempotency_key = btrim(p_idempotency_key);
    IF existing_event.id IS NULL
      OR existing_event.quantity <> p_quantity
      OR existing_event.period_start <> p_period_start
      OR existing_event.period_end <> p_period_end
    THEN RAISE EXCEPTION 'commercial_usage_idempotency_mismatch'; END IF;
    SELECT COALESCE(sum(quantity), 0) INTO usage_before
    FROM public.commercial_usage_events
    WHERE organization_id = p_organization_id AND metric_key = p_metric_key
      AND period_start = p_period_start AND period_end = p_period_end;
    RETURN jsonb_build_object(
      'event_id', existing_event.id, 'used', usage_before,
      'limit', quota_limit, 'idempotent', true
    );
  END IF;
  RETURN jsonb_build_object(
    'event_id', inserted_id, 'used', usage_before + p_quantity,
    'limit', quota_limit, 'idempotent', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_get_commercial_summary(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE allowed boolean;
BEGIN
  allowed := public.v4_actor_has_capability(
    p_organization_id, auth.uid(), 'commercial.read', 'read'
  ) OR EXISTS (
    SELECT 1 FROM public.platform_staff staff
    JOIN public.profiles profile ON profile.id = staff.user_id AND profile.is_active
    WHERE staff.user_id = auth.uid() AND staff.status = 'active'
  );
  IF NOT allowed THEN RAISE EXCEPTION 'commercial_read_permission_required'; END IF;
  RETURN (
    SELECT jsonb_build_object(
      'organization_id', subscription.organization_id,
      'plan', jsonb_build_object(
        'key', plan.plan_key, 'version', plan.version, 'name', plan.display_name,
        'organization_limit', plan.organization_limit
      ),
      'subscription', jsonb_build_object(
        'state', subscription.lifecycle_state, 'invoice_mode', subscription.invoice_mode,
        'paid_seat_limit', subscription.paid_seat_limit,
        'trial_ends_at', subscription.trial_ends_at, 'grace_ends_at', subscription.grace_ends_at,
        'period_start', subscription.current_period_start,
        'period_end', subscription.current_period_end, 'version', subscription.version
      ),
      'active_paid_seats', (
        SELECT count(*) FROM public.paid_seat_allocations allocation
        WHERE allocation.organization_id = subscription.organization_id AND allocation.status = 'active'
      ),
      'entitlements', COALESCE((
        SELECT jsonb_agg(to_jsonb(entitlement) - 'organization_id' ORDER BY entitlement.entitlement_key)
        FROM public.commercial_entitlements entitlement
        WHERE entitlement.organization_id = subscription.organization_id
      ), '[]'::jsonb),
      'usage', COALESCE((
        SELECT jsonb_agg(to_jsonb(usage_row) ORDER BY usage_row.metric_key)
        FROM (
          SELECT metric_key, sum(quantity) AS quantity
          FROM public.commercial_usage_events usage
          WHERE usage.organization_id = subscription.organization_id
          GROUP BY metric_key
        ) usage_row
      ), '[]'::jsonb),
      'invoices', COALESCE((
        SELECT jsonb_agg(to_jsonb(invoice) - 'organization_id' ORDER BY invoice.created_at DESC)
        FROM public.commercial_invoice_references invoice
        WHERE invoice.organization_id = subscription.organization_id
      ), '[]'::jsonb)
    )
    FROM public.organization_subscriptions subscription
    JOIN public.commercial_plan_versions plan ON plan.id = subscription.plan_version_id
    WHERE subscription.organization_id = p_organization_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_reconcile_commercial_control_plane(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE subscription public.organization_subscriptions%ROWTYPE;
DECLARE active_allocations integer;
DECLARE active_billable_memberships integer;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  SELECT * INTO subscription FROM public.organization_subscriptions
  WHERE organization_id = p_organization_id;
  SELECT count(*) INTO active_allocations FROM public.paid_seat_allocations
  WHERE organization_id = p_organization_id AND status = 'active';
  SELECT count(DISTINCT membership.id) INTO active_billable_memberships
  FROM public.memberships membership
  JOIN public.membership_roles membership_role
    ON membership_role.membership_id = membership.id AND membership_role.revoked_at IS NULL
  JOIN public.roles role ON role.id = membership_role.role_id AND role.is_billable
  WHERE membership.organization_id = p_organization_id
    AND membership.status = 'active' AND membership.accepted_at IS NOT NULL;
  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'subscription_present', subscription.id IS NOT NULL,
    'active_allocations', active_allocations,
    'active_billable_memberships', active_billable_memberships,
    'seat_limit', subscription.paid_seat_limit,
    'seat_ledger_balanced', active_allocations = active_billable_memberships,
    'within_limit', active_allocations <= subscription.paid_seat_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_commercial_payload_hash(jsonb),
  public.v4_bootstrap_organization_subscription(),
  public.v4_sync_subscription_from_organization(),
  public.v4_sync_membership_paid_seat(),
  public.v4_request_commercial_action(uuid, text, jsonb, text),
  public.v4_approve_commercial_action(uuid, text),
  public.v4_execute_commercial_action(uuid, text),
  public.v4_record_commercial_usage(uuid, text, bigint, text, text, timestamptz, timestamptz, jsonb),
  public.v4_get_commercial_summary(uuid),
  public.v4_reconcile_commercial_control_plane(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_request_commercial_action(uuid, text, jsonb, text),
  public.v4_approve_commercial_action(uuid, text),
  public.v4_get_commercial_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v4_commercial_payload_hash(jsonb),
  public.v4_bootstrap_organization_subscription(),
  public.v4_sync_subscription_from_organization(),
  public.v4_sync_membership_paid_seat(),
  public.v4_execute_commercial_action(uuid, text),
  public.v4_record_commercial_usage(uuid, text, bigint, text, text, timestamptz, timestamptz, jsonb),
  public.v4_get_commercial_summary(uuid),
  public.v4_reconcile_commercial_control_plane(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.security_definer_rpc_allowlist_gate()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $function$
  WITH expected(regprocedure) AS (
    VALUES
      ('create_product_for_organization(uuid,jsonb)'),
      ('delete_lead_atomic(uuid,uuid)'),
      ('get_my_role()'),
      ('import_products_for_organization(uuid,jsonb)'),
      ('next_quote_no()'),
      ('organization_billable_seat_count(uuid)'),
      ('reassign_lead_atomic(uuid,uuid,timestamp with time zone,uuid,text)'),
      ('recomplete_lead_milestone(uuid,text,text)'),
      ('record_lead_contact_atomic(uuid,text,timestamp with time zone,text,text,text,uuid)'),
      ('record_lead_note_atomic(uuid,text,uuid)'),
      ('reopen_lead_milestone(uuid,text,text)'),
      ('transition_lead_stage(uuid,text,text,text,uuid)'),
      ('v4_accept_organization_membership(uuid,uuid,text)'),
      ('v4_actor_has_capability(uuid,uuid,text,text)'),
      ('v4_actor_has_organization_role(uuid,uuid,text[])'),
      ('v4_allocate_payment_for_organization(uuid,uuid,jsonb,text)'),
      ('v4_approve_commercial_action(uuid,text)'),
      ('v4_approve_platform_action(uuid,text)'),
      ('v4_cancel_tenant_file_upload(uuid,uuid,text,text)'),
      ('v4_confirm_payment_for_organization(uuid,uuid,text)'),
      ('v4_convert_quotation_for_organization(uuid,uuid,jsonb,text)'),
      ('v4_create_contract_for_organization(uuid,jsonb,text)'),
      ('v4_get_commercial_summary(uuid)'),
      ('v4_import_leads_for_organization(uuid,jsonb,uuid,text)'),
      ('v4_invite_organization_member(uuid,uuid,text,text)'),
      ('v4_register_tenant_file(uuid,text,uuid,text,text,text,bigint,text,text)'),
      ('v4_replace_kpi_targets(uuid,text,jsonb,text)'),
      ('v4_request_commercial_action(uuid,text,jsonb,text)'),
      ('v4_request_platform_action_approval(text,text,jsonb,text)')
  ), actual AS (
    SELECT p.oid, p.oid::regprocedure::text AS regprocedure, p.proconfig,
      pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
      pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  ), violations AS (
    SELECT 'unexpected_authenticated'::text AS violation, actual.regprocedure
    FROM actual LEFT JOIN expected USING (regprocedure)
    WHERE actual.authenticated_execute AND expected.regprocedure IS NULL
    UNION ALL
    SELECT 'missing_expected', expected.regprocedure
    FROM expected LEFT JOIN actual USING (regprocedure)
    WHERE actual.oid IS NULL OR NOT actual.authenticated_execute
    UNION ALL
    SELECT 'anon_execute', actual.regprocedure FROM actual WHERE actual.anon_execute
    UNION ALL
    SELECT 'unsafe_search_path', actual.regprocedure FROM actual
    WHERE NOT (COALESCE(actual.proconfig, ARRAY[]::text[])
      @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[])
  )
  SELECT jsonb_build_object(
    'gate_version', 'sam79-commercial-rpc-allowlist-v6',
    'violations', COALESCE(jsonb_agg(jsonb_build_object(
      'violation', violation, 'regprocedure', regprocedure
    ) ORDER BY violation, regprocedure) FILTER (WHERE violation IS NOT NULL), '[]'::jsonb)
  ) FROM violations
$function$;

COMMIT;
