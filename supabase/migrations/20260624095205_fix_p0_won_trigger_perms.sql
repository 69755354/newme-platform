-- P0: on_lead_won writes to RLS-protected tables whose policies read profiles.
-- Run the trigger as its owner so those internal policy queries are not evaluated
-- using the authenticated caller's RLS context. The trigger body is unchanged.
DO $$
BEGIN
  IF to_regprocedure('public.on_lead_won()') IS NOT NULL THEN
    ALTER FUNCTION public.on_lead_won() SECURITY DEFINER;
    ALTER FUNCTION public.on_lead_won() SET search_path = public, pg_temp;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
