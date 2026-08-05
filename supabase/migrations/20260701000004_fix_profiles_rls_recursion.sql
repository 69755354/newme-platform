-- =============================================================================
-- Migration: Fix profiles RLS infinite recursion
-- Date: 2026-07-01
-- Fixes: Profiles policies using SELECT FROM profiles trigger self-referencing
--        RLS recursion. Replace all subqueries with SECURITY DEFINER get_my_role().
-- =============================================================================

BEGIN;

-- =============================================================================
-- Ensure get_my_role() exists and is robust (handles NULL auth.uid())
-- =============================================================================
CREATE OR REPLACE FUNCTION get_my_role()
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT role FROM profiles WHERE id = auth.uid());
END;
$$;

-- =============================================================================
-- Drop all current profiles policies (from 20260630200000 migration)
-- =============================================================================
DROP POLICY IF EXISTS policy_profiles_select_self ON profiles;
DROP POLICY IF EXISTS policy_profiles_select_admin ON profiles;
DROP POLICY IF EXISTS policy_profiles_select_operator ON profiles;
DROP POLICY IF EXISTS policy_profiles_insert_admin ON profiles;
DROP POLICY IF EXISTS policy_profiles_update_self ON profiles;
DROP POLICY IF EXISTS policy_profiles_update_admin ON profiles;
DROP POLICY IF EXISTS policy_profiles_delete_admin ON profiles;

-- Also drop any other profiles policies that might exist
DROP POLICY IF EXISTS profiles_select ON profiles;
DROP POLICY IF EXISTS profiles_update_self ON profiles;
DROP POLICY IF EXISTS profile_self ON profiles;
DROP POLICY IF EXISTS profiles_admin_all ON profiles;

-- =============================================================================
-- Re-create profiles policies using get_my_role() (no self-referencing RLS)
-- =============================================================================

-- SELECT: users can see their own profile
CREATE POLICY policy_profiles_select_self
  ON profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

-- SELECT: admin/boss can see all profiles
CREATE POLICY policy_profiles_select_admin
  ON profiles FOR SELECT TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','boss']));

-- SELECT: operator can see all profiles
CREATE POLICY policy_profiles_select_operator
  ON profiles FOR SELECT TO authenticated
  USING (get_my_role() = 'operator');

-- INSERT: admin/boss can create profiles
CREATE POLICY policy_profiles_insert_admin
  ON profiles FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','boss']));

-- UPDATE: users can update their own profile (but not change role unless admin/boss)
CREATE POLICY policy_profiles_update_self
  ON profiles FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND (
      get_my_role() = ANY (ARRAY['admin','boss'])
      OR role = get_my_role()
    )
  );

-- UPDATE: admin/boss can update any profile
CREATE POLICY policy_profiles_update_admin
  ON profiles FOR UPDATE TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','boss']));

-- DELETE: admin/boss can delete profiles
CREATE POLICY policy_profiles_delete_admin
  ON profiles FOR DELETE TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','boss']));

COMMIT;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
