-- Add only the website CAPI delivery event; retain every existing event type.
-- NOT VALID preserves the existing posture and still checks all new writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE ONLY public.business_events IN ACCESS EXCLUSIVE MODE;
DO $capi_event_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.business_events'::regclass AND conname='chk_event_type'
      AND contype='c' AND NOT convalidated
      AND encode(sha256(convert_to(pg_get_constraintdef(oid),'UTF8')),'hex')
        IN ('dfd24c8549869aa0dbdd03a919f6e79a623c095d1b5be8664b4ac5d02adc974e', 'b148b0597bde5c74974176f275ace685d50c888e3885e25cc8fa1408e48a8682')
  ) THEN
    RAISE EXCEPTION 'CAPI event constraint precondition mismatch' USING ERRCODE='23514';
  END IF;
END
$capi_event_guard$;
ALTER TABLE ONLY public.business_events
  DROP CONSTRAINT chk_event_type,
  ADD CONSTRAINT chk_event_type CHECK (event_type = ANY (ARRAY['stage_change'::text, 'lead_stale_detected'::text, 'transfer'::text, 'quotation_sent'::text, 'quotation_accepted'::text, 'quotation_rejected'::text, 'won'::text, 'lost'::text, 'contract_activated'::text, 'contract_completed'::text, 'payment_recorded'::text, 'owner_change'::text, 'quality_checked'::text, 'project_info_updated'::text, 'note_added'::text, 'probability_changed'::text, 'status_changed'::text, 'lost_reason_set'::text, 'followup_scheduled'::text, 'leads_archived'::text, 'meta_capi_lead_delivery'::text])) NOT VALID;
