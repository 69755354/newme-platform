-- ============================================================
-- Trigger: auth.users.last_sign_in_at → user_session_daily
-- 当用户登录时，Supabase 自动更新 auth.users.last_sign_in_at
-- 这个 trigger 捕获该变化并同步到 user_session_daily
-- ============================================================

-- 1. 建函数：接收 user_id，upsert 今日 session
CREATE OR REPLACE FUNCTION public.handle_auth_login()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  -- 获取用户的 tenant_id
  SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = NEW.id;
  
  -- upsert 今日 session 记录
  INSERT INTO user_session_daily (tenant_id, user_id, session_date, first_login, last_active, login_count)
  VALUES (
    COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'),
    NEW.id,
    CURRENT_DATE,
    now(),
    now(),
    1
  )
  ON CONFLICT (user_id, session_date) DO UPDATE SET
    first_login = COALESCE(user_session_daily.first_login, now()),
    last_active = now(),
    login_count = user_session_daily.login_count + 1,
    updated_at = now();
    
  RETURN NEW;
END;
$$;

-- 2. 在 auth.users 上建 trigger（仅在 last_sign_in_at 变化时触发）
DROP TRIGGER IF EXISTS on_auth_login ON auth.users;
CREATE TRIGGER on_auth_login
  AFTER UPDATE OF last_sign_in_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.last_sign_in_at IS DISTINCT FROM NEW.last_sign_in_at)
  EXECUTE FUNCTION public.handle_auth_login();
