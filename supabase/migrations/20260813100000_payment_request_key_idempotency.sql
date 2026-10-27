-- Payment idempotency: the key a recording request carries, and the index that
-- makes a resubmission record one payment instead of two.
--
-- NO_ROLLBACK: the change is additive and nullable, and nothing that existed
-- before it reads or writes payments.request_key, so rolling the release back
-- needs no schema change — the previous code simply stops sending the column.
-- A companion that dropped it would destroy the recorded keys that make
-- already-recorded payments recognisable as duplicates of each other, which is
-- a worse position than either side of the rollback.
--
-- WHY THIS EXISTS
--
-- The payments dashboard recorded a payment by calling a server action that did
-- `insert into payments (...)` with no idempotency key at all. Reproduced on an
-- isolated PostgreSQL 17 against this branch's migrations, acting as the sales
-- identity that owns the fixture contract: submitting the same form twice
-- produced `sqlstate=00000 rows=2` — two payments, one intent, real money
-- counted twice. Nothing in the schema could have prevented it, because nothing
-- in the schema could tell the two attempts apart.
--
-- WHAT THE UNIQUE INDEX DOES AND DOES NOT DECIDE
--
-- `(created_by, request_key)` is unique, so the second attempt under one key
-- raises 23505 instead of inserting. It is scoped to the creator on purpose: a
-- key minted by one user's client must not be able to collide with, or probe
-- for, another user's payment.
--
-- The index cannot tell an honest retry from a reused key. Same isolated run,
-- same fixture: retrying the identical payload under one key raised
-- `23505 ... idx_payments_request_key` and left `rows=1`; sending a DIFFERENT
-- amount under that same key raised the SAME `23505`, with the stored amount
-- still `4321.00`. Both are one sqlstate, so the distinction has to be drawn
-- above the database, by comparing the incoming payment against the one already
-- recorded under that key. src/app/api/payments/route.ts draws it: equal
-- payload is answered with the first payment (200), a different payload under a
-- spent key is refused (409). This file's job is only to make the collision
-- happen at all.
--
-- The column stays nullable here. Requiring it of every writer is a separate
-- change that belongs with the round-4 payment guard, and making it `not null`
-- now would fail against any payment already recorded in production.

alter table public.payments
  add column if not exists request_key uuid;

comment on column public.payments.request_key is
  'Idempotency key of the request that recorded this payment, minted once per '
  'recording intent by the caller. Unique per creator: a resubmitted or retried '
  'request records one payment. Null on payments recorded before this column '
  'existed.';

-- Partial, so the pre-existing rows with a null key do not collide with each
-- other. Dropped first rather than `if not exists`, so re-applying this file
-- converges on this definition instead of leaving an earlier one in place.
drop index if exists public.idx_payments_request_key;
create unique index idx_payments_request_key
  on public.payments (created_by, request_key)
  where request_key is not null;
