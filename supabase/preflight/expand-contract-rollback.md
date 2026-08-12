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
* `20260818000000_money_direct_write_contract_phase.sql` flips the row to
  `'strict'`. That is the whole contract phase.
* `rollback_money_direct_write_contract_phase.sql` puts it back to `'compat'`.
  Its name deliberately does not match `^[0-9]{14}_`, so the Supabase CLI never
  applies it; an operator runs it by hand.

The compatibility window is therefore a **deployment procedure, not a property of
the SQL**. `supabase db push` applies every pending migration in one run, so
pushing both files together collapses the window to zero. §4 is the ordering that
keeps it open, and `scripts/db-phase-push.mjs` is what executes it.

### The two pushes

Expand phase — apply these seventeen, in this order (they are the pending set on this
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
20260813100000_payment_request_key_idempotency.sql
20260814000000_l0_round3_authorization_and_integrity.sql
20260816000000_l0_round4_definer_entry_boundary.sql
20260817000000_l0_round4_money_and_business_integrity.sql
20260817120000_admin_reset_session_revocation.sql
20260817130000_b5_conversion_retry_idempotence.sql
20260817140000_l0_round4_installment_sequence_contiguity.sql
20260817150000_kpi_period_clear_owns_the_delete.sql
```

Contract phase — one file, pushed only after §4 step 6 passes:

```contract
20260818000000_money_direct_write_contract_phase.sql
```

### How the split is executed: a manifest, not a moved file

The split is **not** `supabase db push`, and it is **not** an operator moving the
contract-phase file out of `supabase/migrations/` for the duration of the first
push. Moving files makes the tree that was reviewed and the tree that was applied
two different things, and it leaves the release unrecoverable if the operator is
interrupted between the two pushes. It is done instead with two committed
artifacts:

* [`infra/release/release-manifest.json`](../../infra/release/release-manifest.json)
  names every pending migration in exactly one phase — `required_for_app` (the
  seventeen above) or `deferred_contract` (the one above) — with the SHA-256 of each
  file and the runtime posture each phase must produce.
* [`scripts/db-phase-push.mjs`](../../scripts/db-phase-push.mjs) applies one named
  phase and nothing else:

```text
node scripts/db-phase-push.mjs --phase required_for_app  --url-file <file> --plan
node scripts/db-phase-push.mjs --phase required_for_app  --url-file <file> --apply
node scripts/db-phase-push.mjs --phase deferred_contract --url-file <file> --apply
```

  `--plan` runs every precondition and the hash check and writes nothing. Each
  migration is applied in **one transaction** containing its SQL and its
  `supabase_migrations.schema_migrations` row, with the file's own `begin;` /
  `commit;` skipped so that the file cannot end the tool's transaction. After
  applying, the tool reads every history row back, fingerprints its recorded
  content server-side and compares it with the file, and then measures the phase's
  posture predicates in a READ ONLY transaction.

  It refuses, before writing anything: a manifest that does not match the tree, a
  file whose hash is not the manifest's, `deferred_contract` while any
  `required_for_app` migration is unapplied (this is C6's claim, enforced instead
  of asserted), `required_for_app` once the contract phase is already recorded, a
  version recorded under a different name, a file that sorts at or before the
  newest recorded version, a database with no migration-history table, and a
  connection string passed as an argument instead of in a file.

Two gates keep that honest. `scripts/check-release-manifest.mjs` (CI, and
`npm test`) requires the manifest's two phases to be **exactly** the pending set
of `supabase/migrations/`, with matching hashes: a migration added and not
classified fails CI rather than being left out of the expand push.
`scripts/phase-tool-drill.sh` (CI job `migration-replay`) runs the whole procedure
against throwaway databases and asserts the refusals as hard as the successes —
history-less database refused, contract-before-expand refused, expand applied and
read back, re-run a no-op, contract applied, expand-after-contract refused,
`--verify-only` at state 4, and an interruption in which the twelfth migration
fails after altering tables: eleven stay applied, nothing is recorded for the
twelfth, and a column it added earlier in the same file is gone.

The contract phase also carries the **highest** version in the release, so the
expand set is a contiguous prefix of the pending set. That is deliberate:

* an operator who reaches for the CLI anyway cannot apply the contract phase
  early without applying it last, and `supabase db push` from this tree applies
  the phases in the right order even though it collapses the window;
* `supabase_migrations.schema_migrations` records the two phases in version
  order, so the application order in production is the order
  `scripts/replay-migrations.sh` replays and asserts. §6.1 query 3 expects
  `20260817150000` as the newest version at state 2 and `20260818000000` at
  state 4.

What none of this proves: the tool is not the Supabase CLI, and the statement
array it records is split by this repository's own parser
(`splitStatements`). For the history rows **production already has**, written by
the CLI, content equivalence with the local files remains unproven — round-4
finding C4 — and `scripts/verify-remote-migration-history.mjs` reports those rows
as differences rather than passes.

Neither round-4 file may depend on the contract phase, and neither does: the mode
row is seeded by `20260814000000`, which precedes both, and everything either file
adds consults `money_direct_write_is_blocked()` at write time rather than at apply
time. Their own backfills (`contracts.first_payment_status`,
`payments.credited_to`) run as the migration role, for which
`money_write_is_direct()` is false, so the guards stand down for them in either
mode.

---

## 2 · Compatibility matrix

Five states. **P** = the previous release (`f37c203` / `81956f2`) that is serving
production now. **C** = the candidate release on this branch.

| State | Schema | `direct_write_mode` | P works? | C works? |
| --- | --- | --- | --- | --- |
| 1 · today | base, stamp `20260805202917` | table does not exist | yes | **no** — the RPCs it calls do not all exist yet |
| 2 · expand applied | + the seventeen files | `compat` | yes, with the seven deliberate exceptions in §3 | yes |
| 3 · candidate deployed | + the seventeen files | `compat` | yes (this is the overlap window) | yes |
| 4 · contract applied | + all eighteen | `strict` | **no** — its direct money writes are refused | yes |
| 5 · companion run | + all eighteen | `compat` | yes, as in state 2 | yes |

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
| `src/app/api/contracts/route.ts:341` (PUT) | `contracts` | UPDATE `first_payment_status` |
| `src/app/api/quotations/[id]/convert/route.ts:173` | `quotations` | UPDATE `contract_id` |

The last two rows were added in round 4 and are the reason this table is not a
round-3 artifact: `20260817000000` puts `contracts.first_payment_status` into
`trg_guard_contracts_write`'s protected set (finding B2 — the column was a claim a
salesperson could type) and installs `trg_guard_quotations_write` on
`quotations.contract_id` (finding B5 — the conversion link was writable by the
quotation's owner). Both new refusals are gated on
`money_direct_write_is_blocked()`, i.e. direct **and** strict, so both behave like
every other row here: refused in state 4, accepted in states 2, 3 and 5. Gating
`trg_guard_quotations_write` on `money_write_is_direct()` alone — which is how it
was first written — would have refused the previous release's conversion from the
moment the expand phase applied, closing the compatibility window for that path
before any deploy had happened.

Not affected in any state, and checked rather than assumed:

* `src/app/api/contracts/route.ts:341` (PUT) also sets `first_payment_due_date`.
  That column is in no guard's protected set, so a request that sets only the due
  date keeps working in every state, including state 4.
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

Seven things take effect the moment the expand phase applies, before any
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

5. **Money amounts must be positive, for every writer including
   `service_role`.** `20260817000000` adds three validated CHECK constraints:
   `payments_amount_positive` (`amount > 0`), `payment_allocations_amount_positive`
   (`amount_allocated > 0`) and `installment_plans_amount_positive` (`amount > 0`).
   This is finding B3 — a payment of `-100` was inserted and confirmed, and
   confirmation *subtracted* it from `projects.paid_amount` and
   `kpi_targets.actual_amount`, so a salesperson could reduce their own recorded
   collections.

   Because the constraints are validated rather than `NOT VALID`, **the migration
   fails if production holds a violating row.** It does not skip the constraint and
   it does not repair the data: a `DO` block counts the violations first and raises
   `22000` with the three counts (counts only, never rows) so the push aborts
   before any DDL. Run `supabase/preflight/scan-money-invariants.sql` against
   production *before* step 2 to learn whether that will happen. The count-only
   form of that script is safe for anyone who may run these verification queries;
   its `-v detail=on` form prints real customer money and is for an operator
   entitled to see it. A violating row is a money correction and a business
   decision, not something a deployment fixes.

   Neither release writes a non-positive amount from a working path — the previous
   release's payment route rejects `amount <= 0` before inserting — so this
   constrains what a client could forge, not what either application does.

6. **The session boundary reaches inside the SECURITY DEFINER routines.**
   `20260816000000` injects `assert_current_session_at_entry()` at the entry of
   every authenticated definer routine, so a revoked session is refused at the
   entry rather than at whichever table the routine happens to touch first, and is
   refused even in a routine that touches none. It fires only when `auth.uid()` is
   not null, so `service_role` and `psql` are unaffected, and for a healthy session
   it changes nothing. The same file revokes `EXECUTE` on the trigger functions
   from `PUBLIC`, `anon` and `authenticated` — they were callable directly only
   because `CREATE FUNCTION` grants `EXECUTE` to `PUBLIC`; neither release calls
   one.

7. **Two columns are recomputed from the ledger for existing rows.**
   `20260817000000` reconciles `contracts.first_payment_status` with
   `contract_first_payment_status()` (confirmed, unvoided allocations against the
   first installment) and backfills `payments.credited_to` from the contract's
   current `sales_id`. Both run as the migration role, so the guards stand down for
   them. This is a data change, not a schema change, and the previous release
   *displays* it: a contract whose first payment was marked `paid` without a
   confirmed payment behind it will read `unpaid` or `partial` afterwards. That is
   the correction B2 is about, and it is visible before the candidate deploys.

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

**No destructive DDL.** The expand set adds five nullable columns
(`payments.voided_at`, `payments.voided_by`, `payments.void_reason` from
`20260814000000`; `payments.request_key` and `payments.credited_to` from
`20260817000000`), one table (`public.definer_entry_boundary_exemptions`, RLS on
and granted to nobody) and one partial unique index
(`idx_payments_request_key on payments (created_by, request_key) where request_key
is not null`). It drops no column, table, view or routine either release reads.

There is **no new NOT NULL** on an existing money column. The three new CHECK
constraints are item 5 above, and they are the only new constraint that can refuse
a write either release makes; `credited_to` carries an FK to `profiles (id)`, which
the backfill satisfies by construction because it copies `contracts.sales_id`.
`request_key` is nullable precisely so the previous release's four-column payment
INSERT stays shape-compatible in states 2, 3 and 5 — the guard requires it only in
strict mode, and the unique index is partial, so the historic rows and the previous
release's rows (which have none) cannot collide with each other.

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
2. **[AUTHORISED ACTION] Apply the expand phase.** Apply the seventeen files in §1
   with
   `node scripts/db-phase-push.mjs --phase required_for_app --url-file <file> --apply`,
   from the exact reviewed tree. Run it once with `--plan` first and read the
   `to apply` list: the seventeen, and `20260818000000` absent. Do **not** use
   `supabase db push`, which would apply the contract phase in the same run (§1,
   "How the split is executed"). `supabase/preflight/scan-money-invariants.sql`
   must have been run first: §3 item 5 aborts this push if a non-positive money row
   exists.
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
7. **[AUTHORISED ACTION] Apply the contract phase.** Apply
   `20260818000000_money_direct_write_contract_phase.sql` with
   `node scripts/db-phase-push.mjs --phase deferred_contract --url-file <file> --apply`.
   It refuses if any `required_for_app` migration is still unapplied, and its
   posture check is what proves the mode is `strict` afterwards. **After this step
   an application-only rollback no longer works** (§5).
8. **Verify state 4, read-only.** §6.3.
9. **Record it.** TASKBOARD rows for the migration application and the deployment
   move to ✅ only with the output of §6.1–§6.3 attached, and only for the steps
   that actually ran. The release is not "complete" while any row is ❌.

---

## 5 · Rollback

| Failing at | Recovery | Database action |
| --- | --- | --- |
| step 2 (expand push) | one transaction per file, and the history row commits with it: a file that fails leaves the earlier ones applied and records nothing for itself, so the phase is re-runnable after the cause is fixed (drilled by `scripts/phase-tool-drill.sh` step 9) | re-run the same phase, or restore to the recorded PITR target |
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
 where version = '20260818000000';
-- expect 0

-- 3. the expand set is applied, and is the newest
select version from supabase_migrations.schema_migrations
 order by version desc limit 3;
-- expect 20260817150000 first, then 20260817140000, then 20260817130000 —
-- 20260818000000 is absent because it is the contract phase, which is applied
-- separately (§1, "How the split is executed")

-- 3b. the positive-amount constraints landed (§3 item 5)
select conrelid::regclass::text as tbl, conname, convalidated
  from pg_constraint
 where conname in ('payments_amount_positive',
                   'payment_allocations_amount_positive',
                   'installment_plans_amount_positive')
 order by 1;
-- expect three rows, convalidated = true for each

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

-- 9. the definer entry boundary covers every definer routine (§3 item 6). This is
--    the same predicate 20260816000000 §5 asserts at apply time, re-read after.
select count(*) as uncovered
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
 where n.nspname = 'public'
   and p.prosecdef
   and p.prorettype <> 'trigger'::regtype
   and p.oid::regprocedure::text not in
         (select routine from public.definer_entry_boundary_exemptions)
   and (l.lanname <> 'plpgsql'
        or p.prosrc !~* '(^|\n)[ \t]*begin[ \t]*\r?\n[ \t]*perform[ \t]+public\.assert_current_session_at_entry\(\);');
-- expect 0
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
 where version = '20260818000000';
-- expect 1

-- and it is the newest recorded version, because it is the highest in the release
select version from supabase_migrations.schema_migrations
 order by version desc limit 1;
-- expect 20260818000000
```

`node scripts/db-phase-push.mjs --phase deferred_contract --url-file <file>
--verify-only` re-measures the first two of these from the manifest and writes
nothing; it is the machine-checked form of this section, not a replacement for
reading the output.

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
