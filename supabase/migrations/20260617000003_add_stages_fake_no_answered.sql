-- Add "fake" and "no_answered" to leads stage check constraint
-- Also add stage_color to profiles for visual consistency

-- Drop existing check constraint
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_stage_check;

-- Re-add with new stages
ALTER TABLE leads ADD CONSTRAINT leads_stage_check
  CHECK (stage = ANY (ARRAY[
    'new'::text,
    'contacted'::text,
    'no_answered'::text,
    'requirement_confirmed'::text,
    'solution_submitted'::text,
    'quotation_submitted'::text,
    'negotiation'::text,
    'pending_decision'::text,
    'won'::text,
    'lost'::text,
    'fake'::text
  ]));
