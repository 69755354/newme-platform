-- Reconcile only rows whose latest explicit milestone action remains a reopen.
-- Legacy quality-trigger writes can repopulate completed_at without creating an
-- explicit recompletion audit event, so the business-event ordering is authoritative.

WITH relevant_actions AS (
  SELECT
    lm.id AS lead_milestone_id,
    be.event_data->>'action' AS action,
    be.created_at,
    be.id
  FROM public.lead_milestones lm
  JOIN public.business_events be
    ON be.lead_id = lm.lead_id
  WHERE be.event_data->>'action' IN ('milestone_reopened', 'milestone_recompleted')
    AND (
      (
        be.event_data->>'action' = 'milestone_reopened'
        AND (
          be.event_data->>'milestone_key' = lm.milestone_key
          OR be.event_data->'affected' @> jsonb_build_array(
            jsonb_build_object('milestone_key', lm.milestone_key)
          )
        )
      )
      OR (
        be.event_data->>'action' = 'milestone_recompleted'
        AND be.event_data->>'milestone_key' = lm.milestone_key
      )
    )
),
latest_actions AS (
  SELECT DISTINCT ON (lead_milestone_id)
    lead_milestone_id,
    action AS latest_action
  FROM relevant_actions be
  ORDER BY lead_milestone_id, be.created_at DESC, be.id DESC
),
reopened_rows AS (
  UPDATE public.lead_milestones lm
  SET completed_at = NULL,
      completed_by = NULL
  FROM latest_actions la
  WHERE lm.id = la.lead_milestone_id
    AND la.latest_action = 'milestone_reopened'
    AND lm.completed_at IS NOT NULL
  RETURNING lm.id, lm.lead_id
),
affected_leads AS (
  SELECT DISTINCT lead_id
  FROM reopened_rows
),
remaining AS (
  SELECT
    al.lead_id,
    (
      SELECT lm.milestone_key
      FROM public.lead_milestones lm
      WHERE lm.lead_id = al.lead_id
        AND lm.completed_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM reopened_rows rr
          WHERE rr.id = lm.id
        )
      ORDER BY public.milestone_order(lm.milestone_key) DESC
      LIMIT 1
    ) AS milestone_key
  FROM affected_leads al
)
UPDATE public.leads l
SET current_milestone = COALESCE(remaining.milestone_key, 'new'),
    updated_at = NOW()
FROM remaining
WHERE l.id = remaining.lead_id;

NOTIFY pgrst, 'reload schema';
