-- Atomic lead reassignment records a dedicated transfer activity.
ALTER TABLE public.activities
  DROP CONSTRAINT IF EXISTS activities_type_check;

ALTER TABLE public.activities
  ADD CONSTRAINT activities_type_check CHECK (
    type IN ('call', 'whatsapp', 'wechat', 'email', 'meeting', 'sms', 'note', 'task',
             'quote_sent', 'follow_up', 'stage_change', 'quality_change', 'contract_signed',
             'payment_received', 'site_visit', 'cad_review', 'transfer')
);
