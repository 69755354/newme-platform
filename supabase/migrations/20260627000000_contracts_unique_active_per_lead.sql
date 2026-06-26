-- ⚠️ PENDING OPS DEBT — NOT APPLIED
-- Reason: Supabase PAT (sbp_bbaf...) lacks database:query scope
-- Risk: Extremely low probability concurrent duplicate contract creation
-- Mitigation: L1 frontend disabled + L2 API SELECT check → 409
-- Resolution: Apply this migration when database:query scope is available
--              Then verify: concurrent dual POST → only 1 succeeds

CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_one_active_per_lead 
ON public.contracts (lead_id) 
WHERE status NOT IN ('archived', 'cancelled', 'terminated');
