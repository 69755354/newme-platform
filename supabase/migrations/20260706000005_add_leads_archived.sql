-- P0 hotfix follow-up: close the archive audit gap by widening
-- business_events.chk_event_type from 19 to 20 values.
-- Prerequisite: 20260706000004_audit_event_type_widening.sql.

BEGIN;

ALTER TABLE business_events DROP CONSTRAINT IF EXISTS chk_event_type;

ALTER TABLE business_events ADD CONSTRAINT chk_event_type
  CHECK (event_type IN (
    'stage_change','lead_stale_detected','transfer',
    'quotation_sent','quotation_accepted','quotation_rejected',
    'won','lost',
    'contract_activated','contract_completed',
    'payment_recorded',
    'owner_change','quality_checked','project_info_updated',
    'note_added','probability_changed','status_changed',
    'lost_reason_set','followup_scheduled',
    'leads_archived'
  )) NOT VALID;

NOTIFY pgrst, 'reload schema';

COMMIT;
