BEGIN;

-- SAM-84 is a server-only command boundary.  The command and event tables
-- intentionally have no authenticated grants: an agent/browser cannot insert
-- an authoritative actor, organization, capability, approval or signature.
CREATE TABLE public.agent_gateway_commands (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  command_key text NOT NULL CHECK (command_key ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  risk_level text NOT NULL CHECK (risk_level IN ('L0', 'L1', 'L2', 'L3', 'L4')),
  required_capability text,
  access_mode text NOT NULL CHECK (access_mode IN ('read', 'write')),
  channel text NOT NULL CHECK (channel = 'server_agent_gateway'),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^agt_[0-9a-f]{56}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (public.v4_shared_payload_is_safe(payload)),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  event_signature text NOT NULL CHECK (event_signature ~ '^[0-9a-f]{64}$'),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  credential_expires_at timestamptz NOT NULL,
  approval_id uuid REFERENCES public.shared_approval_requests(id) ON DELETE RESTRICT,
  adapter_state text NOT NULL DEFAULT 'disabled' CHECK (adapter_state = 'disabled'),
  status text NOT NULL CHECK (status IN ('accepted', 'approval_required', 'denied')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_gateway_command_idempotency_unique
    UNIQUE (organization_id, actor_user_id, idempotency_key),
  CONSTRAINT agent_gateway_l3_approval_required CHECK (
    (risk_level = 'L3') = (approval_id IS NOT NULL)
  ),
  CONSTRAINT agent_gateway_l4_denied CHECK (
    (risk_level = 'L4') = (status = 'denied')
  ),
  CONSTRAINT agent_gateway_short_lived_credential CHECK (
    credential_expires_at > created_at
    AND credential_expires_at <= created_at + interval '5 minutes'
  )
);

CREATE TABLE public.agent_gateway_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  command_id uuid NOT NULL REFERENCES public.agent_gateway_commands(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('command.recorded', 'command.approval_bound', 'command.denied')),
  event_signature text NOT NULL CHECK (event_signature ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (public.v4_shared_payload_is_safe(metadata)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (command_id, event_type)
);

CREATE TABLE public.agent_gateway_adapter_registry (
  adapter_key text PRIMARY KEY CHECK (adapter_key ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  enabled boolean NOT NULL DEFAULT false CHECK (enabled IS FALSE),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (adapter_key IN ('dld', 'property_portal', 'whatsapp', 'payment_provider', 'e_invoice'))
);

INSERT INTO public.agent_gateway_adapter_registry(adapter_key) VALUES
  ('dld'), ('property_portal'), ('whatsapp'), ('payment_provider'), ('e_invoice');

CREATE INDEX agent_gateway_commands_org_created_idx
  ON public.agent_gateway_commands (organization_id, created_at DESC, id);
CREATE INDEX agent_gateway_events_command_created_idx
  ON public.agent_gateway_events (command_id, created_at, id);

ALTER TABLE public.agent_gateway_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_gateway_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_gateway_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_gateway_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_gateway_adapter_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_gateway_adapter_registry FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_gateway_commands, public.agent_gateway_events,
  public.agent_gateway_adapter_registry FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_gateway_commands, public.agent_gateway_events,
  public.agent_gateway_adapter_registry TO service_role;

CREATE OR REPLACE FUNCTION public.v4_agent_gateway_records_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'agent_gateway_record_immutable';
END;
$$;
REVOKE ALL ON FUNCTION public.v4_agent_gateway_records_immutable()
  FROM PUBLIC, anon, authenticated;
CREATE TRIGGER agent_gateway_commands_immutable
  BEFORE UPDATE OR DELETE ON public.agent_gateway_commands
  FOR EACH ROW EXECUTE FUNCTION public.v4_agent_gateway_records_immutable();
CREATE TRIGGER agent_gateway_events_immutable
  BEFORE UPDATE OR DELETE ON public.agent_gateway_events
  FOR EACH ROW EXECUTE FUNCTION public.v4_agent_gateway_records_immutable();
CREATE TRIGGER agent_gateway_adapters_immutable
  BEFORE UPDATE OR DELETE ON public.agent_gateway_adapter_registry
  FOR EACH ROW EXECUTE FUNCTION public.v4_agent_gateway_records_immutable();

CREATE OR REPLACE FUNCTION public.v4_dispatch_agent_gateway_command(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_command_key text,
  p_risk_level text,
  p_required_capability text,
  p_access_mode text,
  p_channel text,
  p_correlation_id uuid,
  p_idempotency_key text,
  p_payload jsonb,
  p_payload_sha256 text,
  p_event_signature text,
  p_credential_fingerprint text,
  p_credential_expires_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  command_row public.agent_gateway_commands%ROWTYPE;
  approval_row public.shared_approval_requests%ROWTYPE;
  command_id_value uuid := extensions.gen_random_uuid();
  expected_hash text;
  expected_risk text;
  expected_capability text;
  expected_mode text;
  event_type_value text;
  command_status text;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user) <> 'service_role' THEN
    RAISE EXCEPTION 'agent_gateway_server_role_required';
  END IF;
  IF p_channel <> 'server_agent_gateway'
    OR p_command_key NOT IN (
      'agent.policy.describe', 'agent.tenant.summary', 'agent.draft.create',
      'agent.external.send.request', 'agent.authorization.change'
    )
    OR p_risk_level NOT IN ('L0', 'L1', 'L2', 'L3', 'L4')
    OR p_access_mode NOT IN ('read', 'write')
    OR length(p_idempotency_key) <> 60
    OR p_idempotency_key !~ '^agt_[0-9a-f]{56}$'
    OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
    OR p_event_signature !~ '^[0-9a-f]{64}$'
    OR p_credential_fingerprint !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_payload) <> 'object'
    OR p_credential_expires_at <= clock_timestamp()
    OR p_credential_expires_at > clock_timestamp() + interval '5 minutes'
  THEN RAISE EXCEPTION 'agent_gateway_argument_invalid'; END IF;

  SELECT encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex')
  INTO expected_hash;
  IF expected_hash <> p_payload_sha256 THEN RAISE EXCEPTION 'agent_gateway_payload_hash_mismatch'; END IF;

  SELECT risk_level, required_capability, access_mode INTO expected_risk, expected_capability, expected_mode
  FROM (VALUES
    ('agent.policy.describe'::text, 'L0'::text, 'shared.operations.read'::text, 'read'::text),
    ('agent.tenant.summary', 'L1', 'shared.operations.read', 'read'),
    ('agent.draft.create', 'L2', 'shared.work.write', 'write'),
    ('agent.external.send.request', 'L3', 'shared.approvals.request', 'write'),
    ('agent.authorization.change', 'L4', NULL::text, 'write')
  ) AS policy(command_key, risk_level, required_capability, access_mode)
  WHERE policy.command_key = p_command_key;
  IF expected_risk IS NULL OR p_risk_level <> expected_risk
    OR p_required_capability IS DISTINCT FROM expected_capability
    OR p_access_mode <> expected_mode
  THEN RAISE EXCEPTION 'agent_gateway_policy_mismatch'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.id = p_actor_user_id AND profile.is_active IS TRUE
  ) THEN RAISE EXCEPTION 'agent_gateway_actor_inactive'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations organization
    WHERE organization.id = p_organization_id
      AND organization.status IN ('active', 'read_only')
  ) THEN RAISE EXCEPTION 'agent_gateway_organization_unavailable'; END IF;

  SELECT * INTO command_row FROM public.agent_gateway_commands
  WHERE organization_id = p_organization_id
    AND actor_user_id = p_actor_user_id
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF command_row.id IS NOT NULL THEN
    IF command_row.command_key <> p_command_key
      OR command_row.payload_sha256 <> p_payload_sha256
      OR command_row.event_signature <> p_event_signature
      OR command_row.credential_fingerprint <> p_credential_fingerprint
    THEN RAISE EXCEPTION 'agent_gateway_idempotency_mismatch'; END IF;
    RETURN jsonb_build_object(
      'command_id', command_row.id, 'status', command_row.status,
      'risk_level', command_row.risk_level, 'approval_id', command_row.approval_id,
      'correlation_id', command_row.correlation_id, 'idempotent', true,
      'adapter_state', command_row.adapter_state
    );
  END IF;

  IF p_risk_level <> 'L4' AND NOT public.v4_actor_has_capability(
    p_organization_id, p_actor_user_id, p_required_capability, p_access_mode
  ) THEN RAISE EXCEPTION 'agent_gateway_capability_required'; END IF;

  command_status := CASE p_risk_level
    WHEN 'L3' THEN 'approval_required'
    WHEN 'L4' THEN 'denied'
    ELSE 'accepted'
  END;
  IF p_risk_level = 'L3' THEN
    INSERT INTO public.shared_approval_requests(
      organization_id, action_key, resource_type, resource_id, payload,
      requested_by, idempotency_key, expires_at
    ) VALUES (
      p_organization_id, p_command_key, 'agent_command', command_id_value,
      jsonb_build_object(
        'command_key', p_command_key, 'correlation_id', p_correlation_id,
        'payload_sha256', p_payload_sha256, 'event_signature', p_event_signature,
        'credential_fingerprint', p_credential_fingerprint
      ),
      p_actor_user_id, p_idempotency_key, LEAST(p_credential_expires_at, clock_timestamp() + interval '5 minutes')
    ) RETURNING * INTO approval_row;
  END IF;

  INSERT INTO public.agent_gateway_commands(
    id, organization_id, actor_user_id, command_key, risk_level,
    required_capability, access_mode, channel, correlation_id, idempotency_key,
    payload, payload_sha256, event_signature, credential_fingerprint,
    credential_expires_at, approval_id, status
  ) VALUES (
    command_id_value, p_organization_id, p_actor_user_id, p_command_key, p_risk_level,
    p_required_capability, p_access_mode, p_channel, p_correlation_id, p_idempotency_key,
    p_payload, p_payload_sha256, p_event_signature, p_credential_fingerprint,
    p_credential_expires_at, approval_row.id, command_status
  ) RETURNING * INTO command_row;

  event_type_value := CASE p_risk_level
    WHEN 'L3' THEN 'command.approval_bound'
    WHEN 'L4' THEN 'command.denied'
    ELSE 'command.recorded'
  END;
  INSERT INTO public.agent_gateway_events(
    command_id, organization_id, actor_user_id, correlation_id,
    event_type, event_signature, metadata
  ) VALUES (
    command_row.id, p_organization_id, p_actor_user_id, p_correlation_id,
    event_type_value, p_event_signature,
    jsonb_build_object(
      'risk_level', p_risk_level,
      'status', command_status,
      'adapter_state', 'disabled',
      'payload_sha256', p_payload_sha256,
      'credential_fingerprint', p_credential_fingerprint,
      'approval_id', approval_row.id
    )
  );

  RETURN jsonb_build_object(
    'command_id', command_row.id, 'status', command_row.status,
    'risk_level', command_row.risk_level, 'approval_id', command_row.approval_id,
    'correlation_id', command_row.correlation_id, 'idempotent', false,
    'adapter_state', 'disabled'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_dispatch_agent_gateway_command(
  uuid, uuid, text, text, text, text, text, uuid, text, jsonb, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_dispatch_agent_gateway_command(
  uuid, uuid, text, text, text, text, text, uuid, text, jsonb, text, text, text, timestamptz
) TO service_role;

COMMIT;
