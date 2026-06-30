-- =============================================================================
-- NewMe CRM - Schema Fix Migration
-- 2026-06-04
--
-- Fix stage/funnel_stage duality, add UUID reference columns, add missing
-- enterprise fields, create trigger functions for lead metrics and lost
-- reason management, and add all necessary indexes.
--
-- EVERY statement is idempotent — safe to run multiple times.
-- Data cleanup happens BEFORE any schema changes.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- PART A: Data cleanup BEFORE any schema changes
-- ═════════════════════════════════════════════════════════════════════════════

-- Map 'disqualified' → 'lost' in funnel_stage (130 rows)
-- Must run before the new CHECK constraint or column rename
UPDATE leads SET
  funnel_stage = 'lost',
  lost_reason   = COALESCE(lost_reason, 'Other'),
  updated_at    = NOW()
WHERE funnel_stage = 'disqualified';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART B: Fix stage / funnel_stage duality
-- ═════════════════════════════════════════════════════════════════════════════

-- 1. Drop old CHECK constraint on stage (name may differ per Postgres version)
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_stage_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- 2. Rename stage → stage_old (preserving old data for reference)
ALTER TABLE leads RENAME COLUMN stage TO stage_old;

-- 3. Rename funnel_stage → stage (the real 9-stage pipeline becomes the primary)
ALTER TABLE leads RENAME COLUMN funnel_stage TO stage;

-- 4. Add new CHECK constraint with all 9 stages
ALTER TABLE leads ADD CONSTRAINT leads_stage_check
  CHECK (stage IN (
    'new',
    'contacted',
    'requirement_confirmed',
    'solution_submitted',
    'quotation_submitted',
    'negotiation',
    'pending_decision',
    'won',
    'lost'
  ));

-- 5. Set DEFAULT 'new' moving forward
ALTER TABLE leads ALTER COLUMN stage SET DEFAULT 'new';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART C: UUID reference columns
-- ═════════════════════════════════════════════════════════════════════════════

-- 1. assigned_to_uuid — UUID FK to profiles, populated from TEXT assigned_to
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to_uuid UUID REFERENCES profiles(id);

DO $$ BEGIN
  UPDATE leads
  SET assigned_to_uuid = p.id
  FROM profiles p
  WHERE leads.assigned_to IS NOT NULL
    AND p.full_name IS NOT NULL
    AND leads.assigned_to_uuid IS NULL
    AND (
      -- Try matching if assigned_to is TEXT (full name)
      (leads.assigned_to::TEXT = p.full_name)
    );
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- 2. owner_uuid — UUID FK to profiles (avoid conflict with existing owner TEXT column)
--    The existing "owner" column is TEXT (from fix_owner_policies). We add owner_uuid UUID.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_uuid UUID REFERENCES profiles(id);

DO $$ BEGIN
  UPDATE leads
  SET owner_uuid = p.id
  FROM profiles p
  WHERE leads.owner IS NOT NULL
    AND p.full_name IS NOT NULL
    AND leads.owner_uuid IS NULL
    AND (leads.owner::TEXT = p.full_name);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- 3. sales_manager — may already exist as UUID from earlier migration
--    (20260603000000_add_crm_fields.sql line 8 added sales_manager UUID).  IF NOT
--    EXISTS makes this safe.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales_manager UUID REFERENCES profiles(id);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART D: Missing enterprise fields (all IF NOT EXISTS)
-- ═════════════════════════════════════════════════════════════════════════════

-- days_since_last_contact (may already exist from 20260603000000 line 24)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS days_since_last_contact INTEGER DEFAULT 0;

-- Lost reason boolean breakdown fields (may already exist from 20260603000000)
-- Note: line 30 of that migration has a syntax error (ALTER TABLE TABLE leads),
-- so these may not have been created
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_price              BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_competitor         BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_no_budget          BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_project_cancelled  BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_project_delayed    BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_no_response        BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_other              BOOLEAN DEFAULT false;

-- Fix quotation_value type to DECIMAL(12,2) if it exists with wrong type
DO $$ BEGIN
  ALTER TABLE leads ALTER COLUMN quotation_value TYPE DECIMAL(12,2);
EXCEPTION
  WHEN undefined_column THEN NULL;
  WHEN NOT_NULL_VIOLATION THEN NULL;
  WHEN others THEN NULL;
END $$;

