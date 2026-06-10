-- =============================================================================
-- NewMe CRM - Database Repair: Index standardization + RLS hardening
-- 2026-06-02 23:00
--
-- 1. Fix idx_leads_stage (currently on stage_old → move to stage)
-- 2. Add idx_leads_assigned_to (alias for idx_leads_assigned)
-- 3. Add idx_leads_created_at (alias for idx_leads_created)
-- 4. Add idx_leads_status (alias for idx_leads_lead_status)
-- 5. Harden RLS policies: remove public ALL-UPDATE and public ALL-SELECT on leads
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- PART A: Index standardization on leads
-- ═════════════════════════════════════════════════════════════════════════════

-- 1. Fix idx_leads_stage — currently named idx_leads_stage but on stage_old
--    (legacy from stage→stage_old rename in 20260604000000). Drop it and
--    create a properly-named one on the actual stage column.
DROP INDEX IF EXISTS idx_leads_stage;
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);

-- 2. idx_leads_assigned_to — add explicit index for the TEXT assigned_to column
--    (equivalent index idx_leads_assigned already exists; this adds the
--     canonical name for query planner compatibility)
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to);

-- 3. idx_leads_created_at — DESC index for recency queries
--    (equivalent index idx_leads_created already exists)
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);

-- 4. idx_leads_status — alias for idx_leads_lead_status
--    (equivalent index already exists, this adds canonical name)
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(lead_status);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART B: RLS policy audit — leads table
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Current leads RLS policies (audited 2026-06-02):
--
--   1. "Allow all inserts"  — public INSERT with_check=true    ← KEEP (lead forms)
--   2. "Allow all reads"    — public SELECT qual=true          ← REMOVE (data leak)
--   3. "Allow all updates"  — public UPDATE qual=true          ← REMOVE (security hole)
--   4. admin_all            — public ALL, admin/manager check  ← KEEP
--   5. leads_auth           — authenticated ALL true           ← KEEP
--   6. sales_own_leads      — public SELECT own               ← KEEP
--   7. sales_update_own     — public UPDATE own                ← KEEP
--
-- The "Allow all reads" + "Allow all updates" policies expose ALL leads
-- (including PII: name, phone, email) to ANY anonymous user. This is a
-- data privacy risk. These were likely artifacts from early development.
--
-- After removal:
--   - Anonymous: only INSERT (lead capture forms) + own SELECT via sales_own_leads
--     (but auth.uid() is NULL for anon, so sales_own_leads only matches
--      leads with assigned_to IS NULL — unassigned leads are readable)
--   - Authenticated: full access via leads_auth
--   - Admin/manager: full access via admin_all
--   - Sales: SELECT own + UPDATE own via sales_own + sales_update_own

-- Remove the overly broad public access policies
DROP POLICY IF EXISTS "Allow all reads" ON leads;
DROP POLICY IF EXISTS "Allow all updates" ON leads;

-- Also drop duplicate/misnamed policy if present
DROP POLICY IF EXISTS "Allow all reads" ON public.leads;
DROP POLICY IF EXISTS "Allow all updates" ON public.leads;

-- Keep "Allow all inserts" for lead capture forms from landing pages
-- (already exists, no change needed)

-- ═════════════════════════════════════════════════════════════════════════════
-- PART C: RLS policy audit — business_events table
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Current business_events RLS policies:
--
--   1. be_admin_all      — public ALL, admin/manager check    ← KEEP
--   2. be_anon_insert    — public INSERT with_check=true      ← KEEP (needed)
--   3. be_anon_select    — public SELECT true                 ← REMOVE (data leak)
--   4. be_anon_update    — public UPDATE true                 ← REMOVE (security hole)
--
-- The be_anon_select and be_anon_update expose all business events to
-- anonymous users. Business events contain lead activity history which
-- should be private. Keep be_anon_insert for automated event logging.

DROP POLICY IF EXISTS be_anon_select ON business_events;
DROP POLICY IF EXISTS be_anon_update ON business_events;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART D: Refresh PostgREST schema cache
-- ═════════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
