\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'leads'
      AND column_name = 'organization_id'
  )
  THEN 'true'
  ELSE 'false'
END AS sam21_post_migration
\gset

\if :sam21_post_migration
WITH
table_counts AS (
  SELECT jsonb_build_object(
    'profiles', (SELECT count(*) FROM public.profiles),
    'active_profiles', (
      SELECT count(*) FROM public.profiles WHERE is_active IS TRUE
    ),
    'leads', (SELECT count(*) FROM public.leads),
    'activities', (SELECT count(*) FROM public.activities),
    'business_events', (SELECT count(*) FROM public.business_events),
    'chat_messages', (SELECT count(*) FROM public.chat_messages),
    'follow_up_logs', (SELECT count(*) FROM public.follow_up_logs),
    'lead_documents', (SELECT count(*) FROM public.lead_documents),
    'lead_milestones', (SELECT count(*) FROM public.lead_milestones),
    'tasks', (SELECT count(*) FROM public.tasks),
    'snapshots', (SELECT count(*) FROM public.crm_daily_funnel_snapshot),
    'memberships', (SELECT count(*) FROM public.memberships)
  ) AS value
),
stage_counts AS (
  SELECT coalesce(jsonb_object_agg(current_milestone, lead_count), '{}'::jsonb)
    AS value
  FROM (
    SELECT coalesce(current_milestone, '__null__') AS current_milestone,
      count(*) AS lead_count
    FROM public.leads
    GROUP BY coalesce(current_milestone, '__null__')
  ) grouped
),
lead_owners AS (
  SELECT md5(coalesce(string_agg(
    concat_ws(
      ':',
      id::text,
      coalesce(assigned_to::text, ''),
      coalesce(created_by::text, '')
    ),
    '|' ORDER BY id
  ), '')) AS value
  FROM public.leads
),
history_relationships AS (
  SELECT md5(coalesce(string_agg(
    concat_ws(
      ':',
      source_table,
      id::text,
      coalesce(lead_id::text, ''),
      coalesce(actor_id::text, '')
    ),
    '|' ORDER BY source_table, id
  ), '')) AS value
  FROM (
    SELECT 'activities' AS source_table, id, lead_id, user_id AS actor_id
      FROM public.activities
    UNION ALL
    SELECT 'business_events', id, lead_id, created_by
      FROM public.business_events
    UNION ALL
    SELECT 'chat_messages', id, lead_id, NULL::uuid
      FROM public.chat_messages
    UNION ALL
    SELECT 'follow_up_logs', id, lead_id, coalesce(created_by, user_id)
      FROM public.follow_up_logs
    UNION ALL
    SELECT 'lead_milestones', id, lead_id, completed_by
      FROM public.lead_milestones
    UNION ALL
    SELECT 'tasks', id, lead_id, assignee_id
      FROM public.tasks
  ) history_rows
),
document_ownership AS (
  SELECT md5(coalesce(string_agg(
    concat_ws(
      ':',
      id::text,
      lead_id::text,
      coalesce(uploaded_by::text, ''),
      coalesce(file_size::text, '')
    ),
    '|' ORDER BY id
  ), '')) AS value
  FROM public.lead_documents
),
orphan_counts AS (
  SELECT jsonb_build_object(
    'lead_owner_missing', (
      SELECT count(*)
      FROM public.leads lead_row
      LEFT JOIN public.profiles profile ON profile.id = lead_row.assigned_to
      WHERE lead_row.assigned_to IS NOT NULL AND profile.id IS NULL
    ),
    'history_parent_missing', (
      SELECT count(*)
      FROM (
        SELECT lead_id FROM public.activities
        UNION ALL SELECT lead_id FROM public.business_events
        UNION ALL SELECT lead_id FROM public.chat_messages
        UNION ALL SELECT lead_id FROM public.follow_up_logs
        UNION ALL SELECT lead_id FROM public.lead_milestones
        UNION ALL SELECT lead_id FROM public.tasks
      ) history
      LEFT JOIN public.leads lead_row ON lead_row.id = history.lead_id
      WHERE history.lead_id IS NOT NULL AND lead_row.id IS NULL
    ),
    'document_parent_missing', (
      SELECT count(*)
      FROM public.lead_documents document
      LEFT JOIN public.leads lead_row ON lead_row.id = document.lead_id
      WHERE lead_row.id IS NULL
    )
  ) AS value
)
SELECT jsonb_build_object(
  'contract', 'sam21-readonly-reconciliation-v1',
  'schema_phase', 'post',
  'transaction_read_only', current_setting('transaction_read_only')::boolean,
  'aggregate_counts', table_counts.value,
  'quotation_value_total', (
    SELECT coalesce(sum(quotation_value), 0) FROM public.leads
  ),
  'stage_counts', stage_counts.value,
  'lead_owner_digest', lead_owners.value,
  'history_relationship_digest', history_relationships.value,
  'document_ownership_digest', document_ownership.value,
  'orphan_counts', orphan_counts.value,
  'legacy_lead_count', (
    SELECT count(*)
    FROM public.leads
    WHERE organization_id =
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
  ),
  'non_legacy_lead_count', (
    SELECT count(*)
    FROM public.leads
    WHERE organization_id <>
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
  ),
  'legacy_snapshot_count', (
    SELECT count(*)
    FROM public.crm_daily_funnel_snapshot
    WHERE organization_id =
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
  ),
  'active_legacy_membership_count', (
    SELECT count(*)
    FROM public.memberships
    WHERE organization_id =
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
      AND status = 'active'
  )
)
FROM table_counts, stage_counts, lead_owners, history_relationships,
  document_ownership, orphan_counts;