-- Handle follow_up_count vs followup_count naming conflict
-- Some migrations used "followup_count" (20260602000000), others used "follow_up_count" (20260603000000).
-- Ensure both exist and follow_up_count has data if followup_count is populated.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_count INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_count INTEGER DEFAULT 0;

-- Sync follow_up_count from followup_count if the former is NULL and the latter has data
UPDATE leads
SET follow_up_count = COALESCE(followup_count, 0)
WHERE (follow_up_count IS NULL OR follow_up_count = 0)
  AND (followup_count IS NOT NULL AND followup_count > 0);

-- Vice versa: sync followup_count from follow_up_count
UPDATE leads
SET followup_count = COALESCE(follow_up_count, 0)
WHERE (followup_count IS NULL OR followup_count = 0)
  AND (follow_up_count IS NOT NULL AND follow_up_count > 0);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART E: Create / replace update_lead_metrics trigger function
-- ═════════════════════════════════════════════════════════════════════════════

-- Drop existing trigger first to allow function replacement with new logic
DROP TRIGGER IF EXISTS trg_update_lead_metrics ON leads;

-- Complete trigger function for BEFORE UPDATE on leads
CREATE OR REPLACE FUNCTION update_lead_metrics()
RETURNS TRIGGER AS $$
BEGIN
  -- ═══════ 1. Calculate days_since_last_contact ═══════
  IF NEW.last_contact_date IS NOT NULL AND NEW.last_contact_date IS DISTINCT FROM OLD.last_contact_date THEN
    NEW.days_since_last_contact := GREATEST(0, EXTRACT(DAY FROM NOW() - NEW.last_contact_date::TIMESTAMPTZ)::INTEGER);
  END IF;

  -- ═══════ 2. Track follow_up_count increments ═══════
  -- Increment when a new follow-up action is being recorded
  IF NEW.next_action IS DISTINCT FROM OLD.next_action AND NEW.next_action IS NOT NULL THEN
    NEW.follow_up_count := COALESCE(OLD.follow_up_count, 0) + 1;
  END IF;

  -- ═══════ 3. Recovery candidate flag (7+ days overdue) ═══════
  IF NEW.next_followup_date IS NOT NULL AND NEW.next_followup_date <= NOW() THEN
    IF NEW.next_followup_date <= NOW() - INTERVAL '7 days' THEN
      NEW.recovery_candidate := true;
    END IF;
  END IF;

  -- ═══════ 4. Transfer candidate flag (14+ days overdue) ═══════
  IF NEW.next_followup_date IS NOT NULL AND NEW.next_followup_date <= NOW() THEN
    IF NEW.next_followup_date <= NOW() - INTERVAL '14 days' THEN
      NEW.transfer_candidate := true;
    END IF;
  END IF;

  -- ═══════ 5. Quotation 14-day / 30-day timeouts ═══════
  IF NEW.stage = 'quotation_submitted' THEN
    IF NEW.updated_at <= NOW() - INTERVAL '30 days' THEN
      NEW.transfer_candidate := true;
    ELSIF NEW.updated_at <= NOW() - INTERVAL '14 days' THEN
      NEW.recovery_candidate := true;
    END IF;
  END IF;

  -- ═══════ 6. 70%+ probability + 14 days → sales_manager_review ═══════
  IF NEW.win_probability >= 70 AND NEW.sales_manager_review IS DISTINCT FROM true THEN
    IF NEW.updated_at <= NOW() - INTERVAL '14 days' AND NEW.stage NOT IN ('won', 'lost') THEN
      NEW.sales_manager_review := true;
    END IF;
  END IF;

  -- ═══════ 7. Pending decision > 30 days → sales_manager_review ═══════
  IF NEW.stage = 'pending_decision' AND NEW.hold_since IS NULL THEN
    IF NEW.updated_at <= NOW() - INTERVAL '30 days' THEN
      NEW.sales_manager_review := true;
      NEW.hold_since := NEW.updated_at;
    END IF;
  END IF;

  -- ═══════ 8. Reset recovery/transfer flags if follow-up is up-to-date ═══════
  IF NEW.next_followup_date IS NOT NULL AND NEW.next_followup_date > NOW() THEN
    IF OLD.recovery_candidate = true THEN
      NEW.recovery_candidate := false;
    END IF;
    IF OLD.transfer_candidate = true AND NEW.next_followup_date > NOW() + INTERVAL '7 days' THEN
      NEW.transfer_candidate := false;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-create the trigger
CREATE TRIGGER trg_update_lead_metrics
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_lead_metrics();

