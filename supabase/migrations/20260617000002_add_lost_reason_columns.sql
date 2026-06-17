-- Fix: Lose button (stage=lost) fails with "Save failed"
-- Root cause: set_lost_reasons() BEFORE UPDATE trigger assigns
--   NEW.lost_reason_price := false
--   etc. for 7 boolean columns that did NOT exist in the database.
-- The missing migration caused the trigger to throw a column-not-found
-- error on every UPDATE that sets stage='lost'.
--
-- Diagnosis: lost_reason column existed but lost_reason_price,
--   lost_reason_competitor, lost_reason_no_budget,
--   lost_reason_project_cancelled, lost_reason_project_delayed,
--   lost_reason_no_response, lost_reason_other were all absent.
--
-- Symptoms:
--   - "Save failed" when clicking Lose on any lead detail page
--   - Regular stage changes, adding actions, and other saves work fine
--   - User sees no error detail (caught by client-side updateField)

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS lost_reason_price             BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS lost_reason_competitor        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS lost_reason_no_budget         BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS lost_reason_project_cancelled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS lost_reason_project_delayed   BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS lost_reason_no_response       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS lost_reason_other             BOOLEAN DEFAULT false;
