-- Require traceable notes for every future 1-7 milestone progression.
BEGIN;

CREATE OR REPLACE FUNCTION public.require_milestone_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  derived_note text;
BEGIN
  IF NEW.milestone_key NOT IN (
    'first_contact',
    'basic_info',
    'drawings',
    'requirements',
    'solution',
    'quotation',
    'meeting'
  ) THEN
    RETURN NEW;
  END IF;

  IF btrim(COALESCE(NEW.notes, '')) = ''
     AND NEW.milestone_key = 'first_contact' THEN
    SELECT concat_ws(
      ' — ',
      'First contact',
      NULLIF(btrim(contact_result), ''),
      NULLIF(btrim(summary), '')
    )
    INTO derived_note
    FROM public.follow_up_logs
    WHERE lead_id = NEW.lead_id
      AND contact_time IS NOT NULL
      AND contact_result IS NOT NULL
      AND btrim(contact_result) <> ''
    ORDER BY contact_time ASC, created_at ASC
    LIMIT 1;

    NEW.notes := derived_note;
  END IF;

  IF btrim(COALESCE(NEW.notes, '')) = '' THEN
    RAISE EXCEPTION 'Milestone note is required';
  END IF;

  NEW.notes := btrim(NEW.notes);
  IF char_length(NEW.notes) > 1000 THEN
    RAISE EXCEPTION 'Milestone note must be 1000 characters or fewer';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_require_milestone_note ON public.lead_milestones;
CREATE TRIGGER trg_require_milestone_note
  BEFORE INSERT OR UPDATE OF notes ON public.lead_milestones
  FOR EACH ROW
  EXECUTE FUNCTION public.require_milestone_note();

NOTIFY pgrst, 'reload schema';
COMMIT;