-- ═════════════════════════════════════════════════════════════════════════════
-- PART F: Lost reason trigger
-- ═════════════════════════════════════════════════════════════════════════════

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_set_lost_reasons ON leads;

-- Function: when stage changes to 'lost', auto-set lost_reason_* booleans
CREATE OR REPLACE FUNCTION set_lost_reasons()
RETURNS TRIGGER AS $$
BEGIN
  -- Only act when stage changes TO 'lost'
  IF NEW.stage = 'lost' AND (OLD.stage IS DISTINCT FROM 'lost' OR TG_OP = 'INSERT') THEN
    -- Reset all lost reason booleans to false first
    NEW.lost_reason_price             := false;
    NEW.lost_reason_competitor        := false;
    NEW.lost_reason_no_budget         := false;
    NEW.lost_reason_project_cancelled := false;
    NEW.lost_reason_project_delayed   := false;
    NEW.lost_reason_no_response       := false;
    NEW.lost_reason_other             := false;

    -- Parse lost_reason text (comma-separated or newline-separated)
    IF NEW.lost_reason IS NOT NULL THEN
      -- Price / too expensive
      IF NEW.lost_reason ILIKE '%price%' OR NEW.lost_reason ILIKE '%expensive%'
         OR NEW.lost_reason ILIKE '%cost%' OR NEW.lost_reason ILIKE '%cheap%'
         OR NEW.lost_reason ILIKE '%高%' OR NEW.lost_reason ILIKE '%贵%'
         OR NEW.lost_reason ILIKE '%budget%' THEN
        NEW.lost_reason_price := true;
      END IF;

      -- Competitor / chose another / 竞争对手
      IF NEW.lost_reason ILIKE '%competitor%' OR NEW.lost_reason ILIKE '%competition%'
         OR NEW.lost_reason ILIKE '%another company%' OR NEW.lost_reason ILIKE '%chose%'
         OR NEW.lost_reason ILIKE '%竞争对手%' OR NEW.lost_reason ILIKE '%别家%'
         OR NEW.lost_reason ILIKE '%other vendor%' OR NEW.lost_reason ILIKE '%other supplier%' THEN
        NEW.lost_reason_competitor := true;
      END IF;

      -- No budget / 没预算
      IF NEW.lost_reason ILIKE '%no budget%' OR NEW.lost_reason ILIKE '%budget%'
         OR NEW.lost_reason ILIKE '%没预算%' OR NEW.lost_reason ILIKE '%没钱%'
         OR NEW.lost_reason ILIKE '%no funds%' OR NEW.lost_reason ILIKE '%can%t afford%' THEN
        NEW.lost_reason_no_budget := true;
      END IF;

      -- Project cancelled / 项目取消
      IF NEW.lost_reason ILIKE '%cancel%' OR NEW.lost_reason ILIKE '%cancelled%'
         OR NEW.lost_reason ILIKE '%项目取消%' OR NEW.lost_reason ILIKE '%取消%'
         OR NEW.lost_reason ILIKE '%abandon%' OR NEW.lost_reason ILIKE '%scrapped%'
         OR NEW.lost_reason ILIKE '%on hold%' OR NEW.lost_reason ILIKE '%hold%' THEN
        NEW.lost_reason_project_cancelled := true;
      END IF;

      -- Project delayed / 项目延期
      IF NEW.lost_reason ILIKE '%delay%' OR NEW.lost_reason ILIKE '%delayed%'
         OR NEW.lost_reason ILIKE '%postpone%' OR NEW.lost_reason ILIKE '%延期%'
         OR NEW.lost_reason ILIKE '%later%' OR NEW.lost_reason ILIKE '%reschedule%'
         OR NEW.lost_reason ILIKE '%not now%' OR NEW.lost_reason ILIKE '%not yet%' THEN
        NEW.lost_reason_project_delayed := true;
      END IF;

      -- No response / 无回复
      IF NEW.lost_reason ILIKE '%no response%' OR NEW.lost_reason ILIKE '%unreachable%'
         OR NEW.lost_reason ILIKE '%not responding%' OR NEW.lost_reason ILIKE '%no reply%'
         OR NEW.lost_reason ILIKE '%无回复%' OR NEW.lost_reason ILIKE '%不回复%'
         OR NEW.lost_reason ILIKE '%ignored%' OR NEW.lost_reason ILIKE '%ghost%'
         OR NEW.lost_reason ILIKE '%disappear%' OR NEW.lost_reason ILIKE '%MIA%'
         OR NEW.lost_reason ILIKE '%no answer%' THEN
        NEW.lost_reason_no_response := true;
      END IF;

      -- If none matched, mark as "other"
      IF NOT (NEW.lost_reason_price OR NEW.lost_reason_competitor
              OR NEW.lost_reason_no_budget OR NEW.lost_reason_project_cancelled
              OR NEW.lost_reason_project_delayed OR NEW.lost_reason_no_response) THEN
        NEW.lost_reason_other := true;
      END IF;
    ELSE
      -- No lost_reason text provided — mark as "other"
      NEW.lost_reason_other := true;
    END IF;
  END IF;

  -- Also handle the reverse: if a lead moves OUT of 'lost', clear the booleans
  IF OLD.stage = 'lost' AND NEW.stage IS DISTINCT FROM 'lost' THEN
    NEW.lost_reason_price             := false;
    NEW.lost_reason_competitor        := false;
    NEW.lost_reason_no_budget         := false;
    NEW.lost_reason_project_cancelled := false;
    NEW.lost_reason_project_delayed   := false;
    NEW.lost_reason_no_response       := false;
    NEW.lost_reason_other             := false;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger on BEFORE UPDATE
