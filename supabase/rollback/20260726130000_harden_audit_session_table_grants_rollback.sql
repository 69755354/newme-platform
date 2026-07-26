-- Emergency rollback for 20260726130000_harden_audit_session_table_grants.sql.
-- This intentionally restores the previous broad Supabase table grants and
-- admin session-mutation policies. Use only after an explicit security review.

GRANT ALL PRIVILEGES ON TABLE
  public.activity_logs,
  public.audit_logs,
  public.user_session_daily
TO anon, authenticated, service_role;

DROP POLICY IF EXISTS policy_user_session_daily_update_none ON public.user_session_daily;
CREATE POLICY policy_user_session_daily_update_admin
  ON public.user_session_daily
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'boss')
    )
  );

DROP POLICY IF EXISTS policy_user_session_daily_delete_none ON public.user_session_daily;
CREATE POLICY policy_user_session_daily_delete_admin
  ON public.user_session_daily
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'boss')
    )
  );

CREATE POLICY boss_admin_see_all_activity
  ON public.activity_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = auth.uid()
        AND role IN ('boss', 'admin')
    )
  );

CREATE POLICY sales_see_own_activity
  ON public.activity_logs
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY boss_admin_see_all_sessions
  ON public.user_session_daily
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = auth.uid()
        AND role IN ('boss', 'admin')
    )
  );

CREATE POLICY sales_see_own_sessions
  ON public.user_session_daily
  FOR SELECT
  USING (user_id = auth.uid());
