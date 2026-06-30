-- 20260624143000_fix_auth_login_trigger.sql
-- P0 FIX: handle_auth_login() references profiles.tenant_id which doesn't exist
-- profiles table NEVER had tenant_id column
-- This broke ALL logins with "Database error granting user"
-- Fix: remove the broken SELECT, use NULL directly (COALESCE already handles it)

CREATE OR REPLACE FUNCTION public.handle_auth_login()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  -- profiles table has no tenant_id column; use NULL
  -- COALESCE below defaults to zero-UUID
  v_tenant_id := NULL;
  
  -- upsert today's session record
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
