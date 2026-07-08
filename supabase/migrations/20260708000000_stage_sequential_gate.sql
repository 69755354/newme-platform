-- Enforce sequential stage progression. Non-terminal stages must advance one step
-- at a time. Terminal stages (won/lost) can be reached from any non-terminal stage.

CREATE OR REPLACE FUNCTION public.trg_check_stage_sequence()
RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  stage_order text[] := ARRAY['new','contacted','requirement_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision'];
  cur_idx int;
  new_idx int;
BEGIN
  -- No-op: same stage
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;

  -- Allow setting stage from NULL (initial create)
  IF OLD.stage IS NULL THEN
    RETURN NEW;
  END IF;

  -- Terminal stages (won/lost) can be reached from any non-terminal stage
  IF NEW.stage IN ('won', 'lost') THEN
    RETURN NEW;
  END IF;

  -- Find current and new stage indices
  cur_idx := array_position(stage_order, OLD.stage);
  new_idx := array_position(stage_order, NEW.stage);

  -- Unknown stages: allow (defensive)
  IF cur_idx IS NULL OR new_idx IS NULL THEN
    RETURN NEW;
  END IF;

  -- New stage must be the NEXT stage (cur_idx + 1)
  IF new_idx != cur_idx + 1 THEN
    RAISE EXCEPTION 'Stage must advance sequentially. Current: %, attempted: %. Next allowed: %.',
      OLD.stage, NEW.stage,
      CASE WHEN cur_idx + 1 <= array_length(stage_order, 1) THEN stage_order[cur_idx + 1] ELSE 'won or lost' END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_stage_sequence ON public.leads;
CREATE TRIGGER trg_check_stage_sequence
  BEFORE UPDATE OF stage ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_check_stage_sequence();
