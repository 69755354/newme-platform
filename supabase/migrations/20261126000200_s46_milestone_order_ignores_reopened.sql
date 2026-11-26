-- NO_ROLLBACK: one routine replaced in place (same signature, SECURITY DEFINER, pinned search_path, grants untouched). Manual undo: re-apply the
-- check_milestone_order() definition from 20261123100000_s39_stage_rules_relaxed.sql.
-- ============================================================================
-- OS fix S46 - the milestone order check ignores reopened milestones
-- ============================================================================
-- PR #604 follow-up: check_milestone_order decided "which step is the latest" from every milestone row, including a
-- reopened one (completed_at null), so a reopened step still blocked an earlier step from being inserted. Only completed
-- milestones count now; nothing else in the routine changes.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.check_milestone_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
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

  -- S46: a reopened milestone (completed_at is null) is not done, so it does not count as the latest completed step.
  SELECT milestone_key
  INTO last_key
  FROM public.lead_milestones
  WHERE lead_id = NEW.lead_id
    AND completed_at IS NOT NULL
  ORDER BY milestone_order(milestone_key) DESC
  LIMIT 1;

  IF last_key IS NOT NULL THEN
    IF milestone_order(NEW.milestone_key) <= milestone_order(last_key) THEN
      RAISE EXCEPTION 'Cannot go backwards: % -> %', last_key, NEW.milestone_key;
    END IF;
    -- S39: skipping a milestone going forward is allowed.
  END IF;

  UPDATE public.leads
  SET current_milestone = NEW.milestone_key
  WHERE id = NEW.lead_id;

  RETURN NEW;
END;
$function$;
