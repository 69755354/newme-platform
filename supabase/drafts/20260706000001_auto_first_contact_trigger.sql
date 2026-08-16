-- DRAFT: pending Hermes audit and GPT approval. Do not apply yet.
-- The current schema has no source or source_creator column; historical source
-- differentiation may require a future migration.

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_auto_first_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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
    COALESCE(NEW.created_at, NOW()),
    COALESCE(NEW.user_id, NEW.created_by),
    NOW()
  )
  ON CONFLICT (lead_id, milestone_key) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_after_followup_insert ON public.follow_up_logs;

CREATE TRIGGER trg_after_followup_insert
  AFTER INSERT ON public.follow_up_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_first_contact();

COMMIT;
