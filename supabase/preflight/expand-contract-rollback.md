# Expand / contract deployment and rollback procedure — L0 money authorization

Status: **NOT PERFORMED.** No step in this document has been run against
production by the branch that ships it. It is the procedure the deployment has to
follow, written before the deployment, so that whoever performs it can be checked
against something other than their own summary.

The branch containing this file is code-only. It does not apply a migration, does
not deploy an application build, does not change an Auth identity and does not
restart a service. Every step marked **[AUTHORISED ACTION]** requires explicit,
separate authorisation and is out of scope until then.

`tests/release/expand-contract-rollback-contract.test.mjs` holds this document to
the SQL: the migration set, the release-mode values, the status graph and the RPC
signatures below are all parsed out of the migrations and compared. If a
migration changes and this document does not, that test fails.

Related: [`f02-credential-cutover.md`](./f02-credential-cutover.md) covers the
Auth identity that the same release deactivates. The two are independent —
neither is a precondition of the other — but both must be finished before the
release is described as complete.

---

## 1 · Why this release is in two pushes

`20260814000000_l0_round3_authorization_and_integrity.sql` makes the money tables
writable only through the SECURITY DEFINER routines. The release that is in
production today (`f37c203`, PR base `81956f2`) does not use those routines for
everything: it creates contracts, installment plans, approvals and payments with
direct PostgREST writes as `authenticated`. If the write guards took effect at
the moment the migration applied, then between the migration and a successful
application deploy — and after any application-only rollback — the previous
release would be unable to write money rows at all.

So the guards are gated on one row:

* `public.money_release_mode` is a singleton table (`id = 'only'`) seeded by
  `20260814000000` with `direct_write_mode = 'compat'`.
* `public.money_direct_write_mode()` reads it, is SECURITY DEFINER (the table is
  granted to `service_role` only), and **fails closed to `'strict'`** if the row
  or the table is missing.
* `public.money_direct_write_is_blocked()` is SECURITY INVOKER on purpose: it has
  to see the *calling* role, because the guards must stand down for
  `service_role` and for the migration itself and must not for a browser session.
* `20260815000000_money_direct_write_contract_phase.sql` flips the row to
  `'strict'`. That is the whole contract phase.
* `rollback_money_direct_write_contract_phase.sql` puts it back to `'compat'`.
  Its name deliberately does not match `^[0-9]{14}_`, so the Supabase CLI never
  applies it; an operator runs it by hand.

The compatibility window is therefore a **deployment procedure, not a property of
the SQL**. `supabase db push` applies every pending migration in one run, so
pushing both files together collapses the window to zero. §4 is the ordering that
keeps it open.

### The two pushes

Expand phase — apply these ten, in this order (they are the pending set on this
branch, and `scripts/replay-migrations.sh` applies exactly them plus the contract
phase):

```expand
20260806000000_baseline_undeclared_production_objects.sql
20260811100000_f08_audit_logs_actor_identity.sql
20260811100100_f06_profiles_revocation_columns.sql
20260811100200_f10_meta_tokens_drop_permissive_select.sql
20260811100300_f02_remove_default_credential_admin.sql
20260811100400_f09_money_authorization_phase1.sql
20260811100500_kpi_targets_atomic_replace.sql
20260812000000_money_actor_identity_and_atomicity.sql
20260813000000_session_revocation_boundary.sql
20260814000000_l0_round3_authorization_and_integrity.sql
```

Contract phase — one file, pushed only after §4 step 6 passes:

```contract
20260815000000_money_direct_write_contract_phase.sql
```

---

## 2 · Compatibility matrix

Five states. **P** = the previous release (`f37c203` / `81956f2`) that is serving
production now. **C** = the candidate release on this branch.

