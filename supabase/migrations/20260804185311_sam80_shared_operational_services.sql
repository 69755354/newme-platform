BEGIN;

-- SAM-80 / V4-PF-009..012: tenant-scoped shared operational services.
-- Client writes use SECURITY INVOKER RPCs plus RLS. Durable delivery workers
-- are service-role only and never expose their queue tables through PostgREST.

INSERT INTO public.capabilities (capability_key, scope, description)
VALUES
  ('shared.operations.read', 'organization', 'Read tenant-scoped shared operational records.'),
  ('shared.work.write', 'organization', 'Create and transition tenant work items.'),
  ('shared.approvals.request', 'organization', 'Request a tenant operational approval.'),
  ('shared.approvals.decide', 'organization', 'Independently approve or reject tenant operations.'),
  ('shared.notifications.manage', 'organization', 'Manage organization notification state.'),
  ('shared.jobs.import', 'organization', 'Run bounded tenant work-item imports.'),
  ('shared.jobs.export', 'organization', 'Request a complete tenant export.'),
  ('shared.jobs.report', 'organization', 'Generate deterministic tenant operational reports.')
ON CONFLICT (scope, capability_key) DO UPDATE
SET description = EXCLUDED.description;

INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id
FROM public.roles role
CROSS JOIN public.capabilities capability
WHERE role.scope = 'organization'
  AND capability.scope = 'organization'
  AND (
    (capability.capability_key IN ('shared.operations.read', 'shared.jobs.report')
      AND role.role_key IN ('org_owner', 'org_admin', 'operations', 'finance', 'specialist', 'sales_agent'))
    OR (capability.capability_key IN ('shared.work.write', 'shared.approvals.request')
      AND role.role_key IN ('org_owner', 'org_admin', 'operations', 'specialist', 'sales_agent'))
    OR (capability.capability_key IN ('shared.approvals.decide', 'shared.notifications.manage')
      AND role.role_key IN ('org_owner', 'org_admin', 'operations'))
    OR (capability.capability_key = 'shared.jobs.import'
      AND role.role_key IN ('org_owner', 'org_admin', 'operations'))
    OR (capability.capability_key = 'shared.jobs.export'
      AND role.role_key IN ('org_owner', 'org_admin', 'finance'))
  )
ON CONFLICT (role_id, capability_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.v4_shared_payload_is_safe(
  p_payload jsonb,
  p_depth integer DEFAULT 0
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  entry record;
  element jsonb;
  scalar text;
BEGIN
  IF p_payload IS NULL OR p_depth > 6 OR pg_column_size(p_payload) > 8192 THEN
    RETURN FALSE;
  END IF;
  CASE jsonb_typeof(p_payload)
    WHEN 'object' THEN
      FOR entry IN SELECT key, value FROM jsonb_each(p_payload) LOOP
        IF entry.key !~ '^[a-z][a-z0-9_]{0,63}$'
          OR entry.key ~* '(authorization|cookie|password|secret|token|email|phone|address|customer_name|full_name|message|description|body)'
          OR NOT public.v4_shared_payload_is_safe(entry.value, p_depth + 1)
        THEN RETURN FALSE; END IF;
      END LOOP;
    WHEN 'array' THEN
      IF jsonb_array_length(p_payload) > 100 THEN RETURN FALSE; END IF;
      FOR element IN SELECT value FROM jsonb_array_elements(p_payload) LOOP
        IF NOT public.v4_shared_payload_is_safe(element, p_depth + 1) THEN
          RETURN FALSE;
        END IF;
      END LOOP;
    WHEN 'string' THEN
      scalar := p_payload #>> '{}';
      IF length(scalar) > 256
        OR scalar ~* '(bearer[[:space:]]+[a-z0-9._-]+|-----begin[[:space:]].*private key-----|https?://[^/@[:space:]]+:[^/@[:space:]]+@)'
      THEN RETURN FALSE; END IF;
    WHEN 'number', 'boolean', 'null' THEN NULL;
    ELSE RETURN FALSE;
  END CASE;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.v4_shared_payload_is_safe(jsonb, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_shared_payload_is_safe(jsonb, integer)
  TO authenticated, service_role;

CREATE TABLE public.shared_work_items (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  details text CHECK (details IS NULL OR length(details) <= 2000),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_user_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  source_type text CHECK (source_type IS NULL OR source_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  source_id uuid,
  due_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT shared_work_items_org_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT shared_work_items_completion_consistent CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE TABLE public.shared_approval_requests (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  action_key text NOT NULL CHECK (action_key ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  resource_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (public.v4_shared_payload_is_safe(payload)),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decided_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decision_reason_code text CHECK (
    decision_reason_code IS NULL OR decision_reason_code ~ '^[a-z][a-z0-9_.-]{2,95}$'
  ),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT shared_approval_org_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT shared_approval_decision_consistent CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'expired' AND decided_at IS NOT NULL)
  ),
  CONSTRAINT shared_approval_distinct_decider CHECK (
    decided_by IS NULL OR decided_by <> requested_by
  )
);

CREATE TABLE public.shared_timeline_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  resource_id uuid,
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'customer')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (public.v4_shared_payload_is_safe(metadata)),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 8 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.shared_notifications (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  recipient_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  channel text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'webhook')),
  template_key text NOT NULL CHECK (template_key ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (public.v4_shared_payload_is_safe(payload)),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'failed', 'dead_letter')),
  source_event_id uuid REFERENCES public.shared_timeline_events(id) ON DELETE RESTRICT,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 8 AND 160),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  read_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT shared_notifications_org_dedupe_unique UNIQUE (organization_id, dedupe_key)
);

