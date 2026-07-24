-- Restore schema objects already consumed by the application but absent from
-- the reproducible migration chain. All views run with the caller's RLS.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS expected_close_date DATE,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE OR REPLACE VIEW public.v_lead_trace
WITH (security_invoker = true) AS
SELECT
  l.id AS lead_id,
  l.customer_name,
  l.stage,
  l.quotation_value,
  q.id AS quotation_id,
  q.total_amount AS quotation_price,
  q.status AS quotation_status,
  c.id AS contract_id,
  c.contract_no,
  c.contract_amount,
  c.status AS contract_status,
  ip.id AS installment_id,
  ip.seq,
  ip.amount AS installment_amount,
  ip.due_date,
  ip.status AS installment_status,
  pay.id AS payment_id,
  pay.amount AS payment_amount,
  pay.payment_date,
  pay.confirmed,
  project.id AS project_id,
  project.name AS project_name,
  project.phase AS project_phase,
  project.status AS project_status
FROM public.leads AS l
LEFT JOIN LATERAL (
  SELECT quotation.id, quotation.total_amount, quotation.status
  FROM public.quotations AS quotation
  WHERE quotation.lead_id = l.id
  ORDER BY quotation.updated_at DESC NULLS LAST, quotation.created_at DESC NULLS LAST
  LIMIT 1
) AS q ON true
LEFT JOIN LATERAL (
  SELECT contract.id, contract.contract_no, contract.contract_amount, contract.status
  FROM public.contracts AS contract
  WHERE contract.lead_id = l.id
  ORDER BY contract.updated_at DESC NULLS LAST, contract.created_at DESC NULLS LAST
  LIMIT 1
) AS c ON true
LEFT JOIN LATERAL (
  SELECT installment.id, installment.seq, installment.amount,
    installment.due_date, installment.status
  FROM public.installment_plans AS installment
  WHERE installment.contract_id = c.id
  ORDER BY (installment.status = 'paid'), installment.due_date NULLS LAST, installment.seq
  LIMIT 1
) AS ip ON true
LEFT JOIN LATERAL (
  SELECT payment.id, payment.amount, payment.payment_date, payment.confirmed
  FROM public.payments AS payment
  WHERE payment.contract_id = c.id
  ORDER BY payment.payment_date DESC NULLS LAST, payment.created_at DESC NULLS LAST
  LIMIT 1
) AS pay ON true
LEFT JOIN LATERAL (
  SELECT candidate.id, candidate.name, candidate.phase, candidate.status
  FROM public.projects AS candidate
  WHERE candidate.lead_id = l.id
    OR (c.id IS NOT NULL AND candidate.contract_id = c.id)
  ORDER BY candidate.updated_at DESC NULLS LAST, candidate.created_at DESC NULLS LAST
  LIMIT 1
) AS project ON true;

CREATE OR REPLACE VIEW public.v_risk_pool
WITH (security_invoker = true) AS
SELECT
  l.id,
  l.customer_name,
  l.phone,
  l.stage,
  l.assigned_to,
  l.next_action,
  l.next_followup_date,
  GREATEST(CURRENT_DATE - l.next_followup_date, 0) AS days_overdue,
  CASE
    WHEN l.next_followup_date < CURRENT_DATE - 7 THEN 'high'
    WHEN l.next_followup_date < CURRENT_DATE - 3 THEN 'medium'
    ELSE 'low'
  END AS risk_level
FROM public.leads AS l
WHERE l.next_followup_date < CURRENT_DATE
  AND l.stage NOT IN ('won', 'lost')
  AND NOT COALESCE(l.archived, false);

REVOKE ALL ON TABLE public.v_lead_trace FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.v_risk_pool FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.v_lead_trace TO authenticated, service_role;
GRANT SELECT ON TABLE public.v_risk_pool TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