| State | Schema | `direct_write_mode` | P works? | C works? |
| --- | --- | --- | --- | --- |
| 1 · today | base, stamp `20260805202917` | table does not exist | yes | **no** — the RPCs it calls do not all exist yet |
| 2 · expand applied | + the ten files | `compat` | yes, with the four deliberate exceptions in §3 | yes |
| 3 · candidate deployed | + the ten files | `compat` | yes (this is the overlap window) | yes |
| 4 · contract applied | + all eleven | `strict` | **no** — its direct money writes are refused | yes |
| 5 · companion run | + all eleven | `compat` | yes, as in state 2 | yes |

State 3 is the rollback boundary: both releases work against the same schema, so
the application can be rolled back without touching the database. State 5 is how
state 4 is returned to state 3.

### Writer-by-writer, verified against the two revisions

Direct `authenticated` money writes in the previous release — every one of these
is refused in state 4 and accepted in states 2, 3 and 5:

| Previous-release call site | Table | Statement |
| --- | --- | --- |
| `src/app/api/contracts/route.ts:83` | `contracts` | INSERT |
| `src/app/api/contracts/route.ts:144` | `installment_plans` | INSERT |
| `src/app/api/contracts/route.ts:169` | `contract_approvals` | INSERT |
| `src/app/api/payments/route.ts:71` | `payments` | INSERT |
| `src/app/api/quotations/[id]/convert/route.ts:101` | `contracts` | INSERT |
| `src/app/api/quotations/[id]/convert/route.ts:147` | `installment_plans` | INSERT |
| `src/app/api/quotations/[id]/convert/route.ts:164` | `contract_approvals` | INSERT |
| `src/app/api/contracts/[id]/revoke/route.ts:92` | `contracts` | UPDATE `status` |

Not affected in any state, and checked rather than assumed:

* `src/app/api/contracts/route.ts:355` (PATCH) sets only `first_payment_status`
  and `first_payment_due_date`. `trg_guard_contracts_write` covers status,
  amount, number, ownership and dates; these two columns are not in it, and the
  transition trigger is `before update of status`, which this statement does not
  set.
* `src/app/api/contracts/[id]/confirm-upload/route.ts:101` sets `file_url` and
  `file_metadata` only.
* `src/app/api/contracts/[id]/approve/route.ts` already calls
  `approve_contract`, and `src/app/api/payments/[id]/confirm/route.ts` already
  calls `confirm_payment` — both with the same signatures the migrations keep
  (§3, "signatures are preserved").
* `src/app/api/cron/check-overdue-installments/route.ts`,
  `src/app/api/users/[id]/route.ts` (contract reassignment) and
  `src/app/api/meta/oauth-callback/route.ts` use `supabaseAdmin` /
  `getSupabaseAdmin()`, i.e. `service_role`. `money_write_is_direct()` is
  `current_user in ('authenticated', 'anon')`, so every guard stands down for
  them, in every state.
* `src/proxy.ts:264` writes `profiles.last_active_at`. `20260811100100` revokes
  UPDATE on `profiles` from `authenticated` and re-grants exactly this column, so
  it keeps working. No other `authenticated` profile write exists in the previous
  release (`change-password`, `users/[id]/password`, `users/[id]`, `users` and
  `dev/setup` all write profiles through `service_role`).

---

## 3 · What the expand phase changes for the previous release anyway

Four things take effect the moment the expand phase applies, before any
application deploy, and are **not** gated on `direct_write_mode`. They are listed
here because "backwards compatible" must not be claimed more broadly than it is
true.

