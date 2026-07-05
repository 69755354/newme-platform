-- ================================================
-- Migration: widen business_events.chk_event_type
-- Task: task_P0_schema_alias_fix_combo
-- Date: 2026-07-06
-- ================================================
--
-- Background
-- ─────────────────────────────────────────────────
-- Migration 20260605000000_newme_crm_v22_complete.sql installed a CHECK
-- constraint on business_events.event_type:
--
--   chk_event_type CHECK (event_type IN (
--     'stage_change','lead_stale_detected','transfer',
--     'quotation_sent','quotation_accepted','quotation_rejected',
--     'won','lost',
--     'contract_activated','contract_completed',
--     'payment_recorded'
--   )) NOT VALID
--
-- The Lead Detail page now writes a 'quality_checked' audit row whenever
-- a sales rep rates a lead (poor/normal/good). Without widening the CHECK,
-- the INSERT fails with `new row for relation "business_events" violates
-- check constraint "chk_event_type"`.
--
-- This migration drops the existing constraint and recreates it WITH the
-- extra audit values that are already being written elsewhere in the
-- codebase (usePipelineDragDrop, useLeadMutations, quality route):
--
--   • quality_checked   — POST /api/leads/[id]/quality audit row
--   • project_info_updated — LeadDetail project-info batch save (T1 / P3-7)
--
-- NOT VALID is preserved so the rewrite is online and does not scan the
-- existing table; a follow-up VALIDATE CONSTRAINT can be scheduled once
-- historical event_type values are confirmed clean.
--
-- Rollback
-- ─────────────────────────────────────────────────
-- The original constraint was declared in 20260605000000; if this widening
-- is reversed, recreate the constraint at the head of that migration's
-- allowed list. Until then, removing the rows with the new event_types is
-- the only safe undo path.

BEGIN;

ALTER TABLE business_events DROP CONSTRAINT IF EXISTS chk_event_type;

ALTER TABLE business_events ADD CONSTRAINT chk_event_type
  CHECK (event_type IN (
    'stage_change','lead_stale_detected','owner_change','transfer',
    'quotation_sent','quotation_accepted','quotation_rejected',
    'won','lost',
    'contract_activated','contract_completed',
    'payment_recorded',
    -- P3-2c quality + project-info audit events (added 2026-07-06)
    -- lead_stale_detected: 线上已有 19 行, DB trigger 在 migrations
    --   20260612000010 + 20260701000006 写入, 不放进白名单会触发 INSERT 400
    'quality_checked',
    'project_info_updated'
  )) NOT VALID;

-- Reload PostgREST schema cache so the next request sees the new CHECK.
NOTIFY pgrst, 'reload schema';

COMMIT;