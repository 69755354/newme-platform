-- Add first_payment tracking fields to contracts
-- 2026-06-10

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS first_payment_status TEXT NOT NULL DEFAULT 'unpaid'
  CHECK (first_payment_status IN ('unpaid', 'partial', 'paid'));
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS first_payment_due_date DATE;

-- Add first_payment_reminder to notification types
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'lead_created',
  'lead_assigned',
  'lead_stage_change',
  'lead_stage_changed',
  'quote_created',
  'contract_created',
  'contract_signed',
  'payment_due',
  'payment_overdue',
  'payment_received',
  'first_payment_reminder',
  'kpi_target_set',
  'followup_reminder',
  'team_member_added'
));