1. **The contract status graph is enforced for every writer.**
   `trg_guard_contract_transition` on `public.contracts` consults
   `public.contract_transition_is_allowed(from, to)` for any UPDATE that sets
   `status`, and raises `22023` otherwise. It applies to `service_role` too. The
   previous release's revoke route computes
   `newStatus = supersede ? "superseded" : "revoking"` and refuses only the
   `superseded` and `revoked` sources, so under the graph its revocation from
   `draft`, `pending_admin`, `pending_ceo`, `rejected`, `completed` or
   `terminated` now fails. That is finding P1-8 — `completed -> revoking` was
   reproduced against the floor — and closing it for the previous release as well
   is deliberate.

   The permitted pairs, which are the whole graph:

   ```graph
   draft -> pending_admin
   rejected -> pending_admin
   rejected -> draft
   pending_admin -> pending_ceo
   pending_admin -> rejected
   pending_ceo -> approved
   pending_ceo -> rejected
   approved -> active
   active -> completed
   active -> suspended
   suspended -> active
   approved -> terminated
   active -> terminated
   suspended -> terminated
   revoking -> terminated
   approved -> revoking
   active -> revoking
   suspended -> revoking
   approved -> superseded
   active -> superseded
   suspended -> superseded
   revoking -> superseded
   ```

   `completed`, `terminated` and `superseded` are terminal: no pair leaves them.

2. **The class-28 session boundary applies to both releases.**
   `trg_require_current_session` is a `BEFORE INSERT OR UPDATE OR DELETE ... FOR
   EACH STATEMENT` trigger on every ordinary table in `public`, and
   `require_current_session()` calls `assert_current_session()` only when
   `auth.uid() is not null` — so `service_role` and `psql` are unaffected, and a
   deactivated, banned, stale-token or password-change-owing end-user session is
   refused on both releases, including inside a SECURITY DEFINER routine where
   RLS does not reach. SQLSTATEs: `28001` no session, `28002` no profile, `28003`
   inactive, `28004` banned, `28005` stale token, `28006` password change
   required.

3. **DELETE on the five money tables is revoked from `authenticated` and
   `anon`.** Verified against `81956f2`: the previous release issues no DELETE on
   `contracts`, `payments`, `installment_plans`, `contract_approvals` or
   `payment_allocations` from any client. This was finding P1-2 — the guards
   covered INSERT and UPDATE only and a session could delete a confirmed payment
   — and it is unconditional in every state, including state 5.

4. **`dev@newme.ae` is deactivated** by `20260811100300`, so it cannot use either
   release. See `f02-credential-cutover.md`; the Auth identity itself stays open
   until that action is authorised, and F-02 stays open on TASKBOARD until then.

**Signatures are preserved.** The routines the previous release already calls keep
their exact argument lists, so its RPC calls continue to resolve:

```rpc
public.approve_contract(uuid, uuid, text, text)
public.confirm_payment(uuid, uuid)
public.allocate_payment(uuid, jsonb, uuid)
public.create_contract(jsonb)
public.convert_quotation_to_contract(uuid, jsonb)
```

What changed inside them is that the actor parameter is no longer trusted:
`money_actor()` binds the actor to the session's JWT subject and raises rather
than accepting a passed-in identity that is not the caller. The previous release
passes its own `user.id` at every call site, so this is not a compatibility
break for it — but a client that passed someone else's id would now be refused,
which is the point.

**No destructive DDL.** The expand set adds three nullable columns
(`payments.voided_at`, `payments.voided_by`, `payments.void_reason`) and drops no
column, table, view or routine the previous release reads. There is no new NOT
NULL and no new CHECK constraint on an existing money column, so the previous
release's INSERTs remain shape-compatible.

---

## 4 · The procedure

Read §5 before starting: the point of no return is step 7, not step 8.

1. **Preconditions.** All of the following must hold, and none of them is a
   judgement call:
   * PR #397 has passed CI at the exact head being deployed, and the
     `Migration replay and release contracts` job is green on that head.
   * `node scripts/verify-remote-migration-history.mjs` reports no unexplained
     drift against production's `supabase_migrations.schema_migrations`.
   * `bash scripts/check-taskboard.sh` shows no ❌ item that the deployment
     depends on.
   * A verified point-in-time recovery target exists for the production project,
     and its timestamp is recorded next to this checklist.
2. **[AUTHORISED ACTION] Apply the expand phase.** Push the ten files in §1.
   `20260815000000` must **not** be in the pending set for this push — check
   before, not after.
