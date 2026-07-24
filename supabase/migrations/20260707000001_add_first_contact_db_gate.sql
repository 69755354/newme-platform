-- P1-3: Backend hard gate for new→contacted transition
-- BEFORE UPDATE trigger on leads — cannot be bypassed by any client/API/SDK path.
-- Validates:
--   1. 3+ follow_up_logs with contact_time IS NOT NULL
--   2. quality IS NOT NULL AND quality != 'pending'
-- If either fails → RAISE EXCEPTION, transaction rolls back.
--
-- This is the server-side counterpart to the frontend Guard 6 in
-- useLeadMutations.ts:258-277. Admin/boss are NOT exempt at this
-- layer — the gate is universal. Bypass requires direct SQL or
-- Supabase Dashboard (RLS still applies).


CREATE OR REPLACE FUNCTION public.trg_check_first_contact_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  contact_count integer;
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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_first_contact_gate ON public.leads;

CREATE TRIGGER trg_first_contact_gate
  BEFORE UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_check_first_contact_gate();
