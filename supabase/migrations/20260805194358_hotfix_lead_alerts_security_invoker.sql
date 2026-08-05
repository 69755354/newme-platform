-- Emergency production reconciliation: keep the exposed alert view on caller RLS.
ALTER VIEW public.lead_alerts SET (security_invoker = true);
REVOKE ALL ON TABLE public.lead_alerts FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.lead_alerts TO authenticated;