CREATE TABLE public.shared_outbox (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  aggregate_id uuid,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (public.v4_shared_payload_is_safe(payload)),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 8 AND 160),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'delivered', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_by text,
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT shared_outbox_org_dedupe_unique UNIQUE (organization_id, dedupe_key),
  CONSTRAINT shared_outbox_lease_consistent CHECK (
    (state = 'processing' AND leased_by IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'processing' AND leased_by IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE public.shared_jobs (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('work_items_import', 'organization_export', 'operations_report')),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'completed', 'failed', 'dead_letter')),
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (public.v4_shared_payload_is_safe(parameters)),
  input_file_id uuid REFERENCES public.tenant_file_objects(id) ON DELETE RESTRICT,
  output_file_id uuid REFERENCES public.tenant_file_objects(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_by text,
  lease_expires_at timestamptz,
  result_counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (public.v4_shared_payload_is_safe(result_counts)),
  result_sha256 text CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT shared_jobs_org_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT shared_jobs_lease_consistent CHECK (
    (state = 'running' AND leased_by IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'running' AND leased_by IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE public.shared_report_snapshots (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  report_key text NOT NULL CHECK (report_key ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  period_start date NOT NULL,
  period_end date NOT NULL,
  metrics jsonb NOT NULL CHECK (public.v4_shared_payload_is_safe(metrics)),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  generated_by_job_id uuid NOT NULL UNIQUE REFERENCES public.shared_jobs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT shared_report_period_valid CHECK (period_end >= period_start),
  CONSTRAINT shared_report_org_period_unique UNIQUE (organization_id, report_key, period_start, period_end)
);

CREATE INDEX shared_work_items_org_status_due_idx
  ON public.shared_work_items (organization_id, status, due_at, created_at DESC);
CREATE INDEX shared_approvals_org_status_expiry_idx
  ON public.shared_approval_requests (organization_id, status, expires_at);
CREATE INDEX shared_timeline_org_created_idx
  ON public.shared_timeline_events (organization_id, created_at DESC, id);
CREATE INDEX shared_notifications_recipient_idx
  ON public.shared_notifications (organization_id, recipient_user_id, read_at, created_at DESC);
CREATE INDEX shared_outbox_claim_idx
  ON public.shared_outbox (state, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX shared_jobs_claim_idx
  ON public.shared_jobs (state, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX shared_reports_org_period_idx
  ON public.shared_report_snapshots (organization_id, report_key, period_end DESC);

ALTER TABLE public.shared_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_work_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shared_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_approval_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shared_timeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_timeline_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shared_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shared_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shared_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shared_report_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_report_snapshots FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shared_work_items, public.shared_approval_requests,
  public.shared_timeline_events, public.shared_notifications, public.shared_outbox,
  public.shared_jobs, public.shared_report_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.shared_work_items,
  public.shared_approval_requests, public.shared_jobs TO authenticated;
GRANT SELECT ON TABLE public.shared_timeline_events,
  public.shared_report_snapshots TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.shared_notifications TO authenticated;
GRANT ALL ON TABLE public.shared_work_items, public.shared_approval_requests,
  public.shared_timeline_events, public.shared_notifications, public.shared_outbox,
  public.shared_jobs, public.shared_report_snapshots TO service_role;

CREATE POLICY shared_work_items_read ON public.shared_work_items
  FOR SELECT TO authenticated USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.operations.read', 'read')
  );
CREATE POLICY shared_work_items_insert ON public.shared_work_items
  FOR INSERT TO authenticated WITH CHECK (
    organization_id = public.requested_organization_id()
    AND created_by = auth.uid()
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.work.write', 'write')
  );
CREATE POLICY shared_work_items_update ON public.shared_work_items
  FOR UPDATE TO authenticated USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.work.write', 'write')
  ) WITH CHECK (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.work.write', 'write')
  );

CREATE POLICY shared_approvals_read ON public.shared_approval_requests
  FOR SELECT TO authenticated USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.operations.read', 'read')
  );
CREATE POLICY shared_approvals_insert ON public.shared_approval_requests
  FOR INSERT TO authenticated WITH CHECK (
    organization_id = public.requested_organization_id()
    AND requested_by = auth.uid()
    AND status = 'pending'
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.approvals.request', 'write')
  );
CREATE POLICY shared_approvals_update ON public.shared_approval_requests
  FOR UPDATE TO authenticated USING (
    organization_id = public.requested_organization_id()
    AND status = 'pending'
    AND requested_by <> auth.uid()
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.approvals.decide', 'write')
  ) WITH CHECK (
    organization_id = public.requested_organization_id()
    AND decided_by = auth.uid()
    AND requested_by <> auth.uid()
    AND status IN ('approved', 'rejected')
  );

CREATE POLICY shared_timeline_read ON public.shared_timeline_events
  FOR SELECT TO authenticated USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.operations.read', 'read')
  );

CREATE POLICY shared_notifications_read ON public.shared_notifications
  FOR SELECT TO authenticated USING (
    organization_id = public.requested_organization_id()
    AND (recipient_user_id = auth.uid()
      OR public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.notifications.manage', 'read'))
  );
CREATE POLICY shared_notifications_update ON public.shared_notifications
  FOR UPDATE TO authenticated USING (
    organization_id = public.requested_organization_id()
    AND recipient_user_id = auth.uid()
  ) WITH CHECK (
    organization_id = public.requested_organization_id()
    AND recipient_user_id = auth.uid()
  );

CREATE POLICY shared_jobs_read ON public.shared_jobs
  FOR SELECT TO authenticated USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.operations.read', 'read')
  );
CREATE POLICY shared_jobs_insert ON public.shared_jobs
  FOR INSERT TO authenticated WITH CHECK (
    organization_id = public.requested_organization_id()
    AND requested_by = auth.uid()
    AND state = 'queued'
    AND CASE kind
      WHEN 'work_items_import' THEN public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.jobs.import', 'write')
      WHEN 'organization_export' THEN public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.jobs.export', 'export')
      WHEN 'operations_report' THEN public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.jobs.report', 'read')
      ELSE FALSE
    END
  );

CREATE POLICY shared_reports_read ON public.shared_report_snapshots
  FOR SELECT TO authenticated USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(organization_id, auth.uid(), 'shared.jobs.report', 'read')
  );

CREATE OR REPLACE FUNCTION public.v4_shared_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END;
$$;
REVOKE ALL ON FUNCTION public.v4_shared_touch_updated_at() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.v4_shared_work_item_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id <> OLD.organization_id OR NEW.created_by <> OLD.created_by
      OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at
    THEN RAISE EXCEPTION 'shared_work_item_immutable_boundary'; END IF;
    IF OLD.status IN ('completed', 'cancelled') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'shared_work_item_terminal';
    END IF;
    NEW.completed_at := CASE WHEN NEW.status = 'completed'
      THEN COALESCE(OLD.completed_at, clock_timestamp()) ELSE NULL END;
  END IF;
  IF NEW.assignee_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.memberships membership
    JOIN public.profiles profile ON profile.id = membership.user_id
    WHERE membership.organization_id = NEW.organization_id
      AND membership.user_id = NEW.assignee_user_id
      AND membership.status = 'active' AND membership.accepted_at IS NOT NULL
      AND profile.is_active IS TRUE
  ) THEN RAISE EXCEPTION 'shared_work_item_assignee_not_active_member'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.v4_shared_work_item_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.v4_shared_approval_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.payload_sha256 := encode(
      extensions.digest(convert_to(NEW.payload::text, 'UTF8'), 'sha256'), 'hex'
    );
    IF NEW.expires_at <= clock_timestamp() OR NEW.expires_at > clock_timestamp() + interval '7 days' THEN
      RAISE EXCEPTION 'shared_approval_expiry_invalid';
    END IF;
  ELSE
    IF NEW.organization_id <> OLD.organization_id OR NEW.action_key <> OLD.action_key
      OR NEW.resource_type <> OLD.resource_type OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
      OR NEW.payload <> OLD.payload OR NEW.payload_sha256 <> OLD.payload_sha256
      OR NEW.requested_by <> OLD.requested_by
      OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.expires_at <> OLD.expires_at
      OR NEW.created_at <> OLD.created_at
    THEN RAISE EXCEPTION 'shared_approval_immutable_boundary'; END IF;
    IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'shared_approval_terminal'; END IF;
    IF OLD.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'shared_approval_expired'; END IF;
    NEW.decided_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.v4_shared_approval_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.v4_shared_notification_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'service_role' THEN
    IF NEW.organization_id <> OLD.organization_id OR NEW.recipient_user_id <> OLD.recipient_user_id
      OR NEW.channel <> OLD.channel OR NEW.template_key <> OLD.template_key
      OR NEW.payload <> OLD.payload OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
      OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.read_at IS DISTINCT FROM OLD.read_at
      OR NEW.created_at <> OLD.created_at
    THEN RAISE EXCEPTION 'shared_notification_service_boundary'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.recipient_user_id <> OLD.recipient_user_id
    OR NEW.channel <> OLD.channel OR NEW.template_key <> OLD.template_key
    OR NEW.payload <> OLD.payload OR NEW.state <> OLD.state OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
    OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.attempts <> OLD.attempts
    OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at OR NEW.created_at <> OLD.created_at
  THEN RAISE EXCEPTION 'shared_notification_only_read_at_mutable'; END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'shared_notification_read_at_immutable';
  END IF;
  NEW.read_at := COALESCE(OLD.read_at, clock_timestamp());
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.v4_shared_notification_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.v4_shared_emit_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  event_id uuid := extensions.gen_random_uuid();
  actor_id uuid;
  event_type_value text;
  resource_type_value text;
  status_value text;
  request_id_value text;
  assignee_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'shared_work_items' THEN
    actor_id := COALESCE(auth.uid(), NEW.created_by);
    event_type_value := 'work_item.' || NEW.status;
    resource_type_value := 'work_item';
    status_value := NEW.status;
    request_id_value := NEW.idempotency_key;
    assignee_id := NEW.assignee_user_id;
  ELSIF TG_TABLE_NAME = 'shared_approval_requests' THEN
    actor_id := COALESCE(auth.uid(), NEW.decided_by, NEW.requested_by);
    event_type_value := 'approval.' || NEW.status;
    resource_type_value := 'approval';
    status_value := NEW.status;
    request_id_value := NEW.idempotency_key;
  ELSIF TG_TABLE_NAME = 'shared_jobs' THEN
    actor_id := COALESCE(auth.uid(), NEW.requested_by);
    event_type_value := 'job.' || NEW.state;
    resource_type_value := 'job';
    status_value := NEW.state;
    request_id_value := NEW.idempotency_key;
  ELSE
    RAISE EXCEPTION 'shared_event_source_invalid';
  END IF;
  INSERT INTO public.shared_timeline_events(
    id, organization_id, event_type, resource_type, resource_id,
    actor_user_id, metadata, request_id
  ) VALUES (
    event_id, NEW.organization_id, event_type_value, resource_type_value,
    NEW.id, actor_id,
    jsonb_build_object('status', status_value), request_id_value
  );
  INSERT INTO public.shared_outbox(
    organization_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key
  ) VALUES (
    NEW.organization_id, TG_TABLE_NAME, NEW.id,
    CASE TG_TABLE_NAME
      WHEN 'shared_work_items' THEN 'work_item.changed'
      WHEN 'shared_approval_requests' THEN 'approval.changed'
      ELSE 'job.changed' END,
    jsonb_build_object('resource_id', NEW.id, 'event_id', event_id),
    TG_TABLE_NAME || ':' || NEW.id::text || ':' || COALESCE(NEW.updated_at, NEW.created_at)::text
  ) ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
  IF assignee_id IS NOT NULL THEN
    INSERT INTO public.shared_notifications(
      organization_id, recipient_user_id, template_key, payload,
      state, source_event_id, dedupe_key
    ) VALUES (
      NEW.organization_id, assignee_id, 'work_item.changed',
      jsonb_build_object('work_item_id', NEW.id, 'status', status_value),
      'pending', event_id,
      'work-item:' || NEW.id::text || ':' || NEW.updated_at::text
    ) ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.v4_shared_emit_event() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER shared_work_items_guard BEFORE INSERT OR UPDATE ON public.shared_work_items
  FOR EACH ROW EXECUTE FUNCTION public.v4_shared_work_item_guard();
