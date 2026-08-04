BEGIN;
DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '') NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam84_agent_gateway_rollback_requires_staging_or_test';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_gateway_commands)
    OR EXISTS (SELECT 1 FROM public.agent_gateway_events)
  THEN RAISE EXCEPTION 'sam84_agent_gateway_rollback_evidence_present'; END IF;
END;
$$;
DROP TABLE public.agent_gateway_events;
DROP TABLE public.agent_gateway_commands;
DROP TABLE public.agent_gateway_adapter_registry;
DROP FUNCTION public.v4_dispatch_agent_gateway_command(
  uuid, uuid, text, text, text, text, text, uuid, text, jsonb, text, text, text, timestamptz
);
DROP FUNCTION public.v4_agent_gateway_records_immutable();
COMMIT;
