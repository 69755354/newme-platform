-- First Contact is complete only when both business facts exist:
-- at least one complete contact record and an assessed lead quality.
BEGIN;

CREATE OR REPLACE FUNCTION public.complete_first_contact_if_ready(p_lead_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lead_quality text;
  contact_user uuid;
  contact_at timestamptz;
BEGIN
  SELECT quality INTO lead_quality
  FROM public.leads
  WHERE id = p_lead_id;

  IF lead_quality IS NULL OR lead_quality NOT IN ('good', 'normal', 'poor') THEN
    RETURN;
  END IF;

  SELECT user_id, contact_time
    INTO contact_user, contact_at
  FROM public.follow_up_logs
  WHERE lead_id = p_lead_id
    AND contact_time IS NOT NULL
    AND contact_result IS NOT NULL
    AND btrim(contact_result) <> ''
  ORDER BY contact_time ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.lead_milestones (
    lead_id,
    milestone_key,
    completed_at,
    completed_by,
    created_at
  )
  VALUES (
    p_lead_id,
    'first_contact',
    contact_at,
    contact_user,
    NOW()
  )
  ON CONFLICT (lead_id, milestone_key) DO UPDATE
  SET completed_at = EXCLUDED.completed_at,
      completed_by = EXCLUDED.completed_by;

  UPDATE public.leads
  SET current_milestone = 'first_contact',
      updated_at = NOW()
  WHERE id = p_lead_id
    AND (current_milestone IS NULL OR current_milestone = 'new');
END;
$$;

REVOKE ALL ON FUNCTION public.complete_first_contact_if_ready(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_first_contact_if_ready(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.complete_first_contact_if_ready(uuid) FROM authenticated;

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

  UPDATE public.leads
  SET last_contact_date = CASE
        WHEN last_contact_date IS NULL OR last_contact_date < NEW.contact_time
          THEN NEW.contact_time
        ELSE last_contact_date
      END,
      updated_at = NOW()
  WHERE id = NEW.lead_id;

  PERFORM public.complete_first_contact_if_ready(NEW.lead_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_auto_first_contact_from_quality()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.quality IS DISTINCT FROM OLD.quality
     AND NEW.quality IN ('good', 'normal', 'poor') THEN
    PERFORM public.complete_first_contact_if_ready(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_first_contact_from_quality ON public.leads;
CREATE TRIGGER trg_first_contact_from_quality
  AFTER UPDATE OF quality ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_first_contact_from_quality();

CREATE OR REPLACE FUNCTION public.trg_enforce_first_contact_milestone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lead_quality text;
BEGIN
  IF NEW.milestone_key = 'first_contact' THEN
    SELECT quality INTO lead_quality
    FROM public.leads
    WHERE id = NEW.lead_id;

    IF lead_quality IS NULL OR lead_quality NOT IN ('good', 'normal', 'poor') THEN
      RAISE EXCEPTION 'first_contact milestone: quality must be assessed';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.follow_up_logs
      WHERE lead_id = NEW.lead_id
        AND contact_time IS NOT NULL
        AND contact_result IS NOT NULL
        AND btrim(contact_result) <> ''
    ) THEN
      RAISE EXCEPTION 'first_contact milestone: complete contact record required';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_first_contact_milestone ON public.lead_milestones;
CREATE TRIGGER trg_enforce_first_contact_milestone
  BEFORE INSERT ON public.lead_milestones
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_first_contact_milestone();

-- Reconcile legacy rows before making the fact milestone immutable.
-- Unprogressed New Leads are reset; progressed history is retained and labelled.
UPDATE public.lead_milestones lm
SET notes = concat_ws(
  ' | ',
  NULLIF(btrim(COALESCE(lm.notes, '')), ''),
  'legacy_pre_enforcement'
)
FROM public.leads l
WHERE lm.lead_id = l.id
  AND lm.milestone_key = 'first_contact'
  AND (
    l.quality IS NULL
    OR l.quality NOT IN ('good', 'normal', 'poor')
    OR NOT EXISTS (
      SELECT 1
      FROM public.follow_up_logs f
      WHERE f.lead_id = l.id
        AND f.contact_time IS NOT NULL
        AND f.contact_result IS NOT NULL
        AND btrim(f.contact_result) <> ''
    )
  )
  AND (
    l.stage IS DISTINCT FROM 'new'
    OR EXISTS (
      SELECT 1
      FROM public.lead_milestones later
      WHERE later.lead_id = l.id
        AND later.milestone_key <> 'first_contact'
    )
  )
  AND position('legacy_pre_enforcement' in COALESCE(lm.notes, '')) = 0;

DELETE FROM public.lead_milestones lm
USING public.leads l
WHERE lm.lead_id = l.id
  AND lm.milestone_key = 'first_contact'
  AND l.stage = 'new'
  AND (
    l.quality IS NULL
    OR l.quality NOT IN ('good', 'normal', 'poor')
    OR NOT EXISTS (
      SELECT 1
      FROM public.follow_up_logs f
      WHERE f.lead_id = l.id
        AND f.contact_time IS NOT NULL
        AND f.contact_result IS NOT NULL
        AND btrim(f.contact_result) <> ''
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones later
    WHERE later.lead_id = l.id
      AND later.milestone_key <> 'first_contact'
  );

UPDATE public.leads l
SET current_milestone = 'new',
    updated_at = NOW()
WHERE l.stage = 'new'
  AND l.current_milestone = 'first_contact'
  AND NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones lm
    WHERE lm.lead_id = l.id
      AND lm.milestone_key = 'first_contact'
  );

CREATE OR REPLACE FUNCTION public.trg_prevent_first_contact_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $
BEGIN
  IF OLD.milestone_key = 'first_contact' THEN
    RAISE EXCEPTION 'first_contact milestone is fact-driven and cannot be deleted';
  END IF;
  RETURN OLD;
END;
$;

DROP TRIGGER IF EXISTS trg_prevent_first_contact_delete ON public.lead_milestones;
CREATE TRIGGER trg_prevent_first_contact_delete
  BEFORE DELETE ON public.lead_milestones
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_prevent_first_contact_delete();

-- Normalize every factually complete Lead and backfill missing First Contact rows.
DO $
DECLARE
  ready_lead record;
BEGIN
  FOR ready_lead IN
    SELECT l.id
    FROM public.leads l
    WHERE l.quality IN ('good', 'normal', 'poor')
      AND EXISTS (
        SELECT 1
        FROM public.follow_up_logs f
        WHERE f.lead_id = l.id
          AND f.contact_time IS NOT NULL
          AND f.contact_result IS NOT NULL
          AND btrim(f.contact_result) <> ''
      )
  LOOP
    PERFORM public.complete_first_contact_if_ready(ready_lead.id);
  END LOOP;
END;
$;

NOTIFY pgrst, 'reload schema';
COMMIT;