CREATE TRIGGER shared_work_items_touch BEFORE UPDATE ON public.shared_work_items
  FOR EACH ROW EXECUTE FUNCTION public.v4_shared_touch_updated_at();
CREATE TRIGGER shared_work_items_event AFTER INSERT OR UPDATE OF status, assignee_user_id, due_at
  ON public.shared_work_items FOR EACH ROW EXECUTE FUNCTION public.v4_shared_emit_event();
CREATE TRIGGER shared_approval_guard BEFORE INSERT OR UPDATE ON public.shared_approval_requests
  FOR EACH ROW EXECUTE FUNCTION public.v4_shared_approval_guard();
CREATE TRIGGER shared_approval_touch BEFORE UPDATE ON public.shared_approval_requests
  FOR EACH ROW EXECUTE FUNCTION public.v4_shared_touch_updated_at();
CREATE TRIGGER shared_approval_event AFTER INSERT OR UPDATE OF status
  ON public.shared_approval_requests FOR EACH ROW EXECUTE FUNCTION public.v4_shared_emit_event();
CREATE TRIGGER shared_notification_guard BEFORE UPDATE ON public.shared_notifications
  FOR EACH ROW EXECUTE FUNCTION public.v4_shared_notification_guard();
CREATE TRIGGER shared_notification_touch BEFORE UPDATE ON public.shared_notifications
  FOR EACH ROW EXECUTE FUNCTION public.v4_shared_touch_updated_at();
