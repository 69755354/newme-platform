-- 20260624000004_add_contracts_approval_status.sql
-- P0 hotfix: contracts table missing approval_status column that trg_lead_won requires
-- Without this column, the Won trigger transaction rolls back entirely
-- (contract + installment_plans + projects + customer + business_event all lost)
ALTER TABLE public.contracts
ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'none';
