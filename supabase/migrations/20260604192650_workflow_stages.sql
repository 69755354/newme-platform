-- =============================================================================
-- Workflow Management — 5-stage tracking embedded in Lead detail
-- =============================================================================
-- RENAMED 2026-08-11 from 1780601210_workflow_stages.sql. The old name carried a
-- 10-digit unix epoch, not the 14-digit timestamp the Supabase CLI requires, so
-- the CLI never saw this file: it was not in `supabase migration list`, it was
-- never pushed, and it was never replayed. public.lead_workflow_stages
-- nonetheless exists in production (it is in the generated src/types/database.ts
-- and four routes read it), which means it was applied to production by hand and
-- the migration directory has been silently short one table ever since.
--
-- 20260604192650 is the same instant the epoch prefix encoded
-- (1780601210 = 2026-06-04T19:26:50Z), so the file keeps its intended position:
-- after 20260602000000_crm_v2_columns.sql, which adds the
-- leads.disqualified_candidate column the seed queries below read.
--
-- The DDL was made idempotent in the same change. Renaming alone would have made
-- the file visible to the CLI and then failed on the next push, because
-- `CREATE TABLE lead_workflow_stages` against a database that already has the
-- table is an error.
--
-- The seed INSERTs needed more than idempotence. They were already guarded by
-- NOT EXISTS per (lead_id, stage_key), which stops duplicates but does not stop
-- them running: making the file visible would have let them insert five rows for
-- every active, non-disqualified lead in production the first time it was pushed,
-- months after the table was created by hand and after the routes had been
-- creating stage rows on demand. A rename is not licence to write production
-- rows. They are now gated on this migration actually being the thing that
-- created the table, which is recorded before the CREATE below. Against
-- production the whole file is a no-op; against an empty database it behaves
-- exactly as it always intended to.
--
-- Exercised by scripts/replay-migrations.sh.
-- =============================================================================

-- Whether the table pre-dates this migration. Must be captured BEFORE the
-- CREATE TABLE IF NOT EXISTS below, or it always reads as pre-existing.
--
-- A session GUC rather than a temp table: a temp table would have to be dropped
-- afterwards, and scripts/check-db-static.mjs rejects destructive drops in any
-- migration not named for rollback — correctly, since that is the pattern by
-- which migrations lose production data. (That check greps the file as text,
-- comments included, so do not spell the statement out here.)
-- The GUC is session-scoped (is_local => false) on purpose:
-- the Supabase CLI wraps each file in one transaction, but an operator running
-- `psql -f` gets a transaction per statement, and a transaction-local setting
-- would be gone by the time the seed block below reads it.
SELECT set_config(
  'newme.wf_stages_pre_existing',
  (to_regclass('public.lead_workflow_stages') IS NOT NULL)::text,
  false
);

CREATE TABLE IF NOT EXISTS lead_workflow_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL
    CHECK (stage_key IN ('requirement','design','quotation','negotiation','handover')),
  stage_order INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 20
    CHECK (weight IN (20,30,50,60,80)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','skipped')),
  assigned_to UUID REFERENCES profiles(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  notified_24h BOOLEAN DEFAULT false,
  notified_48h BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (lead_id, stage_key)
);

CREATE INDEX IF NOT EXISTS idx_wf_lead ON lead_workflow_stages(lead_id);
CREATE INDEX IF NOT EXISTS idx_wf_status ON lead_workflow_stages(status);
CREATE INDEX IF NOT EXISTS idx_wf_deadline ON lead_workflow_stages(deadline_at)
  WHERE status IN ('pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_wf_assigned ON lead_workflow_stages(assigned_to);

ALTER TABLE lead_workflow_stages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wf_admin_all" ON lead_workflow_stages;
CREATE POLICY "wf_admin_all" ON lead_workflow_stages FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

DROP POLICY IF EXISTS "wf_sales_select" ON lead_workflow_stages;
CREATE POLICY "wf_sales_select" ON lead_workflow_stages FOR SELECT
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_workflow_stages.lead_id AND l.assigned_to = auth.uid()));

DROP POLICY IF EXISTS "wf_sales_insert" ON lead_workflow_stages;
CREATE POLICY "wf_sales_insert" ON lead_workflow_stages FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id AND l.assigned_to = auth.uid()));

DROP POLICY IF EXISTS "wf_sales_update" ON lead_workflow_stages;
CREATE POLICY "wf_sales_update" ON lead_workflow_stages FOR UPDATE
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_workflow_stages.lead_id AND l.assigned_to = auth.uid()));

-- Seed the default 5 stages for existing leads, but only on first creation.
-- See the header: on a table that already exists this block is skipped entirely,
-- because by then the application owns the rows.
DO $$
BEGIN
  IF current_setting('newme.wf_stages_pre_existing', true) = 'true' THEN
    RAISE NOTICE 'lead_workflow_stages already existed; skipping stage seed';
    RETURN;
  END IF;

  INSERT INTO lead_workflow_stages (lead_id, stage_key, stage_order, weight, status)
  SELECT l.id, s.stage_key, s.stage_order, s.weight, 'pending'
  FROM leads l
  CROSS JOIN (VALUES
    ('requirement', 1, 20),
    ('design',      2, 30),
    ('quotation',   3, 50),
    ('negotiation', 4, 60),
    ('handover',    5, 80)
  ) AS s(stage_key, stage_order, weight)
  WHERE l.stage NOT IN ('won','lost')
    AND NOT COALESCE(l.disqualified_candidate, false)
    AND NOT EXISTS (
      SELECT 1 FROM lead_workflow_stages w
      WHERE w.lead_id = l.id AND w.stage_key = s.stage_key
    );
END
$$;

NOTIFY pgrst, 'reload schema';
