-- Fix notification type constraint to include missing types
-- Migration: 20260610000002_fix_notification_types.sql
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check 
  CHECK (type IN (
    'lead_created', 'lead_assigned', 'lead_stage_change', 'lead_stage_changed',
    'quote_created', 'contract_created', 'contract_signed',
    'payment_due', 'payment_overdue', 'payment_received',
    'kpi_target_set', 'followup_reminder', 'team_member_added',
    'follow_up_overdue', 'first_payment_reminder'
  ));
