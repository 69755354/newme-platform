-- A Supabase Auth ban blocks future refresh/sign-in, but a loaded JWT remains
-- valid until it expires. RLS must therefore reject an inactive profile now.
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

REVOKE ALL ON FUNCTION public.current_user_is_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_active() TO authenticated;

-- Restrictive policies are ANDed with every existing permissive policy. This
-- covers all current public RLS business tables without changing role/ownership
-- rules or service-role server operations. profiles is intentionally excluded:
-- it is the source of the active-state lookup above.
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
    EXECUTE format('DROP POLICY IF EXISTS active_profile_required ON %s', table_name);
    EXECUTE format(
      'CREATE POLICY active_profile_required ON %s AS RESTRICTIVE FOR ALL TO authenticated USING (public.current_user_is_active()) WITH CHECK (public.current_user_is_active())',
      table_name
    );
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
