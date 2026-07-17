-- Allow a Lead to be deleted when its First Contact milestone cascades.
-- Direct deletion of the fact-driven milestone remains prohibited.

CREATE OR REPLACE FUNCTION public.trg_prevent_first_contact_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $delete_guard$
BEGIN
  IF OLD.milestone_key = 'first_contact' AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'first_contact milestone is fact-driven and cannot be deleted';
  END IF;
  RETURN OLD;
END;
$delete_guard$;