\else
WITH
table_counts AS (
  SELECT jsonb_build_object(
    'profiles', (SELECT count(*) FROM public.profiles),
    'active_profiles', (
      SELECT count(*) FROM public.profiles WHERE is_active IS TRUE
    ),
    'leads', (SELECT count(*) FROM public.leads),
    'activities', (SELECT count(*) FROM public.activities),
    'business_events', (SELECT count(*) FROM public.business_events),
    'chat_messages', (SELECT count(*) FROM public.chat_messages),
    'follow_up_logs', (SELECT count(*) FROM public.follow_up_logs),
    'lead_documents', (SELECT count(*) FROM public.lead_documents),
    'lead_milestones', (SELECT count(*) FROM public.lead_milestones),
    'tasks', (SELECT count(*) FROM public.tasks),
    'snapshots', (SELECT count(*) FROM public.crm_daily_funnel_snapshot)
  ) AS value
),
stage_counts AS (
  SELECT coalesce(jsonb_object_agg(current_milestone, lead_count), '{}'::jsonb)
    AS value
  FROM (
    SELECT coalesce(current_milestone, '__null__') AS current_milestone,
      count(*) AS lead_count
    FROM public.leads
    GROUP BY coalesce(current_milestone, '__null__')
  ) grouped
),
lead_owners AS (
  SELECT md5(coalesce(string_agg(
    concat_ws(
      ':',
      id::text,
      coalesce(assigned_to::text, ''),
      coalesce(created_by::text, '')
    ),
    '|' ORDER BY id
  ), '')) AS value
  FROM public.leads
),
history_relationships AS (
  SELECT md5(coalesce(string_agg(
    concat_ws(
      ':',
      source_table,
      id::text,
      coalesce(lead_id::text, ''),
      coalesce(actor_id::text, '')
    ),
    '|' ORDER BY source_table, id
  ), '')) AS value
  FROM (
    SELECT 'activities' AS source_table, id, lead_id, user_id AS actor_id
      FROM public.activities
    UNION ALL
    SELECT 'business_events', id, lead_id, created_by
      FROM public.business_events
    UNION ALL
    SELECT 'chat_messages', id, lead_id, NULL::uuid
      FROM public.chat_messages
    UNION ALL
    SELECT 'follow_up_logs', id, lead_id, coalesce(created_by, user_id)
      FROM public.follow_up_logs
    UNION ALL
    SELECT 'lead_milestones', id, lead_id, completed_by
      FROM public.lead_milestones
    UNION ALL
    SELECT 'tasks', id, lead_id, assignee_id
      FROM public.tasks
  ) history_rows
),
document_ownership AS (
  SELECT md5(coalesce(string_agg(
    concat_ws(
      ':',
      id::text,
      lead_id::text,
      coalesce(uploaded_by::text, ''),
      coalesce(file_size::text, '')
    ),
    '|' ORDER BY id
  ), '')) AS value
  FROM public.lead_documents
),
orphan_counts AS (
  SELECT jsonb_build_object(
    'lead_owner_missing', (
      SELECT count(*)
      FROM public.leads lead_row
      LEFT JOIN public.profiles profile ON profile.id = lead_row.assigned_to
      WHERE lead_row.assigned_to IS NOT NULL AND profile.id IS NULL
    ),
    'history_parent_missing', (
      SELECT count(*)
      FROM (
        SELECT lead_id FROM public.activities
        UNION ALL SELECT lead_id FROM public.business_events
        UNION ALL SELECT lead_id FROM public.chat_messages
        UNION ALL SELECT lead_id FROM public.follow_up_logs
        UNION ALL SELECT lead_id FROM public.lead_milestones
        UNION ALL SELECT lead_id FROM public.tasks
      ) history
      LEFT JOIN public.leads lead_row ON lead_row.id = history.lead_id
      WHERE history.lead_id IS NOT NULL AND lead_row.id IS NULL
    ),
    'document_parent_missing', (
      SELECT count(*)
      FROM public.lead_documents document
      LEFT JOIN public.leads lead_row ON lead_row.id = document.lead_id
      WHERE lead_row.id IS NULL
    )
  ) AS value
)
SELECT jsonb_build_object(
  'contract', 'sam21-readonly-reconciliation-v1',
  'schema_phase', 'pre',
  'transaction_read_only', current_setting('transaction_read_only')::boolean,
  'aggregate_counts', table_counts.value,
  'quotation_value_total', (
    SELECT coalesce(sum(quotation_value), 0) FROM public.leads
  ),
  'stage_counts', stage_counts.value,
  'lead_owner_digest', lead_owners.value,
  'history_relationship_digest', history_relationships.value,
  'document_ownership_digest', document_ownership.value,
  'orphan_counts', orphan_counts.value
)
FROM table_counts, stage_counts, lead_owners, history_relationships,
  document_ownership, orphan_counts;
\endif

COMMIT;