3. **Verify state 2, read-only.** §6.1. If `direct_write_mode` is anything other
   than `compat`, stop: the contract phase has been applied early and the
   previous release is already broken. Run the companion (§5) before continuing.
4. **Observe the previous release.** It is still the deployed application. Watch
   its money paths — contract creation, quotation conversion, payment recording,
   approval — for a period agreed in advance. Evidence is aggregate: request
   counts and error rates by route, and `select count(*)` deltas on the five
   money tables. No row contents.
5. **[AUTHORISED ACTION] Deploy the candidate release.** Immutable release
   directory, `infra/systemd/newme-deploy.sh`, against the release-final
   `workflow_dispatch` run whose jobs `infra/release/required-jobs.json` names.
6. **Verify state 3, read-only.** §6.2, plus one real transaction per money path
   performed by a human on a test contract through the candidate UI. The
   application must be the writer; a `psql` insert proves nothing about the
   candidate. The compatibility window is open for as long as this takes, so
   there is no time pressure on this step.
7. **[AUTHORISED ACTION] Apply the contract phase.** Push
   `20260815000000_money_direct_write_contract_phase.sql`. **After this step an
   application-only rollback no longer works** (§5).
8. **Verify state 4, read-only.** §6.3.
9. **Record it.** TASKBOARD rows for the migration application and the deployment
   move to ✅ only with the output of §6.1–§6.3 attached, and only for the steps
   that actually ran. The release is not "complete" while any row is ❌.

---

## 5 · Rollback

| Failing at | Recovery | Database action |
| --- | --- | --- |
| step 2 (expand push) | the push is transactional per file; a file that fails leaves the earlier ones applied | re-run after fixing, or restore to the recorded PITR target |
| step 4 (previous release misbehaves in state 2) | none needed for the money tables — the mode is already `compat`. If §3 item 1 or 2 is the cause, it is a deliberate change, so the decision is roll forward or PITR | none, or PITR |
| step 6 (candidate misbehaves in state 3) | redeploy the previous release. This is the reason the window exists | **none** |
| step 8 (candidate misbehaves in state 4) | run `rollback_money_direct_write_contract_phase.sql`, then redeploy the previous release | one UPDATE on one row |

**The point of no return is step 7, and it is narrow.** After it, an
application-only rollback leaves the previous release unable to write money rows,
so the rollback is two actions and not one: run the companion first, then
redeploy. If the companion cannot be run, the only remaining option is PITR.

What the companion does **not** do, deliberately: it touches exactly one row in
one table. It does not re-enable the published credential, does not re-grant
`meta_tokens` or `profiles` UPDATE, does not recreate the `with_check (true)`
audit-insert policy, and does not remove the session boundary, the transition
graph, the DELETE revocation or the plan locking in `allocate_payment()`. The
reviewed round-2 companion did roll the security fixes back along with the
schema, and the gate was green because SQL that opens a hole runs as cleanly as
SQL that closes one. `supabase/replay/20_assert_post_rollback.sql` asserts both
halves — that the previous release can write again, and that each fix is still
in place — at the behaviour level, after the companion runs.

The honest cost, stated rather than buried: while the mode is `compat` a browser
session can write `contracts.status` and `payments.confirmed` directly. That is
the posture production has today. Reverting to it is a return to the status quo,
not a new hole.

`20260814000000` is NO_ROLLBACK on purpose. Reverting the session boundary or the
actor binding would restore the P0 findings, so there is no companion for it; the
recovery for a problem in the expand phase is roll forward or PITR.

---

## 6 · Read-only verification

Every query here is catalogue, policy, privilege or aggregate-count only. None
selects a business row, an email or a token. Run them with the service role.

### 6.1 · After the expand phase (expect state 2)

