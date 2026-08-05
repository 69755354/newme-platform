-- ================================================
-- Migration: widen business_events.chk_event_type (5 more audit types)
-- Task: P0 hotfix — close business_events audit-trail gap
-- Date: 2026-07-06
-- ================================================
--
-- Background
-- ───────────────────────────────────────────────
-- Migration 20260706000003 widened chk_event_type from 11 to 14 values by
-- adding 'quality_checked', 'project_info_updated', 'owner_change'. After
-- shipping P3-11 (route business_events writes via API) and P3-12 (list-page
-- writeEvent rewired), a dual audit (codex + opencode) found 5 event types
-- that callers send but the CHECK constraint (and the route allow-list)
-- still reject:
--
--   • note_added            — inline edit / quick note / source/type/status
--                             change audit
--   • probability_changed   — changeProbability handler
--   • status_changed        — changeStatus handler
--   • lost_reason_set       — changeLostReason handler
--   • followup_scheduled    — updateNextAction + updateNextFollowup handlers
--
-- Without this widening, every audit row above is silently dropped at the
-- DB layer (HTTP 400 from the route, swallowed by fire-and-forget callers).
-- Pre-P3-11, the same inserts hit the same DB CHECK rejection, so this
-- migration is the correct final step of the P3-11/P3-12 cleanup — not a
-- new feature.
--
-- The matching route at src/app/api/leads/[id]/events/route.ts
-- ALLOWED_EVENT_TYPES is widened in lockstep with this migration; both
-- MUST ship together.
--
-- Rollback
-- ───────────────────────────────────────────────
-- Recreate chk_event_type with the original 14-value list (see
-- migration 20260706000003). Removing the rows with the new event_types
-- is the only safe undo path if the widening must be reversed.
--
-- Pre-existing rows
-- ───────────────────────────────────────────────
-- No production rows currently exist with these event_types (the route's
-- 400 has been rejecting them since 2026-07-06 04:39 UTC deploy of 3ae8fef).
-- Safe to apply online.

BEGIN;

ALTER TABLE business_events DROP CONSTRAINT IF EXISTS chk_event_type;

ALTER TABLE business_events ADD CONSTRAINT chk_event_type
  CHECK (event_type IN (
    -- original 11 (kept untouched from 20260605000000_newme_crm_v22_complete)
    'stage_change','lead_stale_detected','transfer',
    'quotation_sent','quotation_accepted','quotation_rejected',
    'won','lost',
    'contract_activated','contract_completed',
    'payment_recorded',
    -- P3-11 widening (added 2026-07-06 in 20260706000003)
    'owner_change',
    'quality_checked',
    'project_info_updated',
    -- P0 hotfix widening (added 2026-07-06 in 20260706000004)
    'note_added',
    'probability_changed',
    'status_changed',
    'lost_reason_set',
    'followup_scheduled'
  )) NOT VALID;

-- Reload PostgREST schema cache so the next request sees the new CHECK.
NOTIFY pgrst, 'reload schema';

COMMIT;