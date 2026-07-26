-- SAM-61: audit and session evidence is immutable to browser roles.
-- Authenticated callers may read rows allowed by RLS; only service_role or
-- owner-executed triggers/functions may create or mutate evidence.

REVOKE ALL PRIVILEGES ON TABLE
  public.activity_logs,
  public.audit_logs,
  public.user_session_daily
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.activity_logs,
  public.audit_logs,
  public.user_session_daily
TO authenticated;

GRANT ALL PRIVILEGES ON TABLE
  public.activity_logs,
  public.audit_logs,
  public.user_session_daily
TO service_role;

DROP POLICY IF EXISTS boss_admin_see_all_activity ON public.activity_logs;
DROP POLICY IF EXISTS sales_see_own_activity ON public.activity_logs;
DROP POLICY IF EXISTS boss_admin_see_all_sessions ON public.user_session_daily;
DROP POLICY IF EXISTS sales_see_own_sessions ON public.user_session_daily;

DROP POLICY IF EXISTS policy_user_session_daily_update_admin ON public.user_session_daily;
CREATE POLICY policy_user_session_daily_update_none
  ON public.user_session_daily
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS policy_user_session_daily_delete_admin ON public.user_session_daily;
CREATE POLICY policy_user_session_daily_delete_none
  ON public.user_session_daily
  FOR DELETE
  TO authenticated
  USING (false);
