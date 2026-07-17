-- The old trigger used completed_at DESC to find the previous milestone.
-- PostgreSQL's now() is transaction-scoped, so milestones written in one
-- transaction can share a timestamp and be read back in an arbitrary order.
CREATE OR REPLACE FUNCTION public.check_milestone_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  last_key text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = NEW.lead_id
      AND milestone_key = NEW.milestone_key
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.milestone_key = 'first_contact' THEN
    RETURN NEW;
  END IF;

  SELECT milestone_key
  INTO last_key
  FROM public.lead_milestones
  WHERE lead_id = NEW.lead_id
  ORDER BY milestone_order(milestone_key) DESC
  LIMIT 1;

  IF last_key IS NOT NULL THEN
    IF milestone_order(NEW.milestone_key) <= milestone_order(last_key) THEN
      RAISE EXCEPTION 'Cannot go backwards: % -> %', last_key, NEW.milestone_key;
    END IF;
    IF milestone_order(NEW.milestone_key) > milestone_order(last_key) + 1 THEN
      RAISE EXCEPTION 'Cannot skip: % -> %', last_key, NEW.milestone_key;
    END IF;
  END IF;

  UPDATE public.leads
  SET current_milestone = NEW.milestone_key
  WHERE id = NEW.lead_id;

  RETURN NEW;
END;
$function$;
