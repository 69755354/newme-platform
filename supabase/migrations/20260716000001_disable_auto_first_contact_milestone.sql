-- First Contact is a manual milestone: contact and quality only unlock it.
BEGIN;

DROP TRIGGER IF EXISTS trg_after_followup_insert ON public.follow_up_logs;
DROP FUNCTION IF EXISTS public.trg_auto_first_contact();

NOTIFY pgrst, 'reload schema';
COMMIT;
