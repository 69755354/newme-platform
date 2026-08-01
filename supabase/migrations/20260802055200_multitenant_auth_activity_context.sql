BEGIN;

ALTER TABLE public.user_session_daily
  DROP CONSTRAINT IF EXISTS user_session_daily_user_id_session_date_key;
ALTER TABLE public.user_session_daily
  ADD CONSTRAINT user_session_daily_tenant_user_session_date_key
  UNIQUE (tenant_id, user_id, session_date);

CREATE OR REPLACE FUNCTION public.handle_auth_login()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  resolved_organization_id uuid;
  active_membership_count integer;
BEGIN
  SELECT min(membership.organization_id::text)::uuid, count(*)::integer
  INTO resolved_organization_id, active_membership_count
  FROM public.memberships membership
  JOIN public.organizations organization
    ON organization.id = membership.organization_id
  JOIN public.profiles profile
    ON profile.id = membership.user_id
  WHERE membership.user_id = NEW.id
    AND membership.status = 'active'
    AND membership.accepted_at IS NOT NULL
    AND profile.is_active IS TRUE
    AND organization.status IN ('active', 'read_only', 'suspended');

  -- Auth has no selected-organization header. Record an automatic login only
  -- when the identity has one unambiguous active organization. Request-scoped
  -- activity remains responsible for users with multiple organizations.
  IF active_membership_count <> 1 OR resolved_organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_session_daily (
    tenant_id, user_id, session_date, first_login, last_active, login_count
  ) VALUES (
    resolved_organization_id, NEW.id, CURRENT_DATE, now(), now(), 1
  )
  ON CONFLICT (tenant_id, user_id, session_date) DO UPDATE SET
    first_login = COALESCE(public.user_session_daily.first_login, EXCLUDED.first_login),
    last_active = now(),
    login_count = public.user_session_daily.login_count + 1,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_login ON auth.users;
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
  selected_organization_id uuid := public.requested_organization_id();
  result_id uuid;
BEGIN
  IF actor_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF selected_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_context_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships membership
    JOIN public.organizations organization
      ON organization.id = membership.organization_id
    JOIN public.profiles profile
      ON profile.id = membership.user_id
    WHERE membership.organization_id = selected_organization_id
      AND membership.user_id = actor_user_id
      AND membership.status = 'active'
      AND membership.accepted_at IS NOT NULL
      AND profile.is_active IS TRUE
      AND organization.status IN ('active', 'read_only', 'suspended')
  ) THEN
    RAISE EXCEPTION 'organization_access_denied';
  END IF;

  INSERT INTO public.activity_logs (
    tenant_id, user_id, action, entity_type, entity_id, details,
    page_path, duration_seconds
  ) VALUES (
    selected_organization_id, actor_user_id, p_action, p_entity_type,
    p_entity_id, p_details, p_page_path, p_duration_seconds
  )
  RETURNING id INTO result_id;

  INSERT INTO public.user_session_daily (
    tenant_id, user_id, session_date, first_login, last_active,
    login_count, actions_count, pages_viewed
  ) VALUES (
    selected_organization_id, actor_user_id, CURRENT_DATE,
    CASE WHEN p_action = 'login' THEN now() ELSE NULL END,
    now(), CASE WHEN p_action = 'login' THEN 1 ELSE 0 END, 1,
    CASE WHEN p_action = 'page_view' THEN 1 ELSE 0 END
  )
  ON CONFLICT (tenant_id, user_id, session_date) DO UPDATE SET
    first_login = COALESCE(public.user_session_daily.first_login, EXCLUDED.first_login),
    last_active = now(),
    login_count = public.user_session_daily.login_count
      + CASE WHEN p_action = 'login' THEN 1 ELSE 0 END,
    actions_count = public.user_session_daily.actions_count + 1,
    pages_viewed = public.user_session_daily.pages_viewed
      + CASE WHEN p_action = 'page_view' THEN 1 ELSE 0 END,
    updated_at = now();

  RETURN result_id;
END;
$$;

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
  organization_status text;
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

  SELECT status INTO organization_status
  FROM public.organizations
  WHERE id = target_organization_id;

  IF TG_TABLE_NAME IN ('activity_logs', 'user_session_daily') THEN
    IF organization_status NOT IN ('active', 'read_only', 'suspended') THEN
      RAISE EXCEPTION 'organization_is_not_observable';
    END IF;
  ELSIF organization_status IS DISTINCT FROM 'active' THEN
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
