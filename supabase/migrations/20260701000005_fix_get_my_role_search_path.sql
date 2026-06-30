-- =============================================================================
-- Migration: Fix get_my_role() missing schema-qualified table reference
-- Date: 2026-07-01
-- Root cause: get_my_role() is SECURITY DEFINER with SET search_path = '',
-- but references 'profiles' without schema qualification.
-- When search_path is empty, PostgreSQL cannot resolve unqualified table names
-- in certain contexts (e.g., inside triggers, nested function calls),
-- producing "profiles does not exist" errors.
-- Fix: Use fully qualified public.profiles instead of profiles.
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
  RETURN (SELECT role FROM public.profiles WHERE id = auth.uid());
END;
$$;
