-- DRAFT: pending Hermes controlled transaction test v2 + GPT approval. Do not apply yet.


DROP TRIGGER IF EXISTS trg_check_milestone_order ON public.lead_milestones;

CREATE OR REPLACE FUNCTION public.check_milestone_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  last_key TEXT;
BEGIN
  -- [A] Idempotent same-key insert: if this exact (lead_id, milestone_key) already exists, noop
  IF EXISTS (
    SELECT 1 FROM public.lead_milestones
    WHERE lead_id = NEW.lead_id AND milestone_key = NEW.milestone_key
  ) THEN
    RETURN NEW;
  END IF;

  -- [B] first_contact historical backfill exception: trigger-driven first_contact inserts
  -- bypass order check (first_contact = system backfill of contact fact, not manual progression)
  IF NEW.milestone_key = 'first_contact' THEN
    RETURN NEW;
  END IF;

  SELECT milestone_key INTO last_key
  FROM public.lead_milestones WHERE lead_id = NEW.lead_id
  ORDER BY completed_at DESC LIMIT 1;
  IF last_key IS NOT NULL THEN
    IF milestone_order(NEW.milestone_key) <= milestone_order(last_key) THEN
      RAISE EXCEPTION 'Cannot go backwards: % -> %', last_key, NEW.milestone_key;
    END IF;
    IF milestone_order(NEW.milestone_key) > milestone_order(last_key) + 1 THEN
      RAISE EXCEPTION 'Cannot skip: % -> %', last_key, NEW.milestone_key;
    END IF;
  END IF;
  UPDATE public.leads SET current_milestone = NEW.milestone_key WHERE id = NEW.lead_id;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_check_milestone_order
  BEFORE INSERT ON public.lead_milestones
  FOR EACH ROW
  EXECUTE FUNCTION public.check_milestone_order();
