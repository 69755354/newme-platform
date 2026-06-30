-- =============================================================================
-- NewMe CRM - Clean up duplicate indexes after standardization
-- 2026-06-02 23:01
--
-- Drop old-named indexes that are now replaced by canonical names:
--   idx_leads_assigned    → idx_leads_assigned_to  (same col)
--   idx_leads_created     → idx_leads_created_at   (same col)
--   idx_leads_lead_status → idx_leads_status       (same col)
-- =============================================================================

-- Drop old duplicate indexes (safe: no other table/column references them)
DROP INDEX IF EXISTS idx_leads_assigned;
DROP INDEX IF EXISTS idx_leads_created;
DROP INDEX IF EXISTS idx_leads_lead_status;

NOTIFY pgrst, 'reload schema';
