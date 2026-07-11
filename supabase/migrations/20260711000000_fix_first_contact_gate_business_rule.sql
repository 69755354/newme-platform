-- Correct the first-contact business rule.
-- One complete contact + assessed quality is the hard stage gate.
-- Three contacts remain a UI coaching target only.
BEGIN;

CREATE OR REPLACE FUNCTION public.trg_check_first_contact_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  complete_contact_count integer;
BEGIN
  -- Guard every attempt to leave the initial stage, including direct won/lost
  -- updates. This prevents API payload and direct table-update bypasses.
  IF OLD.stage IS DISTINCT FROM 'new'
     OR NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO complete_contact_count
  FROM public.follow_up_logs
  WHERE lead_id = NEW.id
    AND contact_time IS NOT NULL
    AND contact_result IS NOT NULL
    AND btrim(contact_result) <> '';

  IF complete_contact_count < 1 THEN
    RAISE EXCEPTION 'first_contact gate: at least one complete contact record is required';
  END IF;

  IF NEW.quality IS NULL OR NEW.quality NOT IN ('good', 'normal', 'poor') THEN
    RAISE EXCEPTION 'first_contact gate: quality must be good, normal, or poor before leaving new';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_first_contact_gate ON public.leads;

CREATE TRIGGER trg_first_contact_gate
  BEFORE UPDATE OF stage ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_check_first_contact_gate();

NOTIFY pgrst, 'reload schema';
COMMIT;
