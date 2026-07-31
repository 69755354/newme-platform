-- SAM-26 runner uses service_role only for marker-bound profile reads/updates
-- and fixed-ID count verification. Fixture writes stay on the local psql path.
GRANT SELECT, UPDATE ON TABLE public.profiles TO service_role;

GRANT SELECT ON TABLE
  public.leads,
  public.activities,
  public.tasks,
  public.business_events,
  public.notifications
TO service_role;
