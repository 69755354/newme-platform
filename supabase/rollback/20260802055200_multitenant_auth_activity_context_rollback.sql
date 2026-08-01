\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION 'multitenant_auth_activity_rollback_requires_staging_or_test';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.user_session_daily
    GROUP BY user_id, session_date
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'multitenant_auth_activity_rollback_would_collapse_organizations';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS on_auth_login ON auth.users;

ALTER TABLE public.user_session_daily
  DROP CONSTRAINT IF EXISTS user_session_daily_tenant_user_session_date_key;
ALTER TABLE public.user_session_daily
  ADD CONSTRAINT user_session_daily_user_id_session_date_key
  UNIQUE (user_id, session_date);

CREATE OR REPLACE FUNCTION public.handle_auth_login()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.user_session_daily (
    tenant_id, user_id, session_date, first_login, last_active, login_count
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    NEW.id, CURRENT_DATE, now(), now(), 1
  )
  ON CONFLICT (user_id, session_date) DO UPDATE SET
    first_login = COALESCE(public.user_session_daily.first_login, now()),
    last_active = now(),
    login_count = public.user_session_daily.login_count + 1,
    updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_login
  AFTER UPDATE OF last_sign_in_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.last_sign_in_at IS DISTINCT FROM NEW.last_sign_in_at)
  EXECUTE FUNCTION public.handle_auth_login();

CREATE OR REPLACE FUNCTION public.log_activity(
  p_action text,
  p_entity_type text DEFAULT NULL::text,
  p_entity_id uuid DEFAULT NULL::uuid,
  p_details jsonb DEFAULT NULL::jsonb,
  p_page_path text DEFAULT NULL::text,
  p_duration_seconds integer DEFAULT NULL::integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
  result_id uuid;
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  INSERT INTO public.activity_logs (
    tenant_id, user_id, action, entity_type, entity_id, details,
    page_path, duration_seconds
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', actor_user_id, p_action,
    p_entity_type, p_entity_id, p_details, p_page_path, p_duration_seconds
  ) RETURNING id INTO result_id;
  RETURN result_id;
END;
$$;

-- Restore the previous customer-exit lifecycle guard from 20260801202728.
CREATE OR REPLACE FUNCTION public.organization_lifecycle_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  row_data jsonb := CASE WHEN TG_OP = 'DELETE'
    THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  target_organization_id uuid;
BEGIN
  IF row_data ? 'organization_id' THEN
    target_organization_id := NULLIF(row_data ->> 'organization_id', '')::uuid;
  ELSIF row_data ? 'tenant_id' THEN
    target_organization_id := NULLIF(row_data ->> 'tenant_id', '')::uuid;
  ELSIF row_data ? 'lead_id' THEN
    SELECT lead_row.organization_id INTO target_organization_id
    FROM public.leads lead_row
    WHERE lead_row.id = NULLIF(row_data ->> 'lead_id', '')::uuid;
  END IF;
  IF target_organization_id IS NULL AND TG_TABLE_NAME = 'activities' THEN
    SELECT parent.organization_id INTO target_organization_id
    FROM (
      SELECT organization_id FROM public.contracts
      WHERE id = NULLIF(row_data ->> 'contract_id', '')::uuid
      UNION ALL
      SELECT organization_id FROM public.quotations
      WHERE id = NULLIF(row_data ->> 'quotation_id', '')::uuid
      UNION ALL
      SELECT organization_id FROM public.projects
      WHERE id = NULLIF(row_data ->> 'project_id', '')::uuid
    ) parent
    LIMIT 1;
  END IF;
  IF target_organization_id IS NULL AND TG_TABLE_NAME = 'quotes' THEN
    SELECT project.organization_id INTO target_organization_id
    FROM public.projects project
    WHERE project.id = NULLIF(row_data ->> 'project_id', '')::uuid;
  END IF;
  IF target_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_lifecycle_context_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = target_organization_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'organization_is_not_writable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_auth_login() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_activity(text, text, uuid, jsonb, text, integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.organization_lifecycle_write_guard() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

COMMIT;
