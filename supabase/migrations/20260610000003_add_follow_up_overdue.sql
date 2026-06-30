-- Add follow_up_overdue notification type
-- 2026-06-10

-- Drop existing constraint and re-add with new type
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
  'kpi_target_set',
  'followup_reminder',
  'follow_up_overdue',
  'team_member_added'
));
