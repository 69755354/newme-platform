-- P3: Add contact_result column to follow_up_logs and update first_contact gate trigger.
-- contact_result stores the outcome of each contact attempt (e.g. "客户有兴趣",
-- "无人接听", "scheduled meeting"). Required for structured contact records.
BEGIN;

ALTER TABLE public.follow_up_logs
  ADD COLUMN IF NOT EXISTS contact_result TEXT;

-- Update the first_contact gate trigger to also check that all contact records
-- have a non-null contact_result.
CREATE OR REPLACE FUNCTION public.trg_check_first_contact_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  contact_count integer;
  missing_result_count integer;
BEGIN
  -- Fire on ANY transition TO 'contacted' (not just new→contacted).
  -- Prevents bypass through intermediate stages like new→hold→contacted.
  IF (NEW.stage IS DISTINCT FROM 'contacted') OR (OLD.stage = 'contacted') THEN
    RETURN NEW;
  END IF;

  -- Check 1: 3+ follow_up_logs with contact_time
  SELECT count(*) INTO contact_count
  FROM public.follow_up_logs
  WHERE lead_id = NEW.id
    AND contact_time IS NOT NULL;

  IF contact_count < 3 THEN
    RAISE EXCEPTION 'first_contact gate: need 3 contact records with contact_time, found %', contact_count;
  END IF;

  -- Check 2: quality must be set (poor/normal/good)
  IF NEW.quality IS NULL OR NEW.quality = 'pending' THEN
    RAISE EXCEPTION 'first_contact gate: quality must be set (poor/normal/good) before contacting';
  END IF;

  -- Check 3: all contact records must have contact_result
  SELECT count(*) INTO missing_result_count
  FROM public.follow_up_logs
  WHERE lead_id = NEW.id
    AND contact_time IS NOT NULL
    AND (contact_result IS NULL OR contact_result = '');

  IF missing_result_count > 0 THEN
    RAISE EXCEPTION 'first_contact gate: % contact record(s) missing contact_result', missing_result_count;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_first_contact_gate ON public.leads;

CREATE TRIGGER trg_first_contact_gate
  BEFORE UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_check_first_contact_gate();

NOTIFY pgrst, 'reload schema';
COMMIT;
