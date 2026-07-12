-- Complete contacts create the First Contact milestone, not every follow-up.
-- The same rule is used by the database stage gate: contact_time + non-blank result.
BEGIN;

CREATE OR REPLACE FUNCTION public.trg_auto_first_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.contact_time IS NULL
     OR NEW.contact_result IS NULL
     OR btrim(NEW.contact_result) = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.lead_milestones (
    lead_id,
    milestone_key,
    completed_at,
    completed_by,
    created_at
  )
  VALUES (
    NEW.lead_id,
    'first_contact',
    COALESCE(NEW.contact_time, NEW.created_at, NOW()),
    NEW.user_id,
    NOW()
  )
  ON CONFLICT (lead_id, milestone_key) DO NOTHING;

  UPDATE public.leads
  SET last_contact_date = CASE
        WHEN last_contact_date IS NULL OR last_contact_date < NEW.contact_time
          THEN NEW.contact_time
        ELSE last_contact_date
      END,
      updated_at = NOW()
  WHERE id = NEW.lead_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_after_followup_insert ON public.follow_up_logs;

CREATE TRIGGER trg_after_followup_insert
  AFTER INSERT OR UPDATE OF contact_time, contact_result ON public.follow_up_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_first_contact();

NOTIFY pgrst, 'reload schema';
COMMIT;
