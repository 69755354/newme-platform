-- F-09 · P1 (LATENT, escalates to P0 on first real contract)
-- Money subsystem has no data-layer authorization — PHASE 1.
--
-- Phase 1 covers the two legs that are verifiable and safe to land now. The
-- SECURITY DEFINER body rewrite is deliberately NOT here: each function body is
-- 2.4-3.0 KB and converting it requires line-by-line review, so it is tracked
-- separately rather than guessed at.
--
-- Leg 1 — EXECUTE was granted to anon AND PUBLIC (live proacl showed
-- `=X/postgres` and `anon=X/postgres`) on functions that take the actor as a
-- PARAMETER (p_confirmer_id / p_approver_id / p_allocated_by) instead of reading
-- auth.uid(). Anonymous execution of a cash-confirmation routine has no
-- legitimate caller.
--
-- Leg 2 — policy_payments_update_sales and policy_contracts_update_sales both
-- have with_check = NULL, so Postgres reuses USING for the new row. That
-- constrains only OWNERSHIP, never `confirmed`, `amount`, `confirmed_by` or
-- `status`. Rather than patch the predicates, remove the primitive: revoke
-- direct DML so PostgREST cannot reach these tables at all.
--
-- Verified safe before writing (2026-08-11): the browser RLS client writes only
-- `quotations` directly (quote-calculator.tsx:131, quote-wizard.tsx:225,
-- quotes-client.tsx:232,340). Every contracts/payments write goes through
-- /api/* routes on service_role, which is unaffected by these grants. All five
-- tables below currently hold 0 rows, so there is no data to migrate.
--
-- `quotations` is intentionally left writable — moving it behind an API route is
-- an application change, not a grant change, and is tracked separately.

begin;

-- Leg 1: no anonymous or PUBLIC execution of money routines.
revoke execute on function public.confirm_payment(uuid, uuid)          from anon, public;
revoke execute on function public.approve_contract(uuid, uuid, text, text) from anon, public;
revoke execute on function public.allocate_payment(uuid, jsonb, uuid)  from anon, public;

-- Leg 2: reads stay, direct mutation goes. SELECT is untouched so every
-- existing dashboard/report query keeps working.
revoke insert, update, delete on public.contracts           from authenticated;
revoke insert, update, delete on public.payments            from authenticated;
revoke insert, update, delete on public.contract_approvals  from authenticated;
revoke insert, update, delete on public.installment_plans   from authenticated;
revoke insert, update, delete on public.payment_allocations from authenticated;

commit;
