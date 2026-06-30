-- 20260624100000_add_default_next_action.sql
-- Fix: Add default for next_action so create lead works even if client doesn't send it

-- Set default for new leads
ALTER TABLE leads ALTER COLUMN next_action SET DEFAULT 'call';

-- Also ensure next_followup_date has a sensible default  
ALTER TABLE leads ALTER COLUMN next_followup_date SET DEFAULT (CURRENT_DATE + INTERVAL '1 day');

-- Update any existing NULLs (should be none but just in case)
UPDATE leads SET next_action = 'call' WHERE next_action IS NULL OR next_action = '';
UPDATE leads SET next_followup_date = CURRENT_DATE + INTERVAL '1 day' WHERE next_followup_date IS NULL;
