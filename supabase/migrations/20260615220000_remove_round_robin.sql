-- ============================================================
-- Remove Round-Robin Auto-Assignment (2026-06-15)
-- Business rule: leads are MANUALLY assigned by admin, not
-- auto-distributed. Removing the round-robin machinery.
--
-- KEPT:
--   - detect_stale_leads() — still valuable for monitoring
--   - reassign_lead() — still needed for manual reassignment
--   - business_events CHECK constraint — still valid for
--     lead_stale_detected and lead_reassigned events
-- ============================================================

-- 1. Drop the round-robin RPCs
DROP FUNCTION IF EXISTS auto_assign_lead() CASCADE;
DROP FUNCTION IF EXISTS assign_new_lead(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE
) CASCADE;

-- 2. Drop the singleton state table
DROP TABLE IF EXISTS lead_assignment_state CASCADE;
