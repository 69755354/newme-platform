-- =============================================================================
-- Migration: 审计建议修复 — public 策略缩窄 + log_activity 表名限定
-- Date: 2026-07-01
-- 1. 4 条 public 角色策略 → 缩窄为 authenticated
-- 2. log_activity() 内部表引用加 public. 前缀
-- =============================================================================

-- ── Part 1: 4 条 public 策略缩窄为 authenticated ──

ALTER POLICY "lead_files_select_assigned" ON lead_files TO authenticated;
ALTER POLICY "lead_files_insert_staff" ON lead_files TO authenticated;
ALTER POLICY "knx_designs_select_assigned" ON knx_designs TO authenticated;
ALTER POLICY "Users insert own audit events" ON audit_log_archived_20260615 TO authenticated;

-- ── Part 2: log_activity() 表引用加 public. 前缀 ──

CREATE OR REPLACE FUNCTION public.log_activity(p_action text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_details jsonb DEFAULT NULL::jsonb, p_page_path text DEFAULT NULL::text, p_duration_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_tenant_id UUID;
  v_result UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- profiles may not have tenant_id column; default to global tenant
  v_tenant_id := '00000000-0000-0000-0000-000000000000';

  INSERT INTO public.activity_logs (tenant_id, user_id, action, entity_type, entity_id, details, page_path, duration_seconds)
  VALUES (v_tenant_id, v_user_id, p_action, p_entity_type, p_entity_id, p_details, p_page_path, p_duration_seconds)
  RETURNING id INTO v_result;

  INSERT INTO public.user_session_daily (tenant_id, user_id, session_date, first_login, last_active, actions_count)
  VALUES (
    v_tenant_id,
    v_user_id,
    CURRENT_DATE,
    CASE WHEN p_action = 'login' THEN now() ELSE NULL END,
    now(),
    1
  )
  ON CONFLICT (user_id, session_date) DO UPDATE SET
    first_login = COALESCE(public.user_session_daily.first_login, EXCLUDED.first_login),
    last_active = now(),
    login_count = public.user_session_daily.login_count + CASE WHEN p_action = 'login' THEN 1 ELSE 0 END,
    actions_count = public.user_session_daily.actions_count + 1,
    pages_viewed = public.user_session_daily.pages_viewed + CASE WHEN p_action = 'page_view' THEN 1 ELSE 0 END,
    updated_at = now();

  RETURN v_result;
END;
$function$;
