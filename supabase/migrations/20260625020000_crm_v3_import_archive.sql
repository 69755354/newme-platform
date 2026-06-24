-- 20260625020000_crm_v3_import_archive.sql
-- CRM v3 Phase 1 Batch 4: Excel Import (P0-3) + Mohamed soft-archive (P0-4)
-- rule_009: idempotent (IF NOT EXISTS / DROP IF EXISTS)
-- Non-locking: all added columns are nullable or have safe defaults.

-- ════════════════════════════════════════════════════════════
-- 1. leads: import + archive audit columns
-- ════════════════════════════════════════════════════════════
ALTER TABLE leads ADD COLUMN IF NOT EXISTS raw_import_data  JSONB;        -- raw_status/raw_source/raw_note/row_number/source_file
ALTER TABLE leads ADD COLUMN IF NOT EXISTS import_batch_id  UUID;         -- groups one import run
ALTER TABLE leads ADD COLUMN IF NOT EXISTS imported_by      UUID REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS imported_at      TIMESTAMPTZ;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_at      TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archive_batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_leads_import_batch ON leads(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_leads_archive_batch ON leads(archive_batch_id);
CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads(archived) WHERE archived = true;

-- ════════════════════════════════════════════════════════════
-- 2. Relax leads.source CHECK — allow imported sources
--    (instagram from "instgram", unknown_import for blank source)
-- ════════════════════════════════════════════════════════════
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_source_check CHECK (
  source IN ('meta_ads','whatsapp','website','offline','referral','other',
             'instagram','unknown_import')
);

-- ════════════════════════════════════════════════════════════
-- 3. Relax leads.quality CHECK — allow Excel Client Quality bands
--    (poor 0-0.2, normal 0.4-0.6, good 0.7-0.9; pending for blank)
-- ════════════════════════════════════════════════════════════
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_quality_check;
ALTER TABLE leads ADD CONSTRAINT leads_quality_check CHECK (
  quality IN ('pending','valid','job_seeker','fake','duplicate',
              'poor','normal','good')
);
