-- F-09 · P1 (LATENT, escalates to P0 on first real contract)
-- Money subsystem has no data-layer authorization — PHASE 1.
--
-- REVISED 2026-08-11 after independent review. The previous revision of this
-- file would have taken the money subsystem down on apply. Both of its legs were
-- wrong, and the reasoning that produced them is recorded here so Phase 2 does
-- not repeat it.
--
-- Leg 1 (kept, corrected). EXECUTE was granted to PUBLIC and to anon (live
-- proacl showed `=X/postgres` and `anon=X/postgres`) on functions that take the
-- actor as a PARAMETER (p_confirmer_id / p_approver_id / p_allocated_by) rather
-- than reading auth.uid(). Anonymous execution of a cash-confirmation routine
-- has no legitimate caller.
--   The bug: `revoke execute ... from anon, public` removes the PUBLIC grant,
--   and `authenticated` held NO grant of its own — it could only execute these
--   functions *through* PUBLIC. Revoking PUBLIC therefore revoked the six
--   legitimate call sites too:
--     src/app/actions/contracts.ts:66                    approve_contract
--     src/app/actions/payments.ts:111                    confirm_payment
--     src/app/actions/payments.ts:181                    allocate_payment
--     src/app/api/contracts/[id]/approve/route.ts:130    approve_contract
--     src/app/api/payments/[id]/allocate/route.ts:97     allocate_payment
--     src/app/api/payments/[id]/confirm/route.ts:65      confirm_payment
--   all of which run on the CALLER's client (role `authenticated`), so every
--   approval and cash confirmation would have failed with 42501.
--   The fix: drop the PUBLIC grant *and* issue the explicit role grants that
--   should have been there all along. anon ends up with nothing; the two roles
--   with a real caller keep exactly what they need.
--
-- Leg 2 (REMOVED). It revoked INSERT/UPDATE/DELETE on contracts, payments,
-- contract_approvals, installment_plans and payment_allocations from
-- `authenticated`, on the stated basis that "every contracts/payments write goes
-- through /api/* routes on service_role". That premise is false: an /api/* route
-- is not service_role. Routes built on
-- createServerSupabase(bearerToken, cookieHeader) use the publishable key plus
-- the caller's JWT, so they execute as `authenticated`. Ten such write sites
-- exist today:
--     src/app/api/contracts/route.ts:81                      insert contracts
--     src/app/api/contracts/route.ts:142                     insert installment_plans
--     src/app/api/contracts/route.ts:167                     insert contract_approvals
--     src/app/api/contracts/route.ts:353                     update contracts
--     src/app/api/contracts/[id]/confirm-upload/route.ts:99  update contracts
--     src/app/api/contracts/[id]/revoke/route.ts:90          update contracts
--     src/app/api/payments/route.ts:69                       insert payments
--     src/app/api/quotations/[id]/convert/route.ts:99        insert contracts
--     src/app/api/quotations/[id]/convert/route.ts:145       insert installment_plans
--     src/app/api/quotations/[id]/convert/route.ts:164       insert contract_approvals
-- The revoke would have broken contract creation, payment creation, quotation
-- conversion, contract upload confirmation and contract revocation — the entire
-- money path — with nothing in CI to catch it, because no CI job exercises these
-- grants.
--
-- The finding Leg 2 was aimed at is REAL and still open:
-- policy_payments_update_sales and policy_contracts_update_sales both have
-- with_check = NULL, so Postgres reuses USING for the new row, constraining only
-- OWNERSHIP and never `confirmed`, `amount`, `confirmed_by` or `status`. Closing
-- it means either tightening those WITH CHECK predicates or moving the ten call
-- sites onto service_role / SECURITY DEFINER functions. Both are application
-- changes, tracked as PROD-F09-MONEY-AUTHORIZATION-PHASE2 in TASKBOARD.md. A
-- grant revoke is not a substitute for either and must not land before the call
-- sites move.
--
-- Guarded by tests/security/money-grant-coupling.test.mjs, which fails if any
-- migration revokes DML on these tables while a route still writes them with a
-- caller-scoped client.
--
-- Rollback: supabase/migrations/rollback_l0_20260811.sql

begin;

-- No anonymous or PUBLIC execution of money routines. The roles that have real
-- callers are granted explicitly so they no longer depend on PUBLIC.
revoke execute on function public.confirm_payment(uuid, uuid)               from public, anon;
revoke execute on function public.approve_contract(uuid, uuid, text, text)  from public, anon;
revoke execute on function public.allocate_payment(uuid, jsonb, uuid)       from public, anon;

grant execute on function public.confirm_payment(uuid, uuid)               to authenticated, service_role;
grant execute on function public.approve_contract(uuid, uuid, text, text)  to authenticated, service_role;
grant execute on function public.allocate_payment(uuid, jsonb, uuid)       to authenticated, service_role;

commit;
