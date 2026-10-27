-- ============================================================================
-- R6 · reassign_lead_atomic() writes an activity type its own table forbids
-- ============================================================================
-- Found while building the compare-and-set gate in
-- 20260817180000_leads_updated_at_is_server_owned.sql, and it is a larger defect
-- than the one that gate was written for: the routine cannot complete a real
-- reassignment at all.
--
-- 20260723140000_atomic_lead_reassignment.sql:165-169, on the branch that moves
-- the lead:
--
--     INSERT INTO public.activities (lead_id, user_id, type, content)
--     VALUES (
--       p_lead_id, v_actor_id, 'transfer',
--       format('Lead reassigned from %s to %s', ...)
--     );
--
-- 20260605000000_newme_crm_v22_complete.sql:208-214, the constraint that is still
-- the last word on that column — no migration after it touches
-- activities_type_check, and `grep -rn activities_type_check supabase/migrations`
-- returns only that one ADD and two comments:
--
--     ALTER TABLE activities ADD CONSTRAINT activities_type_check
--       CHECK (type IN (
--         'call','whatsapp','wechat','email','meeting','sms','note','task',
--         'quote_sent','follow_up','stage_change','quality_change',
--         'contract_signed','payment_received','site_visit','cad_review'
--       ));
--
-- 'transfer' is not in that list. So the INSERT raises check_violation, SQLSTATE
-- 23514, and because it is the third of four INSERTs inside one SECURITY DEFINER
-- routine, the whole transaction aborts: the UPDATE of leads.assigned_to, the
-- transfer_history row, the business_events row and the lead_mutation_requests
-- row all disappear with it. Nothing is written and nothing is recorded as
-- having failed.
--
-- What the caller sees. src/app/api/leads/[id]/assignment/route.ts maps RPC
-- failures by matching the message against UNAUTHORIZED / FORBIDDEN / NOT_FOUND /
-- CONCURRENT and falls through to 400 for anything else. A check_violation
-- matches none of them, so the one API that calls this routine answers 400
-- INVALID_REQUEST to a request that was entirely valid.
--
-- Why it was not noticed. The two branches that return early never reach the
-- INSERT:
--   * p_new_assignee equal to the current owner returns `unchanged: true`
--     (20260723140000:144-149);
--   * a replayed idempotency key returns the recorded response
--     (20260723140000:120-127).
-- So a smoke test that reassigns a lead to whoever already owns it, or that
-- re-sends a key, gets 200 back. Only a reassignment that actually moves a lead
-- fails, and it fails as a validation error.
--
-- Reproduced, PG 17.10 (Debian 17.10-1.pgdg13+1), isolated replay database, in
-- supabase/replay/22_lead_reassignment_writes.sh:
--
--   EXPECT=narrow    the constraint put back to the sixteen-value domain inside
--                    the throwaway database. The control is derived, not typed
--                    out: the installed constraint is RENAMED aside, and a
--                    constraint whose definition is pg_get_constraintdef() of the
--                    installed one with 'transfer' removed is added under the
--                    production name. So the control differs from the release by
--                    exactly one value, and the restore is the rename back —
--                    exact by construction, because the original object was never
--                    destroyed. Under that domain reassign_lead_atomic() as an
--                    admin, moving a lead from one salesperson to another, raises
--                    SQLSTATE 23514 on activities_type_check, and afterwards
--                    leads.assigned_to is unchanged and transfer_history,
--                    activities, business_events, notifications and
--                    lead_mutation_requests have gained no row.
--   EXPECT=fixed     this file applied, together with
--                    20260817200000_lead_reassignment_notification_related_id.sql:
--                    the same call returns `"unchanged": false`, the lead has
--                    moved, and each of those five tables has exactly one new row.
--                    The replayed idempotency key returns the recorded response
--                    and writes nothing further, and a call inside a rolled-back
--                    transaction leaves neither the move nor its key behind.
--
-- Widening this domain was necessary and not sufficient. Running the positive
-- direction with only this file applied is how the THIRD defect on the same path
-- was found: the routine gets past the activities INSERT and stops at the
-- notifications one, which puts p_lead_id::text into a uuid column and raises
-- 42804. That is repaired by
-- 20260817200000_lead_reassignment_notification_related_id.sql and measured by the
-- EXPECT=related_text direction of the same gate. Neither file alone lets a
-- reassignment commit.
--
-- Both files are also preconditions of the compare-and-set gate,
-- supabase/replay/23_lead_assignment_cas.sh. That gate has to observe a COMMITTED
-- reassignment to tell a fired compare-and-set from a missed one, and with either
-- write defect installed reassign_lead_atomic() cannot commit one at all — every
-- outcome is a rolled-back transaction, so a run of it would be measuring these
-- defects and reporting them as a guard.
--
-- The fix: add 'transfer' to the domain. Not `'note'` in the routine, although
-- 20260603000001:139 and 20260624000003:136 both did that ("using 'note' which is
-- in activities_type_check") — because the app's own vocabulary already has the
-- word. business_events.chk_event_type carries 'transfer'
-- (20260706000005_add_leads_archived.sql:11, and back to
-- 20260605000000:242), and the very next statement in this routine inserts a
-- business_events row with event_type = 'transfer' and succeeds. The activities
-- domain is the one that fell behind. Rewriting a SECURITY DEFINER body to say a
-- word it does not mean, in the row a user reads on the lead timeline, is the
-- larger change and the less true one.
--
-- Widening is safe on a populated table, and this file does not take the widening
-- on faith:
--   * Only a value is added. Every row that satisfies the sixteen-value domain
--     satisfies the seventeen-value domain, so no existing row can be made
--     invalid by this change.
--   * NOT VALID first, then VALIDATE. `ADD CONSTRAINT ... CHECK` without NOT
--     VALID holds ACCESS EXCLUSIVE for a full scan of activities, which blocks
--     every reader and writer of the table for the length of it. NOT VALID takes
--     the same lock for a moment and no scan; VALIDATE then scans under SHARE
--     UPDATE EXCLUSIVE, which blocks neither. The constraint ends convalidated
--     either way, and the assertion below refuses to leave it NOT VALID.
--   * VALIDATE fails closed. If production's activities table holds a row whose
--     type is outside the seventeen values, VALIDATE raises and this migration
--     aborts — which is the correct outcome, because it would mean the deployed
--     constraint is not the one this repository declares, and a widening written
--     against the wrong starting domain could silently narrow it.
--   * lock_timeout is honoured, 15s otherwise, the shape
--     20260814000000:287 and 20260818000000:92 use. A deploy that cannot get the
--     lock fails and is retried; it does not sit in front of the application's
--     own queries holding an ACCESS EXCLUSIVE request.
--
-- The pre-state is recorded rather than assumed. This branch has no read access
-- to production's catalog (20260806000000_baseline_undeclared_production_objects
-- says so in its own header and derives column types from the generated
-- src/types/database.ts for the same reason), so whether the deployed constraint
-- already carries 'transfer' from some hand-run DDL is not knowable from here.
-- The DO block below measures it in the database this file is applied to and
-- raises a NOTICE with the boolean, so the deploy log carries the answer for
-- whoever reads it afterwards. Either way this file leaves the same domain
-- behind: it is a repair if 'transfer' was missing and a re-assert if it was not.
--
-- NO_ROLLBACK: there is no state to restore. Re-narrowing the domain reinstates
-- the failure reproduced above, and it cannot even be done cleanly once the
-- routine has started working — every activities row this release writes with
-- type = 'transfer' would violate the narrower constraint, so a companion would
-- have to delete audit rows to succeed. The manual revert, if it is ever wanted,
-- is to re-add activities_type_check without 'transfer' after deleting those
-- rows, and the lead-reassignment-activity-domain posture predicate in
-- infra/release/release-manifest.json refuses the release switch while the
-- narrow domain is installed, by design.
-- ============================================================================

