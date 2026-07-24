-- SAM-62: harden the active idempotent stage-transition RPC only.

ALTER FUNCTION public.transition_lead_stage(uuid, text, text, text, uuid)
  SET search_path = pg_catalog, public, pg_temp;

-- Browser callers must use the authenticated RPC; do not inherit broad grants.
REVOKE ALL ON FUNCTION public.transition_lead_stage(uuid, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_lead_stage(uuid, text, text, text, uuid)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