CREATE TRIGGER trg_set_lost_reasons
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_lost_reasons();

-- ═════════════════════════════════════════════════════════════════════════════
-- PART G: All indexes (IF NOT EXISTS)
-- ═════════════════════════════════════════════════════════════════════════════

-- Stage / funnel indexes
CREATE INDEX IF NOT EXISTS idx_leads_stage             ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_stage_old         ON leads(stage_old);
CREATE INDEX IF NOT EXISTS idx_leads_funnel_stage      ON leads(stage);
  -- (same as idx_leads_stage after rename, kept for completeness)

-- Assigned-to / ownership
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to_uuid  ON leads(assigned_to_uuid);
CREATE INDEX IF NOT EXISTS idx_leads_owner_uuid        ON leads(owner_uuid);
CREATE INDEX IF NOT EXISTS idx_leads_owner             ON leads(owner);
CREATE INDEX IF NOT EXISTS idx_leads_sales_manager     ON leads(sales_manager);

-- Lead status / probability
CREATE INDEX IF NOT EXISTS idx_leads_lead_status       ON leads(lead_status);
CREATE INDEX IF NOT EXISTS idx_leads_win_probability   ON leads(win_probability);

-- Contact / follow-up dates
CREATE INDEX IF NOT EXISTS idx_leads_last_contact_date     ON leads(last_contact_date);
CREATE INDEX IF NOT EXISTS idx_leads_next_followup_date    ON leads(next_followup_date);
CREATE INDEX IF NOT EXISTS idx_leads_days_since_contact    ON leads(days_since_last_contact);

-- Manager oversight flags (partial indexes for performance)
CREATE INDEX IF NOT EXISTS idx_leads_recovery_candidate
  ON leads(recovery_candidate) WHERE recovery_candidate = true;
CREATE INDEX IF NOT EXISTS idx_leads_transfer_candidate
  ON leads(transfer_candidate) WHERE transfer_candidate = true;
CREATE INDEX IF NOT EXISTS idx_leads_sales_manager_review
  ON leads(sales_manager_review) WHERE sales_manager_review = true;

-- Lost reason booleans (composite for analytics)
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason_price             ON leads(lost_reason_price) WHERE lost_reason_price = true;
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason_competitor        ON leads(lost_reason_competitor) WHERE lost_reason_competitor = true;
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason_no_budget         ON leads(lost_reason_no_budget) WHERE lost_reason_no_budget = true;
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason_project_cancelled ON leads(lost_reason_project_cancelled) WHERE lost_reason_project_cancelled = true;
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason_project_delayed   ON leads(lost_reason_project_delayed) WHERE lost_reason_project_delayed = true;
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason_no_response       ON leads(lost_reason_no_response) WHERE lost_reason_no_response = true;
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason_other             ON leads(lost_reason_other) WHERE lost_reason_other = true;

-- Quotation value index
CREATE INDEX IF NOT EXISTS idx_leads_quotation_value   ON leads(quotation_value);

-- Source / campaign indexes
CREATE INDEX IF NOT EXISTS idx_leads_source_platform   ON leads(source_platform);
CREATE INDEX IF NOT EXISTS idx_leads_campaign_name     ON leads(campaign_name);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART H: Schema reload
-- ═════════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
