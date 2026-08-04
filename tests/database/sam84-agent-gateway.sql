\set ON_ERROR_STOP on

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA extensions TO service_role;
GRANT EXECUTE ON FUNCTION extensions.digest(bytea, text) TO service_role;
CREATE TABLE public.organizations (id uuid PRIMARY KEY, status text NOT NULL);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, is_active boolean NOT NULL);
CREATE FUNCTION public.v4_shared_payload_is_safe(jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
CREATE FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text DEFAULT 'read')
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp AS $$ SELECT true $$;
CREATE TABLE public.shared_approval_requests (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  action_key text NOT NULL, resource_type text NOT NULL, resource_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, payload_sha256 text NOT NULL DEFAULT repeat('a', 64),
  status text NOT NULL DEFAULT 'pending', requested_by uuid NOT NULL REFERENCES public.profiles(id),
  decided_by uuid, decision_reason_code text, idempotency_key text NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

\i /work/supabase/migrations/20260806000000_sam84_controlled_agent_integration_gateway.sql

INSERT INTO public.organizations(id, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active');
INSERT INTO public.profiles(id, is_active) VALUES
  ('22222222-2222-4222-8222-222222222222', true),
  ('33333333-3333-4333-8333-333333333333', false);

BEGIN;
SET ROLE service_role;
DO $$
DECLARE first_result jsonb; replay_result jsonb; l3_result jsonb; l4_result jsonb;
BEGIN
  first_result := public.v4_dispatch_agent_gateway_command(
    '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
    'agent.draft.create', 'L2', 'shared.work.write', 'write', 'server_agent_gateway',
    '44444444-4444-4444-8444-444444444444', 'agt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '{"subject":"synthetic"}'::jsonb,
    encode(extensions.digest(convert_to('{"subject":"synthetic"}'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
    repeat('d', 64), repeat('e', 64), clock_timestamp() + interval '4 minutes'
  );
  replay_result := public.v4_dispatch_agent_gateway_command(
    '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
    'agent.draft.create', 'L2', 'shared.work.write', 'write', 'server_agent_gateway',
    '55555555-5555-4555-8555-555555555555', 'agt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '{"subject":"synthetic"}'::jsonb,
    encode(extensions.digest(convert_to('{"subject":"synthetic"}'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
    repeat('b', 64), repeat('c', 64), clock_timestamp() + interval '4 minutes'
  );
  IF first_result ->> 'status' <> 'accepted' OR replay_result ->> 'idempotent' <> 'true' THEN
    RAISE EXCEPTION 'sam84_idempotent_l2_failed';
  END IF;
  l3_result := public.v4_dispatch_agent_gateway_command(
    '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
    'agent.external.send.request', 'L3', 'shared.approvals.request', 'write', 'server_agent_gateway',
    '66666666-6666-4666-8666-666666666666', 'agt_dddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    '{"subject":"synthetic"}'::jsonb,
    encode(extensions.digest(convert_to('{"subject":"synthetic"}'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
    repeat('e', 64), repeat('f', 64), clock_timestamp() + interval '4 minutes'
  );
  IF l3_result ->> 'status' <> 'approval_required' OR l3_result ->> 'approval_id' IS NULL THEN
    RAISE EXCEPTION 'sam84_l3_approval_binding_failed';
  END IF;
  l4_result := public.v4_dispatch_agent_gateway_command(
    '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
    'agent.authorization.change', 'L4', NULL, 'write', 'server_agent_gateway',
    '77777777-7777-4777-8777-777777777777', 'agt_99999999999999999999999999999999999999999999999999999999',
    '{"subject":"synthetic"}'::jsonb,
    encode(extensions.digest(convert_to('{"subject":"synthetic"}'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
    repeat('1', 64), repeat('2', 64), clock_timestamp() + interval '4 minutes'
  );
  IF l4_result ->> 'status' <> 'denied' THEN RAISE EXCEPTION 'sam84_l4_not_denied'; END IF;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.agent_gateway_commands', 'INSERT')
    OR has_table_privilege('authenticated', 'public.agent_gateway_events', 'SELECT')
    OR has_function_privilege('authenticated', 'public.v4_dispatch_agent_gateway_command(uuid,uuid,text,text,text,text,text,uuid,text,jsonb,text,text,text,timestamp with time zone)', 'EXECUTE')
  THEN RAISE EXCEPTION 'sam84_client_or_agent_direct_database_access'; END IF;
  BEGIN
    UPDATE public.agent_gateway_commands SET status = 'accepted';
    RAISE EXCEPTION 'sam84_command_mutation_allowed';
  EXCEPTION WHEN others THEN NULL; END;
  IF (SELECT count(*) FROM public.agent_gateway_events WHERE event_type = 'command.denied') <> 1 THEN
    RAISE EXCEPTION 'sam84_denial_event_missing';
  END IF;
END;
$$;
ROLLBACK;
