-- Auto-derive lead_status from last_contact_date
-- 2026-06-04
CREATE OR REPLACE FUNCTION derive_lead_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Don't auto-change for won/lost
  IF NEW.stage IN ('won','lost') THEN
    RETURN NEW;
  END IF;
  -- Only auto-set if lead_status is not explicitly set by user
  -- (Check metadata.lead_status_manual if column exists)
  BEGIN
    IF NEW.metadata->>'lead_status_manual' = 'true' THEN
      RETURN NEW;
    END IF;
  EXCEPTION WHEN undefined_column THEN
    -- metadata column doesn't exist, skip this check
  END;
  -- Derive from last_contact_date (fallback to updated_at)
  IF NEW.last_contact_date IS NULL THEN
    NEW.lead_status := 'dormant';
  ELSIF NEW.last_contact_date >= (CURRENT_DATE - INTERVAL '7 days') THEN
    NEW.lead_status := 'hot';
  ELSIF NEW.last_contact_date >= (CURRENT_DATE - INTERVAL '14 days') THEN
    NEW.lead_status := 'warm';
  ELSIF NEW.last_contact_date >= (CURRENT_DATE - INTERVAL '30 days') THEN
    NEW.lead_status := 'cold';
  ELSE
    NEW.lead_status := 'dormant';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop old trigger if exists
DROP TRIGGER IF EXISTS trg_derive_lead_status ON leads;
CREATE TRIGGER trg_derive_lead_status
  BEFORE INSERT OR UPDATE OF last_contact_date, stage ON leads
  FOR EACH ROW EXECUTE FUNCTION derive_lead_status();

-- Backfill existing leads (one-time) — skip metadata check if column doesn't exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='metadata') THEN
    UPDATE leads
    SET lead_status = CASE
      WHEN stage IN ('won','lost') THEN lead_status
      WHEN last_contact_date >= (CURRENT_DATE - INTERVAL '7 days') THEN 'hot'
      WHEN last_contact_date >= (CURRENT_DATE - INTERVAL '14 days') THEN 'warm'
      WHEN last_contact_date >= (CURRENT_DATE - INTERVAL '30 days') THEN 'cold'
      ELSE 'dormant'
    END
    WHERE lead_status IS NULL OR metadata->>'lead_status_manual' != 'true';
  ELSE
    UPDATE leads
    SET lead_status = CASE
      WHEN stage IN ('won','lost') THEN lead_status
      WHEN last_contact_date >= (CURRENT_DATE - INTERVAL '7 days') THEN 'hot'
      WHEN last_contact_date >= (CURRENT_DATE - INTERVAL '14 days') THEN 'warm'
      WHEN last_contact_date >= (CURRENT_DATE - INTERVAL '30 days') THEN 'cold'
      ELSE 'dormant'
    END
    WHERE lead_status IS NULL;
  END IF;
END $$;