```sql
-- 1. the mode, which is the whole gate
select id, direct_write_mode, changed_at from public.money_release_mode;
-- expect exactly one row: ('only', 'compat', <the push time>)

-- 2. the contract phase is NOT applied
select count(*) from supabase_migrations.schema_migrations
 where version = '20260815000000';
-- expect 0

-- 3. the expand set is applied, and is the newest
select version from supabase_migrations.schema_migrations
 order by version desc limit 3;
-- expect 20260814000000 first

-- 4. the gate function fails closed and reads the calling role
select p.proname, p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('money_direct_write_mode', 'money_direct_write_is_blocked');
-- expect money_direct_write_mode  = true  (definer, reads the private table)
--        money_direct_write_is_blocked = false (invoker, must see current_user)

-- 5. the guards exist and are enabled
select c.relname, t.tgname, t.tgenabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
   and t.tgname like 'trg_guard_%'
 order by 1, 2;

-- 6. the session boundary covers every ordinary table in public
select count(*) as tables,
       count(*) filter (where has_boundary) as covered
  from (
    select exists (
             select 1 from pg_trigger t
              where t.tgrelid = c.oid
                and t.tgname = 'trg_require_current_session'
                and not t.tgisinternal and t.tgenabled = 'O'
           ) as has_boundary
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relispartition
  ) s;
-- expect tables = covered

-- 7. DELETE stays revoked (§3 item 3)
select t.tbl,
       has_table_privilege('authenticated', t.tbl, 'delete') as authenticated_delete
  from (values ('public.contracts'), ('public.payments'),
               ('public.installment_plans'), ('public.contract_approvals'),
               ('public.payment_allocations')) as t(tbl);
-- expect false for all five

-- 8. no money routine is executable by PUBLIC, by grant or by a null ACL
select p.proname, p.proacl is null as acl_is_null
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('money_actor', 'create_contract', 'approve_contract',
                     'confirm_payment', 'allocate_payment', 'void_payment',
                     'set_contract_status', 'revoke_contract',
                     'convert_quotation_to_contract')
   and (p.proacl is null
        or exists (select 1 from aclexplode(p.proacl) a
                    where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
-- expect zero rows
```

### 6.2 · After the candidate deploy (expect state 3)

```sql
-- the mode has not moved
select direct_write_mode from public.money_release_mode where id = 'only';
-- expect compat

-- the candidate's writes are landing through the routines: aggregate only
select count(*) as contracts_last_hour
  from public.contracts where created_at > now() - interval '1 hour';
select count(*) as payments_last_hour
  from public.payments where created_at > now() - interval '1 hour';
select count(*) as approvals_last_hour
  from public.contract_approvals where created_at > now() - interval '1 hour';

-- and the audit trail is being attributed to real actors, counted not read
select count(*) as audit_rows_last_hour, count(distinct actor_id) as distinct_actors
  from public.audit_logs where created_at > now() - interval '1 hour';
```

Plus, outside SQL: one contract creation, one quotation conversion, one payment
record, one confirmation, one allocation and one approval step, performed through
the candidate UI by a person, each returning success in the application. Record
the HTTP status and the route, not the payload.

### 6.3 · After the contract phase (expect state 4)

```sql
select direct_write_mode, reason from public.money_release_mode where id = 'only';
-- expect strict

select count(*) from supabase_migrations.schema_migrations
 where version = '20260815000000';
-- expect 1
```

Then re-run 6.1 queries 4–8: the contract phase changes one row and must change
nothing else. Do **not** verify strict mode by attempting a direct write from a
production browser session — the replay harness already proves the refusal
(`money-direct-*-refused` in
`supabase/replay/10_assert_release_contracts.sql`), and a failed write against
production data is not a test, it is an incident.

---

## 7 · What stays open until this is performed

* The TASKBOARD row for applying the L0 migrations to production.
* The TASKBOARD row for deploying the candidate release.
* The TASKBOARD row for the contract phase and its post-checks.
* F-02, which needs the separate Auth action in `f02-credential-cutover.md`.

None of these may be marked ✅ from a code round. This document plus the replay
gates are evidence that the procedure is defined and that the SQL behaves as
described in a local database — not that anything has been applied to production.
