-- CI contract slice of the production hardening migration. Each statement is
-- verbatim from Git blob ed6fbb9dd762d3c6ef5bfe5ac57b44930fb2c7bd.
ALTER FUNCTION public.enforce_followup_required() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.sync_lead_next_followup() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.sync_task_from_lead() SET search_path = pg_catalog, public, pg_temp;