CREATE TRIGGER shared_jobs_touch BEFORE UPDATE ON public.shared_jobs
  FOR EACH ROW EXECUTE FUNCTION public.v4_shared_touch_updated_at();
CREATE TRIGGER shared_jobs_event AFTER INSERT OR UPDATE OF state
  ON public.shared_jobs FOR EACH ROW EXECUTE FUNCTION public.v4_shared_emit_event();

CREATE OR REPLACE FUNCTION public.v4_create_shared_work_item(
  p_organization_id uuid, p_title text, p_details text, p_priority text,
  p_assignee_user_id uuid, p_due_at timestamptz, p_source_type text,
  p_source_id uuid, p_idempotency_key text
)
RETURNS public.shared_work_items
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.shared_work_items;
BEGIN
  INSERT INTO public.shared_work_items(
    organization_id, title, details, priority, assignee_user_id, due_at,
    source_type, source_id, idempotency_key, created_by
  ) VALUES (
    p_organization_id, btrim(p_title), NULLIF(btrim(p_details), ''), p_priority,
    p_assignee_user_id, p_due_at, p_source_type, p_source_id,
    p_idempotency_key, auth.uid()
  ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING * INTO result;
  IF result.id IS NULL THEN
    SELECT * INTO result FROM public.shared_work_items
    WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;
    IF result.title <> btrim(p_title) OR result.assignee_user_id IS DISTINCT FROM p_assignee_user_id THEN
      RAISE EXCEPTION 'shared_work_item_idempotency_conflict';
    END IF;
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_transition_shared_work_item(
  p_organization_id uuid, p_work_item_id uuid, p_status text
)
RETURNS public.shared_work_items
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.shared_work_items;
BEGIN
  UPDATE public.shared_work_items SET status = p_status
  WHERE id = p_work_item_id AND organization_id = p_organization_id
  RETURNING * INTO result;
  IF result.id IS NULL THEN RAISE EXCEPTION 'shared_work_item_not_found'; END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_request_shared_approval(
  p_organization_id uuid, p_action_key text, p_resource_type text,
  p_resource_id uuid, p_payload jsonb, p_expires_at timestamptz,
  p_idempotency_key text
)
RETURNS public.shared_approval_requests
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.shared_approval_requests;
BEGIN
  INSERT INTO public.shared_approval_requests(
    organization_id, action_key, resource_type, resource_id, payload,
    requested_by, idempotency_key, expires_at
  ) VALUES (
    p_organization_id, p_action_key, p_resource_type, p_resource_id,
    COALESCE(p_payload, '{}'::jsonb), auth.uid(), p_idempotency_key, p_expires_at
  ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING * INTO result;
  IF result.id IS NULL THEN
    SELECT * INTO result FROM public.shared_approval_requests
    WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;
    IF result.action_key <> p_action_key OR result.payload <> COALESCE(p_payload, '{}'::jsonb) THEN
      RAISE EXCEPTION 'shared_approval_idempotency_conflict';
    END IF;
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_decide_shared_approval(
  p_organization_id uuid, p_approval_id uuid, p_decision text,
  p_reason_code text
)
RETURNS public.shared_approval_requests
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.shared_approval_requests;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'shared_approval_decision_invalid';
  END IF;
  UPDATE public.shared_approval_requests
  SET status = p_decision, decided_by = auth.uid(), decision_reason_code = p_reason_code
  WHERE id = p_approval_id AND organization_id = p_organization_id
  RETURNING * INTO result;
  IF result.id IS NULL THEN RAISE EXCEPTION 'shared_approval_not_found_or_forbidden'; END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_create_shared_job(
  p_organization_id uuid, p_kind text, p_parameters jsonb,
  p_input_file_id uuid, p_idempotency_key text
)
RETURNS public.shared_jobs
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.shared_jobs;
BEGIN
  IF p_input_file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tenant_file_objects file_object
    WHERE file_object.id = p_input_file_id
      AND file_object.organization_id = p_organization_id
      AND file_object.status = 'available'
  ) THEN RAISE EXCEPTION 'shared_job_input_file_unavailable'; END IF;
  INSERT INTO public.shared_jobs(
    organization_id, kind, parameters, input_file_id, requested_by, idempotency_key
  ) VALUES (
    p_organization_id, p_kind, COALESCE(p_parameters, '{}'::jsonb),
    p_input_file_id, auth.uid(), p_idempotency_key
  ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING * INTO result;
  IF result.id IS NULL THEN
    SELECT * INTO result FROM public.shared_jobs
    WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;
    IF result.kind <> p_kind OR result.parameters <> COALESCE(p_parameters, '{}'::jsonb) THEN
      RAISE EXCEPTION 'shared_job_idempotency_conflict';
    END IF;
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_mark_shared_notification_read(
  p_organization_id uuid, p_notification_id uuid
)
RETURNS public.shared_notifications
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.shared_notifications;
BEGIN
  UPDATE public.shared_notifications SET read_at = COALESCE(read_at, clock_timestamp())
  WHERE id = p_notification_id AND organization_id = p_organization_id
  RETURNING * INTO result;
  IF result.id IS NULL THEN RAISE EXCEPTION 'shared_notification_not_found'; END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.v4_create_shared_work_item(uuid,text,text,text,uuid,timestamptz,text,uuid,text),
  public.v4_transition_shared_work_item(uuid,uuid,text),
  public.v4_request_shared_approval(uuid,text,text,uuid,jsonb,timestamptz,text),
  public.v4_decide_shared_approval(uuid,uuid,text,text),
  public.v4_create_shared_job(uuid,text,jsonb,uuid,text),
  public.v4_mark_shared_notification_read(uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_create_shared_work_item(uuid,text,text,text,uuid,timestamptz,text,uuid,text),
  public.v4_transition_shared_work_item(uuid,uuid,text),
  public.v4_request_shared_approval(uuid,text,text,uuid,jsonb,timestamptz,text),
  public.v4_decide_shared_approval(uuid,uuid,text,text),
  public.v4_create_shared_job(uuid,text,jsonb,uuid,text),
  public.v4_mark_shared_notification_read(uuid,uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_claim_shared_outbox(
  p_batch_size integer, p_worker_id text, p_lease_seconds integer
)
RETURNS SETOF public.shared_outbox
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user <> 'service_role' OR p_batch_size NOT BETWEEN 1 AND 100
    OR length(p_worker_id) NOT BETWEEN 3 AND 128 OR p_lease_seconds NOT BETWEEN 10 AND 600
  THEN RAISE EXCEPTION 'shared_outbox_claim_invalid'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM public.shared_outbox
    WHERE (state = 'pending' AND next_attempt_at <= clock_timestamp())
       OR (state = 'processing' AND lease_expires_at <= clock_timestamp())
    ORDER BY next_attempt_at, created_at, id
    FOR UPDATE SKIP LOCKED LIMIT p_batch_size
  )
  UPDATE public.shared_outbox target
  SET state = 'processing', attempts = target.attempts + 1,
      leased_by = p_worker_id,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
  FROM candidates WHERE target.id = candidates.id RETURNING target.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_complete_shared_outbox(
  p_outbox_id uuid, p_worker_id text, p_succeeded boolean, p_error_code text
)
RETURNS public.shared_outbox
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.shared_outbox;
BEGIN
  UPDATE public.shared_outbox target SET
    state = CASE WHEN p_succeeded THEN 'delivered'
      WHEN target.attempts >= target.max_attempts THEN 'dead_letter' ELSE 'pending' END,
    next_attempt_at = CASE WHEN p_succeeded OR target.attempts >= target.max_attempts
      THEN target.next_attempt_at
      ELSE clock_timestamp() + make_interval(secs => LEAST(3600, 15 * (2 ^ target.attempts)::integer)) END,
    leased_by = NULL, lease_expires_at = NULL,
    last_error_code = CASE WHEN p_succeeded THEN NULL ELSE p_error_code END,
    delivered_at = CASE WHEN p_succeeded THEN clock_timestamp() ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE target.id = p_outbox_id AND target.state = 'processing'
    AND target.leased_by = p_worker_id AND target.lease_expires_at > clock_timestamp()
  RETURNING * INTO result;
  IF result.id IS NULL THEN RAISE EXCEPTION 'shared_outbox_lease_invalid'; END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_claim_shared_jobs(
  p_batch_size integer, p_worker_id text, p_lease_seconds integer
)
RETURNS SETOF public.shared_jobs
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user <> 'service_role' OR p_batch_size NOT BETWEEN 1 AND 20
    OR length(p_worker_id) NOT BETWEEN 3 AND 128 OR p_lease_seconds NOT BETWEEN 10 AND 600
  THEN RAISE EXCEPTION 'shared_jobs_claim_invalid'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM public.shared_jobs
    WHERE (state IN ('queued', 'failed') AND next_attempt_at <= clock_timestamp())
       OR (state = 'running' AND lease_expires_at <= clock_timestamp())
    ORDER BY next_attempt_at, created_at, id
    FOR UPDATE SKIP LOCKED LIMIT p_batch_size
  )
  UPDATE public.shared_jobs target
  SET state = 'running', attempts = target.attempts + 1,
      leased_by = p_worker_id,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      started_at = COALESCE(target.started_at, clock_timestamp()),
      updated_at = clock_timestamp()
  FROM candidates WHERE target.id = candidates.id RETURNING target.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_complete_shared_job(
  p_job_id uuid, p_worker_id text, p_succeeded boolean,
  p_result_counts jsonb, p_result_sha256 text, p_error_code text
)
RETURNS public.shared_jobs
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.shared_jobs;
BEGIN
  IF NOT public.v4_shared_payload_is_safe(COALESCE(p_result_counts, '{}'::jsonb)) THEN
    RAISE EXCEPTION 'shared_job_result_unsafe';
  END IF;
  IF p_succeeded AND COALESCE(p_result_sha256, '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'shared_job_result_digest_required';
  END IF;
  UPDATE public.shared_jobs target SET
    state = CASE WHEN p_succeeded THEN 'completed'
      WHEN target.attempts >= target.max_attempts THEN 'dead_letter' ELSE 'failed' END,
    next_attempt_at = CASE WHEN p_succeeded OR target.attempts >= target.max_attempts
      THEN target.next_attempt_at
      ELSE clock_timestamp() + make_interval(secs => LEAST(3600, 30 * (2 ^ target.attempts)::integer)) END,
    leased_by = NULL, lease_expires_at = NULL,
    result_counts = COALESCE(p_result_counts, '{}'::jsonb),
    result_sha256 = CASE WHEN p_succeeded THEN p_result_sha256 ELSE NULL END,
    error_code = CASE WHEN p_succeeded THEN NULL ELSE p_error_code END,
    completed_at = CASE WHEN p_succeeded OR target.attempts >= target.max_attempts
      THEN clock_timestamp() ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE target.id = p_job_id AND target.state = 'running'
    AND target.leased_by = p_worker_id AND target.lease_expires_at > clock_timestamp()
  RETURNING * INTO result;
  IF result.id IS NULL THEN RAISE EXCEPTION 'shared_job_lease_invalid'; END IF;
  IF p_succeeded AND result.kind = 'operations_report' THEN
    INSERT INTO public.shared_report_snapshots(
      organization_id, report_key, period_start, period_end, metrics,
      source_sha256, generated_by_job_id
    ) VALUES (
      result.organization_id, 'operations.summary',
      COALESCE(NULLIF(result.parameters ->> 'period_start', '')::date, current_date),
      COALESCE(NULLIF(result.parameters ->> 'period_end', '')::date, current_date),
      result.result_counts, result.result_sha256, result.id
    ) ON CONFLICT (organization_id, report_key, period_start, period_end)
    DO UPDATE SET metrics = EXCLUDED.metrics, source_sha256 = EXCLUDED.source_sha256,
      generated_by_job_id = EXCLUDED.generated_by_job_id,
      created_at = clock_timestamp();
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_requeue_shared_dead_letter(
  p_organization_id uuid, p_queue_kind text, p_record_id uuid,
  p_actor_user_id uuid, p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE changed integer;
BEGIN
  IF current_user <> 'service_role'
    OR length(COALESCE(p_request_id, '')) NOT BETWEEN 8 AND 160
    OR NOT public.v4_actor_has_capability(
      p_organization_id, p_actor_user_id, 'shared.notifications.manage', 'write'
    )
  THEN RAISE EXCEPTION 'shared_dead_letter_requeue_forbidden'; END IF;
  IF p_queue_kind = 'outbox' THEN
    UPDATE public.shared_outbox SET state = 'pending', attempts = 0,
      next_attempt_at = clock_timestamp(), last_error_code = NULL,
      leased_by = NULL, lease_expires_at = NULL, delivered_at = NULL,
      updated_at = clock_timestamp()
    WHERE id = p_record_id AND organization_id = p_organization_id
      AND state = 'dead_letter';
  ELSIF p_queue_kind = 'job' THEN
    UPDATE public.shared_jobs SET state = 'queued', attempts = 0,
      next_attempt_at = clock_timestamp(), error_code = NULL,
      leased_by = NULL, lease_expires_at = NULL, completed_at = NULL,
      updated_at = clock_timestamp()
    WHERE id = p_record_id AND organization_id = p_organization_id
      AND state = 'dead_letter';
  ELSE RAISE EXCEPTION 'shared_dead_letter_kind_invalid'; END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'shared_dead_letter_not_found'; END IF;
  INSERT INTO public.audit_events(
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, p_actor_user_id, 'shared.dead_letter.requeued',
    p_queue_kind, p_record_id::text, 'success', 'bounded_operator_recovery',
    p_request_id, jsonb_build_object('queue_kind', p_queue_kind)
  );
  RETURN jsonb_build_object('queue_kind', p_queue_kind, 'id', p_record_id, 'state', 'queued');
END;
$$;

REVOKE ALL ON FUNCTION public.v4_claim_shared_outbox(integer,text,integer),
  public.v4_complete_shared_outbox(uuid,text,boolean,text),
  public.v4_claim_shared_jobs(integer,text,integer),
  public.v4_complete_shared_job(uuid,text,boolean,jsonb,text,text),
  public.v4_requeue_shared_dead_letter(uuid,text,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_claim_shared_outbox(integer,text,integer),
  public.v4_complete_shared_outbox(uuid,text,boolean,text),
  public.v4_claim_shared_jobs(integer,text,integer),
  public.v4_complete_shared_job(uuid,text,boolean,jsonb,text,text),
  public.v4_requeue_shared_dead_letter(uuid,text,uuid,uuid,text)
  TO service_role;

CREATE OR REPLACE VIEW public.v4_shared_operations_summary
WITH (security_invoker = true)
AS
SELECT organization.id AS organization_id,
  (SELECT count(*) FROM public.shared_work_items item
    WHERE item.organization_id = organization.id AND item.status NOT IN ('completed', 'cancelled')) AS open_work_items,
  (SELECT count(*) FROM public.shared_approval_requests approval
    WHERE approval.organization_id = organization.id AND approval.status = 'pending') AS pending_approvals,
  (SELECT count(*) FROM public.shared_notifications notification
    WHERE notification.organization_id = organization.id AND notification.read_at IS NULL) AS unread_notifications,
  (SELECT count(*) FROM public.shared_jobs job
    WHERE job.organization_id = organization.id AND job.state IN ('queued', 'running', 'failed')) AS active_jobs,
  (SELECT count(*) FROM public.shared_outbox outbox
    WHERE outbox.organization_id = organization.id AND outbox.state = 'dead_letter') AS dead_letters
FROM public.organizations organization
WHERE organization.id = public.requested_organization_id()
  AND public.v4_actor_has_capability(organization.id, auth.uid(), 'shared.operations.read', 'read');

REVOKE ALL ON TABLE public.v4_shared_operations_summary FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.v4_shared_operations_summary TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
