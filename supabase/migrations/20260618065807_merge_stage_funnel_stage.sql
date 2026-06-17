-- Migration: Consolidate stage column into funnel_stage
-- Description: Migrate data from stage -> funnel_stage, enforce NOT NULL, drop stage column
-- Author: GLM 5.2
-- Date: 2025-01-XX

-- Replace `your_table_name` with the actual table name (e.g., leads, opportunities, deals)
-- If you have multiple tables with this pattern, duplicate this migration for each.

BEGIN;

-- ============================================================
-- Step 1: Copy non-null stage values to funnel_stage
-- Only update records where funnel_stage is currently NULL
-- ============================================================
UPDATE your_table_name
SET funnel_stage = stage
WHERE funnel_stage IS NULL 
  AND stage IS NOT NULL;

-- ============================================================
-- Step 2: Handle edge case - records where BOTH are NULL
-- Adjust the default value based on your domain logic
-- Common options: 'new', 'lead', 'unknown', 'prospecting'
-- ============================================================
UPDATE your_table_name
SET funnel_stage = COALESCE(funnel_stage, 'new')
WHERE funnel_stage IS NULL;

-- ============================================================
-- Step 3: Verify data integrity before constraining
-- This query helps you audit before making the column NOT NULL
-- ============================================================
-- SELECT COUNT(*) FROM your_table_name WHERE funnel_stage IS NULL;
-- Expected: 0 rows

-- ============================================================
-- Step 4: Make funnel_stage NOT NULL
-- ============================================================
ALTER TABLE your_table_name 
ALTER COLUMN funnel_stage SET NOT NULL;

-- ============================================================
-- Step 5: Add CHECK constraint if you have valid stage values
-- Uncomment and adjust based on your valid stage values
-- ============================================================
-- ALTER TABLE your_table_name
-- ADD CONSTRAINT chk_funnel_stage_valid 
-- CHECK (funnel_stage IN ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost'));

-- ============================================================
-- Step 6: Add index on funnel_stage if frequently queried
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_your_table_funnel_stage 
ON your_table_name(funnel_stage);

-- ============================================================
-- Step 7: Drop the legacy stage column
-- ============================================================
ALTER TABLE your_table_name 
DROP COLUMN IF EXISTS stage;

-- ============================================================
-- Step 8: Update column comment for documentation
-- ============================================================
COMMENT ON COLUMN your_table_name.funnel_stage IS 
'Consolidated funnel stage. Migrated from former stage column. NOT NULL enforced.';

COMMIT;

-- ============================================================
-- Rollback script (save separately if needed)
-- ============================================================
-- BEGIN;
-- ALTER TABLE your_table_name ADD COLUMN stage VARCHAR;
-- ALTER TABLE your_table_name ALTER COLUMN funnel_stage DROP NOT NULL;
-- DROP INDEX IF EXISTS idx_your_table_funnel_stage;
-- COMMIT;
