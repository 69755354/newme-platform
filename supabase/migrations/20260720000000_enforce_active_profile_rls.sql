-- A Supabase Auth ban blocks future refresh/sign-in, but a loaded JWT remains
-- valid until it expires. RLS and callable SECURITY DEFINER functions must
-- therefore reject an inactive profile now.
BEGIN;

CREATE OR REPLACE FUNCTION public.current_user_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND is_active IS TRUE
  );
$$;

CREATE OR REPLACE FUNCTION public.require_current_user_active()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.current_user_is_active() THEN
    RAISE EXCEPTION 'Forbidden: inactive or missing profile';
  END IF;
END;
$$;

-- RLS policies already depend on get_my_role() to avoid profiles recursion.
-- Preserve its execution grant, while making an inactive JWT resolve no role.
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT role
    FROM public.profiles
    WHERE id = auth.uid()
      AND is_active IS TRUE
  );
END;
$$;

-- profiles is the source of the active-state lookup, so it cannot use the
-- restrictive policies below. Keep self-service updates, but require that the
-- old and new self profile are active. Management updates still use service
-- role, and browser-side management requires an active management profile.
DROP POLICY IF EXISTS policy_profiles_update_self ON public.profiles;
CREATE POLICY policy_profiles_update_self
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() AND is_active IS TRUE)
  WITH CHECK (
    id = auth.uid()
    AND is_active IS TRUE
    AND (
      EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = auth.uid()
          AND p.role IN ('admin', 'boss')
          AND p.is_active IS TRUE
      )
      OR role = (SELECT role FROM public.profiles WHERE id = auth.uid())
    )
  );

DROP POLICY IF EXISTS policy_profiles_update_admin ON public.profiles;
CREATE POLICY policy_profiles_update_admin
  ON public.profiles FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'boss')
        AND is_active IS TRUE
    )
  );

-- Security-definer RPC inventory. The four application RPCs are wrapped below;
-- every other public security-definer function loses browser execution.
ALTER FUNCTION public.transition_lead_stage(uuid, text, text, text)
  RENAME TO transition_lead_stage_active_impl;
ALTER FUNCTION public.reopen_lead_milestone(uuid, text, text)
  RENAME TO reopen_lead_milestone_active_impl;
ALTER FUNCTION public.recomplete_lead_milestone(uuid, text, text)
  RENAME TO recomplete_lead_milestone_active_impl;
ALTER FUNCTION public.next_quote_no()
  RENAME TO next_quote_no_active_impl;

CREATE FUNCTION public.transition_lead_stage(
  p_lead_id uuid,
  p_expected_stage text,
  p_next_stage text,
  p_note text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.require_current_user_active();
  RETURN public.transition_lead_stage_active_impl(
    p_lead_id, p_expected_stage, p_next_stage, p_note
  );
END;
$$;

CREATE FUNCTION public.reopen_lead_milestone(
  p_lead_id uuid,
  p_milestone_key text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.require_current_user_active();
  RETURN public.reopen_lead_milestone_active_impl(
    p_lead_id, p_milestone_key, p_reason
  );
END;
$$;

CREATE FUNCTION public.recomplete_lead_milestone(
  p_lead_id uuid,
  p_milestone_key text,
  p_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.require_current_user_active();
  RETURN public.recomplete_lead_milestone_active_impl(
    p_lead_id, p_milestone_key, p_notes
  );
END;
$$;

CREATE FUNCTION public.next_quote_no()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.require_current_user_active();
  RETURN public.next_quote_no_active_impl();
END;
$$;

-- Start from deny for every currently installed public SECURITY DEFINER
-- function. This makes the inventory closed: new browser-callable privileged
-- functions require an explicit review and grant.
DO $$
DECLARE
  function_name regprocedure;
BEGIN
  FOR function_name IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', function_name);
  END LOOP;
END
$$;

-- Explicit allowlist: one RLS helper and four RPC wrappers. get_my_role()
-- returns NULL for inactive users, so policy decisions remain deny-by-default.
GRANT EXECUTE ON FUNCTION public.current_user_is_active() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_lead_stage(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_lead_milestone(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recomplete_lead_milestone(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_quote_no() TO authenticated;

-- Restrictive policies are ANDed with existing permissive policies. Keep the
-- policies operation-specific so RLS review can audit read/write boundaries.
DO $$
DECLARE
  table_name regclass;
BEGIN
  FOR table_name IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity
      AND c.relname <> 'profiles'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS active_profile_required_select ON %s', table_name);
    EXECUTE format('DROP POLICY IF EXISTS active_profile_required_insert ON %s', table_name);
    EXECUTE format('DROP POLICY IF EXISTS active_profile_required_update ON %s', table_name);
    EXECUTE format('DROP POLICY IF EXISTS active_profile_required_delete ON %s', table_name);
    EXECUTE format(
      'CREATE POLICY active_profile_required_select ON %s AS RESTRICTIVE FOR SELECT TO authenticated USING (public.current_user_is_active())',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY active_profile_required_insert ON %s AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.current_user_is_active())',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY active_profile_required_update ON %s AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.current_user_is_active()) WITH CHECK (public.current_user_is_active())',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY active_profile_required_delete ON %s AS RESTRICTIVE FOR DELETE TO authenticated USING (public.current_user_is_active())',
      table_name
    );
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
