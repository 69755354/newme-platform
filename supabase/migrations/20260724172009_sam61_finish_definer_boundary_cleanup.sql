-- Close the remaining SAM-61 boundaries exposed by a clean-room rebuild.

ALTER VIEW public.lead_funnel_daily SET (security_invoker = true);
ALTER VIEW public.pipeline_summary SET (security_invoker = true);
ALTER VIEW public.sales_performance SET (security_invoker = true);

ALTER FUNCTION public.create_business_event(uuid, text, uuid, text, jsonb, uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auto_assign_lead() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.assign_new_lead(text, text, text, text, text, text, text) SET search_path = pg_catalog, public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.auto_assign_lead() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_assign_lead() TO service_role;
REVOKE EXECUTE ON FUNCTION public.assign_new_lead(text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_new_lead(text, text, text, text, text, text, text) TO service_role;
