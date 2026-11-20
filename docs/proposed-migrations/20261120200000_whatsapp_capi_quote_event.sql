-- NOT YET IN supabase/migrations: register it in the release manifest (gate) first, then move it. Until applied, the WhatsApp quote event is skipped, nothing else changes.
-- NO_ROLLBACK: widens an allow-list check on a service-only outbox table; no row changes. Needs a gated database operation.
-- Quotation-with-amount feedback to Meta for click-to-WhatsApp leads is sent as InitiateCheckout (valued).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.whatsapp_capi_events DROP CONSTRAINT IF EXISTS whatsapp_capi_events_event_name_check;
ALTER TABLE public.whatsapp_capi_events ADD CONSTRAINT whatsapp_capi_events_event_name_check
  CHECK (event_name IN ('LeadSubmitted', 'QualifiedLead', 'InitiateCheckout', 'Purchase'));