begin;

do $$
begin
  -- The caller's explicit lock_timeout is honoured, 15s otherwise. Both ALTERs
  -- below want ACCESS EXCLUSIVE on public.activities for a moment.
  perform set_config('lock_timeout',
                     coalesce(nullif(current_setting('lock_timeout'), '0'), '15s'),
                     true);
end;
$$;

-- What was actually installed, before this file changes it. Booleans only; the
-- constraint definition is schema, but the notice is what the deploy log keeps.
do $$
declare
  v_def text;
begin
  select pg_catalog.pg_get_constraintdef(c.oid)
    into v_def
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.activities'::regclass
     and c.conname = 'activities_type_check';
  raise notice 'R6 pre-state: activities_type_check present=%, accepts_transfer=%',
    (v_def is not null),
    coalesce(v_def like '%''transfer''%', false);
end;
$$;

alter table public.activities drop constraint if exists activities_type_check;

alter table public.activities add constraint activities_type_check
  check (type in (
    'call', 'whatsapp', 'wechat', 'email', 'meeting', 'sms', 'note', 'task',
    'quote_sent', 'follow_up', 'stage_change', 'quality_change',
    'contract_signed', 'payment_received', 'site_visit', 'cad_review',
    'transfer'
  )) not valid;

-- Under SHARE UPDATE EXCLUSIVE, so readers and writers of activities keep
-- running. Raises if any existing row is outside the domain, which aborts this
-- migration rather than leaving a constraint nobody checked.
alter table public.activities validate constraint activities_type_check;

-- ---------------------------------------------------------------------------
-- Fail closed. The domain accepts the word the routine writes, it is validated
-- rather than merely declared, and it did not lose anything on the way through.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def        text;
  v_validated  boolean;
  v_missing    text;
begin
  select pg_catalog.pg_get_constraintdef(c.oid), c.convalidated
    into v_def, v_validated
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.activities'::regclass
     and c.conname = 'activities_type_check'
     and c.contype = 'c';
  if not found then
    raise exception 'activities_type_check is not present on public.activities after this migration';
  end if;
  if not v_validated then
    raise exception 'activities_type_check is NOT VALID after this migration: %', v_def;
  end if;

  -- Every value the sixteen-value domain accepted, plus the one this file adds.
  -- Spelled out so a typo inside the CHECK above cannot pass unnoticed.
  select string_agg(t, ', ' order by t)
    into v_missing
    from unnest(array[
      'call', 'whatsapp', 'wechat', 'email', 'meeting', 'sms', 'note', 'task',
      'quote_sent', 'follow_up', 'stage_change', 'quality_change',
      'contract_signed', 'payment_received', 'site_visit', 'cad_review',
      'transfer'
    ]) as t
   where v_def not like '%''' || t || '''%';
  if v_missing is not null then
    raise exception 'activities_type_check no longer accepts: %', v_missing;
  end if;

  raise notice 'R6 OK: activities_type_check accepts transfer and is validated, so reassign_lead_atomic() can write its activity row';
end;
$$;

-- Inside the transaction on purpose. NOTIFY is queued and delivered at commit, so
-- a migration that rolls back never tells PostgREST to reload a schema it did not
-- get; and a statement after `commit;` would make this file non-atomic, which is
-- exactly what scripts/db-phase-push.mjs (one transaction per file) and
-- tests/release/release-phase-manifest.test.mjs refuse.
notify pgrst, 'reload schema';

commit;
