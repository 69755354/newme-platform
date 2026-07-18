-- Keep fresh environments aligned with the existing production leads schema.
BEGIN;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS project_status TEXT;

CREATE OR REPLACE FUNCTION public.enforce_active_lead_transfer_candidate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to)
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = NEW.assigned_to
        AND is_active = TRUE
        AND role IN ('sales', 'operator', 'boss')
    )
  THEN
    RAISE EXCEPTION 'Lead assignee must be an active transfer candidate'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_active_lead_transfer_candidate ON public.leads;
CREATE TRIGGER enforce_active_lead_transfer_candidate
  BEFORE UPDATE OF assigned_to ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_active_lead_transfer_candidate();

DROP TRIGGER IF EXISTS enforce_active_lead_insert_assignee ON public.leads;
CREATE TRIGGER enforce_active_lead_insert_assignee
  BEFORE INSERT ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_active_lead_transfer_candidate();

REVOKE ALL ON FUNCTION public.enforce_active_lead_transfer_candidate() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

COMMIT;
