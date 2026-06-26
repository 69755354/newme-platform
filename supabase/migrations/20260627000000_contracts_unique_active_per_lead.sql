-- Migration: Add partial unique index to prevent duplicate active contracts per lead
-- DB-level guarantee: one lead = one active contract at most
-- Archived/cancelled/terminated contracts don't block re-sign

CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_one_active_per_lead 
ON public.contracts (lead_id) 
WHERE status NOT IN ('archived', 'cancelled', 'terminated');
