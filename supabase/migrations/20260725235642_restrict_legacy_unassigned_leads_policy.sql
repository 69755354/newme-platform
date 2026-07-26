BEGIN;

DO $$
BEGIN
  IF to_regclass('public.leads') IS NULL THEN
    RAISE EXCEPTION 'public.leads is required';
  END IF;
END
$$;

-- Preserve the authenticated unassigned-lead pool while removing the legacy
-- PUBLIC policy. For anon, auth.uid() is NULL, so the old policy exposed every
-- unassigned lead through the Data API.
DROP POLICY IF EXISTS "sales_own_leads" ON public.leads;

CREATE POLICY "sales_own_leads"
  ON public.leads
  FOR SELECT
  TO authenticated
  USING (
    assigned_to = (SELECT auth.uid())
    OR assigned_to IS NULL
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
