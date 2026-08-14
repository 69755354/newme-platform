#!/usr/bin/env bash
# ============================================================================
# Rollback-path gate: the two companion defects review round 4 found (R7)
# ============================================================================
# Both are about a rollback that reports success while leaving something behind
# that nobody checked, and neither is visible in a file that only has to parse.
#
#   EXPECT=companion_guards
#     rollback_money_direct_write_contract_phase.sql updated one row and read
#     THAT ROW back. The guards do not read the row — they call
#     public.money_direct_write_mode() — so a mode function that has been
#     redefined, dropped and recreated wrong, or shadowed passes the column check
#     and keeps refusing the previous release's writes. The rollback says
#     "direct end-user money writes are accepted again" and they are not.
#
#     Its header also promised that everything except the six mode-gated guards
#     stays closed — the session boundary, the transition graph, the two
#     server-only KPI routines — and checked none of it. If any of those is
#     missing when an operator runs this, 'compat' is not "the posture production
#     has today", it is a posture nothing was ever tested under.
#
#     So this direction runs the shipped companion four times against four
#     databases-of-the-moment: one with the mode function pinned to a constant,
#     one with the session boundary disabled on public.payments, one with a KPI
#     routine's EXECUTE opened to `authenticated`, and one with nothing wrong.
#     The first three must refuse and leave the mode where they found it; the
#     fourth must commit, read back through the function, and record the change.
#
#     The control comes first and is the reproduction: with the mode function
#     pinned to 'strict', the old two-statement shape (update the row, select the
#     row) is executed directly and shown returning 'compat' while the function the
#     guards call still says 'strict' — a green rollback with every guard still
#     refusing. Without that, "the fixed companion raises" is not evidence that the
#     check catches anything real.
#
#     money_direct_write_is_blocked() is not evaluated in this direction, and the
#     companion no longer calls it either. It returns false whenever current_user
#     is not `authenticated`, so from an operator session it answers false whatever
#     the mode says — a check that cannot fail. 20_assert_post_rollback.sql
#     evaluates it from a session where it discriminates.
#
#     Running the shipped companions for real also WRITES: each one that commits
#     records the posture change in public.audit_logs, which is the point of the
#     positive and reentry checks. Those rows are state, in the one database the
#     harness keeps using — and supabase/replay/30_assert_post_recontract.sql
#     counts MONEY_CONTRACT_PHASE_REENTERED exactly, so three rows left behind here
#     turn a green release into a failed post-recontract assertion about something
#     this gate did. So the direction ends by removing exactly the rows it wrote,
#     by id, and requiring public.audit_logs back at the row count it started from.
#
#   EXPECT=kpi_drop
#     rollback_l0_20260811.sql drops public.replace_kpi_targets(text, jsonb, uuid)
#     with no lock and no lock_timeout. Every writer of public.kpi_targets
#     serializes on pg_advisory_xact_lock(hashtextextended('public.kpi_targets:'
#     || period, 0)); this file took nothing, so it removed the save path from
#     underneath a save that was mid-transaction. That is staged here with two
#     sessions and measured in both directions:
#
#       control   session A holds a live period's lock, uncommitted. The bare
#                 `drop function` this file used to contain succeeds immediately.
#                 Same instant, same held lock — so the wait below is the guard's
#                 doing and nothing else's.
#       guarded   the DO block as shipped, extracted from the file rather than
#                 retyped, is required to be seen WAITING in pg_locks and then to
#                 fail with lock_timeout (55P03) — and the function must still be
#                 there afterwards. A rollback that stops with a timeout is
#                 recoverable; one that drops the save path out from under a
#                 committing save is not.
#       positive  A commits, the same block runs again and drops the function.
#                 This doubles as the control for the negative: if the block
#                 refused for any reason other than the lock, the timeout above
#                 would not be attributable to the lock.
#       reentry   run a third time with the function already gone: the notice path
#                 returns cleanly, so a re-run of a rollback is not an error.
#
#     The definition the drop is aimed at is the 20260811100500 one, because the
#     shipped block refuses to drop the round-4 definition (that discriminator is
#     this file's own earlier fix and stays in force). The live definition is
#     therefore captured with pg_get_functiondef(), replaced by a stub that lacks
#     the round-4 marker, and restored verbatim at the end — the same
#     capture-mutate-restore idiom 19_ and 23_ use, and cleanup() restores it even
#     when the gate fails.
#
# The rollback direction does not require the six mode-gated guards to be active;
# standing them down is its purpose. The recontract probe below separately
# replaces one expected trigger function with a no-op and proves that the return
# to strict is refused before the mode or audit trail changes.
#
# Requires: psql on PATH, PG* pointing at the throwaway replay database, the
# release migrations applied and public.money_release_mode at 'strict'. Invoked by
# scripts/replay-migrations.sh; never run against production.
# ============================================================================
set -euo pipefail

EXPECT="${EXPECT:-companion_guards}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../migrations" && pwd)}"
MONEY_ROLLBACK="$MIGRATIONS_DIR/rollback_money_direct_write_contract_phase.sql"
MONEY_RECONTRACT="$MIGRATIONS_DIR/recontract_money_direct_write_contract_phase.sql"
L0_ROLLBACK="$MIGRATIONS_DIR/rollback_l0_20260811.sql"

MARK_HI=918274                                    # same classid as 23_, its own objid:
MARK_LO=648                                       # 645/646/648-652 are taken under 918273,
                                                  # 646 and 647 under 918274 by 23_.

work_dir="$(mktemp -d)"
out_a="$work_dir/session_a.log"

PSQL_Q=(psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1)

fail() {
  printf 'FAIL(%s): %s\n' "$EXPECT" "$1" >&2
  exit 1
}
q() { "${PSQL_Q[@]}" -c "$1" | tr -d '[:space:]'; }

restore_mode_function() {
  [ -s "$work_dir/mode_orig.sql" ] || return 0
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/mode_orig.sql" >"$work_dir/restore_mode.log" 2>&1 || {
    cat "$work_dir/restore_mode.log" >&2
    printf 'FAIL(%s): could not restore public.money_direct_write_mode(); this database is now mutated\n' "$EXPECT" >&2
    exit 1
  }
}

restore_contract_guard() {
  [ -s "$work_dir/contract_guard_orig.sql" ] || return 0
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/contract_guard_orig.sql" >"$work_dir/restore_contract_guard.log" 2>&1 || {
    cat "$work_dir/restore_contract_guard.log" >&2
    printf 'FAIL(%s): could not restore public.guard_contracts_write(); this database is now mutated\n' "$EXPECT" >&2
    exit 1
  }
}

restore_kpi_function() {
  [ -s "$work_dir/kpi_orig.sql" ] || return 0
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/kpi_orig.sql" >"$work_dir/restore_kpi.log" 2>&1 || {
    cat "$work_dir/restore_kpi.log" >&2
    printf 'FAIL(%s): could not restore public.replace_kpi_targets(); this database is now mutated\n' "$EXPECT" >&2
    exit 1
  }
  # The definition is restored with `create or replace`, which keeps whatever ACL
  # the object already had — and this gate has to DROP the function to install its
  # stand-in (create-or-replace cannot change a return type), so the recreated
  # object starts from the default, i.e. EXECUTE held through PUBLIC. Leaving that
  # behind would hand every authenticated caller the KPI save path in a database
  # the later gates then assert a server-only posture on. Restore the captured ACL
  # and compare it byte for byte rather than trusting the two statements.
  [ -s "$work_dir/kpi_acl.txt" ] || return 0
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -c "revoke all on function public.replace_kpi_targets(text, jsonb, uuid) from public;
        revoke all on function public.replace_kpi_targets(text, jsonb, uuid) from anon;
        revoke all on function public.replace_kpi_targets(text, jsonb, uuid) from authenticated;
        grant execute on function public.replace_kpi_targets(text, jsonb, uuid) to service_role" \
    >"$work_dir/restore_kpi_acl.log" 2>&1 || {
    cat "$work_dir/restore_kpi_acl.log" >&2
    printf 'FAIL(%s): could not restore the ACL of public.replace_kpi_targets()\n' "$EXPECT" >&2
    exit 1
  }
  local want have
  want="$(tr -d '[:space:]' <"$work_dir/kpi_acl.txt")"
  have="$(q "select coalesce(proacl::text, '(null)') from pg_proc where oid = to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)')")"
  if [ "$want" != "$have" ]; then
    printf 'FAIL(%s): the ACL of public.replace_kpi_targets() was left as %s, not the %s this gate found\n' \
      "$EXPECT" "$have" "$want" >&2
    exit 1
  fi
}

cleanup() {
  local status=$?
  if [ -n "${A_IN:-}" ]; then
    { printf 'rollback;\n\\q\n' >&"$A_IN"; } 2>/dev/null || true
    exec {A_IN}>&- 2>/dev/null || true
  fi
  [ -n "${A_PID:-}" ] && wait "$A_PID" 2>/dev/null || true
  psql --no-psqlrc --quiet -c "alter table public.payments enable trigger trg_require_current_session" >/dev/null 2>&1 || true
  psql --no-psqlrc --quiet -c "revoke execute on function public.clear_kpi_targets(text, uuid) from authenticated" >/dev/null 2>&1 || true
  restore_mode_function
  restore_contract_guard
  restore_kpi_function
  [ "$status" != "0" ] && [ -f "$out_a" ] && { echo "--- session A ---" >&2; cat "$out_a" >&2; }
  rm -rf "$work_dir"
  exit "$status"
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"
for f in "$MONEY_ROLLBACK" "$MONEY_RECONTRACT" "$L0_ROLLBACK"; do
  [ -f "$f" ] || fail "missing $f"
done

[ "$(q "select to_regclass('public.money_release_mode') is not null")" = "t" ] \
  || fail "public.money_release_mode does not exist; this gate needs the release schema"
[ "$(q "select direct_write_mode from public.money_release_mode where id = 'only'")" = "strict" ] \
  || fail "this gate must start from the release posture (strict); it found $(q "select coalesce(direct_write_mode,'absent') from public.money_release_mode where id = 'only'")"
[ "$(q "select to_regclass('public.audit_logs') is not null")" = "t" ] \
  || fail "public.audit_logs does not exist; the recorded-posture-change half of this gate would pass vacuously"

audit_count() {
  q "select count(*) from public.audit_logs where action = 'MONEY_CONTRACT_PHASE_ROLLED_BACK'"
}
mode_column() { q "select coalesce(direct_write_mode, 'absent') from public.money_release_mode where id = 'only'"; }

# Both actions the hand-run money companions record, because both are counted
# downstream and this gate causes both to be written.
AUDIT_POSTURE_ACTIONS="('MONEY_CONTRACT_PHASE_ROLLED_BACK', 'MONEY_CONTRACT_PHASE_REENTERED')"

# Remove exactly the posture audit rows this gate wrote, by identity against the
# ids that existed before its probes ran — not by timestamp (two runs inside one
# clock tick are indistinguishable that way) and not by count (deleting "the last
# three" would delete somebody else's row if the baseline were not what it thought).
# Called on the success path only: when a direction FAILS the harness stops, so no
# later file reads this database, and the rows are then evidence rather than debris.
restore_audit_trail() {
  local ids predicate removed posture_after rows_after
  ids="$(tr -d '[:space:]' <"$work_dir/audit_ids.txt" 2>/dev/null || true)"
  predicate="true"
  [ -n "$ids" ] && predicate="id::text not in ($ids)"
  removed="$(q "with gone as (
                  delete from public.audit_logs
                        where action in $AUDIT_POSTURE_ACTIONS
                          and $predicate
                    returning 1
                )
                select count(*) from gone")" \
    || fail "could not remove the posture audit rows this gate wrote; this database is now one 30_assert_post_recontract.sql will fail on"
  [ "$removed" = "3" ] \
    || fail "this gate commits three posture changes (two rollbacks and one recontract) and removed $removed row(s); a mismatch means it no longer knows what it wrote"
  posture_after="$(q "select count(*) from public.audit_logs where action in $AUDIT_POSTURE_ACTIONS")"
  [ "$posture_after" = "$audit_posture_before" ] \
    || fail "posture audit rows went $audit_posture_before -> $posture_after across this gate"
  rows_after="$(q "select count(*) from public.audit_logs")"
  [ "$rows_after" = "$audit_rows_before" ] \
    || fail "public.audit_logs went $audit_rows_before -> $rows_after rows across this gate, so it writes something this restore does not account for"
  echo "  audit trail restored: $removed row(s) this gate wrote removed by id, public.audit_logs back to $rows_after row(s)"
}

# `psql -f` on a companion: it carries its own begin/commit, so a failure aborts
# its own transaction and persists nothing. Output is kept for the message check.
run_companion() {
  local file="$1" log="$2"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$file" >"$log" 2>&1
}

if [ "$EXPECT" = "companion_guards" ]; then
  # ── Capture the mode function before anything mutates it ──────────────────
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -c "select pg_get_functiondef(to_regprocedure('public.money_direct_write_mode()')::oid)" \
    >"$work_dir/mode_orig.sql" 2>"$work_dir/capture.log" || {
    cat "$work_dir/capture.log" >&2
    fail "could not capture public.money_direct_write_mode()"
  }
  printf ';\n' >>"$work_dir/mode_orig.sql"
  grep -q "money_release_mode" "$work_dir/mode_orig.sql" \
    || fail "the captured definition of money_direct_write_mode() does not read money_release_mode, so restoring it would not restore the release"

  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -c "select pg_get_functiondef(to_regprocedure('public.guard_contracts_write()')::oid)" \
    >"$work_dir/contract_guard_orig.sql" 2>"$work_dir/capture_contract_guard.log" || {
    cat "$work_dir/capture_contract_guard.log" >&2
    fail "could not capture public.guard_contracts_write()"
  }
  printf ';\n' >>"$work_dir/contract_guard_orig.sql"
  grep -q "money_direct_write_is_blocked" "$work_dir/contract_guard_orig.sql" \
    || fail "the captured guard_contracts_write() does not consult the release mode"

  baseline_audit="$(audit_count)"

  # ── The audit trail this gate is about to write into ──────────────────────
  # Recorded before any probe runs, so what it adds can be removed by identity
  # afterwards. The whole-table count is kept as well: a companion that starts
  # recording under a third action would otherwise pass the by-id restore and still
  # leave a row behind.
  q "select coalesce(string_agg(quote_literal(id::text), ','), '') from public.audit_logs where action in $AUDIT_POSTURE_ACTIONS" \
    >"$work_dir/audit_ids.txt"
  audit_posture_before="$(q "select count(*) from public.audit_logs where action in $AUDIT_POSTURE_ACTIONS")"
  audit_rows_before="$(q "select count(*) from public.audit_logs")"

  # ── Control · the shape the companion used to have, on a pinned function ──
  # The mode function is redefined to ignore the row. Then the two statements the
  # old companion ran are executed directly: update the row, select the row. It
  # reads 'compat' and reports a completed rollback while every guard in the
  # release still refuses, which is the defect. Rolled back, so nothing persists.
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -c "create or replace function public.money_direct_write_mode() returns text language sql stable as \$fn\$ select 'strict'::text \$fn\$" \
    >"$work_dir/pin.log" 2>&1 || { cat "$work_dir/pin.log" >&2; fail "could not pin the mode function"; }

  old_shape="$("${PSQL_Q[@]}" <<'SQL' | tr -d '[:space:]'
begin;
update public.money_release_mode set direct_write_mode = 'compat' where id = 'only';
select 'old_shape_reports=' || (select direct_write_mode from public.money_release_mode where id = 'only')
    || ' guards_see=' || public.money_direct_write_mode();
rollback;
SQL
)"
  echo "  control (old two-statement shape, mode function pinned): $old_shape"
  [ "$old_shape" = "old_shape_reports=compatguards_see=strict" ] \
    || fail "the control did not reproduce a rollback that reports compat while the guards still refuse; it reported '$old_shape', so the readback check below is not evidence of anything"

  # ── Negative 1 · the same pinned function, against the shipped companion ──
  if run_companion "$MONEY_ROLLBACK" "$work_dir/neg1.log"; then
    cat "$work_dir/neg1.log" >&2
    fail "the money rollback companion accepted a mode function that returns 'strict' regardless of the row, so it would report a completed rollback while every guard kept refusing the previous release's writes"
  fi
  grep -q "the mode column says compat but public.money_direct_write_mode() says strict" "$work_dir/neg1.log" \
    || { cat "$work_dir/neg1.log" >&2; fail "the companion failed, but not on the function readback; the message must name the mismatch it found"; }
  [ "$(mode_column)" = "strict" ] \
    || fail "the refused rollback still moved the mode column to $(mode_column); a companion that raises must persist nothing"
  [ "$(audit_count)" = "$baseline_audit" ] \
    || fail "the refused rollback wrote an audit row; a posture change that did not happen must not be recorded"
  echo "  negative 1 (mode function pinned to strict): refused, mode still strict, no audit row"
  restore_mode_function
  [ "$(q "select public.money_direct_write_mode()")" = "strict" ] \
    || fail "restoring the mode function did not return it to reading the row (it says $(q "select public.money_direct_write_mode()"))"

  # ── Negative 2 · the class-28 session boundary disabled on one table ──────
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -c "alter table public.payments disable trigger trg_require_current_session" >/dev/null 2>&1 \
    || fail "could not disable trg_require_current_session on public.payments"
  if run_companion "$MONEY_ROLLBACK" "$work_dir/neg2.log"; then
    cat "$work_dir/neg2.log" >&2
    fail "the money rollback companion re-opened direct money writes while the session write boundary was disabled on public.payments — the exact combination its header promises cannot happen"
  fi
  grep -q "trg_require_current_session on public.payments" "$work_dir/neg2.log" \
    || { cat "$work_dir/neg2.log" >&2; fail "the companion failed but did not name the uncovered table; a refusal an operator cannot act on is a refusal they will bypass"; }
  [ "$(mode_column)" = "strict" ] || fail "the refused rollback still moved the mode column"
  echo "  negative 2 (session boundary disabled on payments): refused and named the table"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -c "alter table public.payments enable trigger trg_require_current_session" >/dev/null 2>&1 \
    || fail "could not re-enable trg_require_current_session on public.payments"

  # ── Negative 3 · a KPI routine reachable from a session ───────────────────
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -c "grant execute on function public.clear_kpi_targets(text, uuid) to authenticated" >/dev/null 2>&1 \
    || fail "could not open clear_kpi_targets to authenticated"
  if run_companion "$MONEY_ROLLBACK" "$work_dir/neg3.log"; then
    cat "$work_dir/neg3.log" >&2
    fail "the money rollback companion accepted a KPI routine that a browser session can call, so 'compat' here would not be the posture the previous release ran under"
  fi
  grep -q "the server-only definer posture of public.clear_kpi_targets(text, uuid)" "$work_dir/neg3.log" \
    || { cat "$work_dir/neg3.log" >&2; fail "the companion failed but did not name the routine whose posture it rejected"; }
  [ "$(mode_column)" = "strict" ] || fail "the refused rollback still moved the mode column"
  echo "  negative 3 (clear_kpi_targets executable by authenticated): refused and named the routine"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -c "revoke execute on function public.clear_kpi_targets(text, uuid) from authenticated" >/dev/null 2>&1 \
    || fail "could not close clear_kpi_targets again"

  # ── Positive · nothing wrong, so it must commit and record ────────────────
  run_companion "$MONEY_ROLLBACK" "$work_dir/pos.log" \
    || { cat "$work_dir/pos.log" >&2; fail "the money rollback companion does not apply on a database where every promise in its header holds"; }
  [ "$(mode_column)" = "compat" ] || fail "the rollback committed but the mode column says $(mode_column)"
  [ "$(q "select public.money_direct_write_mode()")" = "compat" ] \
    || fail "the mode column says compat but the function the guards call says $(q "select public.money_direct_write_mode()")"
  after_first="$(audit_count)"
  [ "$after_first" = "$((baseline_audit + 1))" ] \
    || fail "expected exactly one MONEY_CONTRACT_PHASE_ROLLED_BACK row for one rollback, count went $baseline_audit -> $after_first"
  [ "$(q "select details->>'previous_mode' from public.audit_logs where action = 'MONEY_CONTRACT_PHASE_ROLLED_BACK' order by created_at desc limit 1")" = "strict" ] \
    || fail "the audit row does not record the mode it replaced, which is the only part of it an operator cannot reconstruct afterwards"
  echo "  positive: mode compat through the function, guards stood down, one audit row recording previous_mode=strict"

  # ── Negative 4 · expected trigger exists but its exact function body drifted ─
  # Keep the gate name in a comment: a text-presence check would accept this no-op,
  # while the shipped pg_proc.prosrc digest must reject it before strict or audit.
  reentry_audit_before="$(q "select count(*) from public.audit_logs where action = 'MONEY_CONTRACT_PHASE_REENTERED'")"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -c "create or replace function public.guard_contracts_write() returns trigger language plpgsql security invoker as \$fn\$ begin /* money_direct_write_is_blocked() intentionally absent */ return new; end \$fn\$" \
    >"$work_dir/noop_guard.log" 2>&1 \
    || { cat "$work_dir/noop_guard.log" >&2; fail "could not install the no-op contract guard probe"; }
  if run_companion "$MONEY_RECONTRACT" "$work_dir/neg4.log"; then
    cat "$work_dir/neg4.log" >&2
    fail "the recontract companion declared strict while guard_contracts_write() no longer consulted the release mode"
  fi
  grep -q "enabled mode-gated trigger trg_guard_contracts_write on public.contracts backed by public.guard_contracts_write()" "$work_dir/neg4.log" \
    || { cat "$work_dir/neg4.log" >&2; fail "the recontract refusal did not name the trigger/function contract it rejected"; }
  [ "$(mode_column)" = "compat" ] \
    || fail "the refused recontract wrote strict before validating the live guard function"
  [ "$(q "select count(*) from public.audit_logs where action = 'MONEY_CONTRACT_PHASE_REENTERED'")" = "$reentry_audit_before" ] \
    || fail "the refused recontract wrote a MONEY_CONTRACT_PHASE_REENTERED audit row"
  restore_contract_guard
  [ "$(q "select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') from pg_catalog.pg_proc p where p.oid = to_regprocedure('public.guard_contracts_write()')")" = "4cf1b6b7264ec7e8228f51ea57c8acb0f0aa09d5806c041cea520d52c8e92012" ] \
    || fail "restoring guard_contracts_write() did not restore its exact shipped body"
  echo "  negative 4 (contract trigger function replaced by a marker-bearing no-op): refused before strict or audit, exact function restored"

  # ── Reentry · a rollback re-run is not an error, and says so ──────────────
  run_companion "$MONEY_ROLLBACK" "$work_dir/reentry.log" \
    || { cat "$work_dir/reentry.log" >&2; fail "re-running the rollback companion failed; an operator who repeats a hand-run step must not be left guessing"; }
  [ "$(mode_column)" = "compat" ] || fail "the second rollback moved the mode off compat"
  [ "$(audit_count)" = "$((baseline_audit + 2))" ] \
    || fail "the second run did not record itself; two hand-run posture changes must be two rows"
  [ "$(q "select details->>'previous_mode' from public.audit_logs where action = 'MONEY_CONTRACT_PHASE_ROLLED_BACK' order by created_at desc limit 1")" = "compat" ] \
    || fail "the second audit row does not record that it started from compat, so the two runs are indistinguishable in the record"
  echo "  reentry: second run idempotent on the mode, recorded separately with previous_mode=compat"

  # ── Leave the database as this gate found it ──────────────────────────────
  # Through the shipped forward companion, not by hand: the harness runs the
  # rollback section after this gate and must see the release posture.
  run_companion "$MONEY_RECONTRACT" "$work_dir/back.log" \
    || { cat "$work_dir/back.log" >&2; fail "could not return to the strict posture with the recontract companion; this database is now mutated"; }
  [ "$(mode_column)" = "strict" ] || fail "the recontract companion did not restore strict"
  [ "$(q "select public.money_direct_write_mode()")" = "strict" ] \
    || fail "the mode column says strict but the function says $(q "select public.money_direct_write_mode()")"

  # The mode is back; the record of getting there three times is not part of the
  # posture the harness handed over. See restore_audit_trail().
  restore_audit_trail
  echo "== rollback companion guards OK (control + 4 negatives + positive + reentry, posture and audit trail restored) =="
  exit 0
fi

if [ "$EXPECT" = "kpi_drop" ]; then
  # ── Extract the shipped DO block, rather than retyping it ─────────────────
  awk '/^-- Round-4 R7 · the drop below took no lock/{f=1}
       f && /^do \$do\$$/{p=1}
       p{print}
       p && /^\$do\$;$/{exit}' "$L0_ROLLBACK" >"$work_dir/kpi_drop.sql"
  [ -s "$work_dir/kpi_drop.sql" ] || fail "could not extract the KPI drop block from $L0_ROLLBACK"
  grep -q "pg_advisory_xact_lock(hashtextextended('public.kpi_targets:'" "$work_dir/kpi_drop.sql" \
    || fail "the extracted block does not take the period lock, so this gate would be measuring the wrong text"
  grep -q "set_config('lock_timeout'" "$work_dir/kpi_drop.sql" \
    || fail "the extracted block does not set lock_timeout, so the wait below could never end"
  grep -q "drop function public.replace_kpi_targets(text, jsonb, uuid);" "$work_dir/kpi_drop.sql" \
    || fail "the extracted block does not drop replace_kpi_targets"

  # ── Capture the live definition, then stand in the pre-round-4 one ────────
  # The shipped block refuses to drop the round-4 definition. That discriminator
  # is correct and stays; it also means the drop is only reachable on a database
  # below 20260817000000, which is what the stub reproduces.
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -c "select pg_get_functiondef(to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)')::oid)" \
    >"$work_dir/kpi_orig.sql" 2>"$work_dir/capture.log" || {
    cat "$work_dir/capture.log" >&2
    fail "could not capture public.replace_kpi_targets(text, jsonb, uuid)"
  }
  printf ';\n' >>"$work_dir/kpi_orig.sql"
  grep -q "assert_current_session_at_entry" "$work_dir/kpi_orig.sql" \
    || fail "the live replace_kpi_targets() is not the round-4 definition; this database is not the release, so nothing measured here would be about it"
  # Captured before anything is dropped, and reasserted by restore_kpi_function().
  q "select coalesce(proacl::text, '(null)') from pg_proc where oid = to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)')" \
    >"$work_dir/kpi_acl.txt"
  [ -s "$work_dir/kpi_acl.txt" ] || fail "could not read the ACL of public.replace_kpi_targets(text, jsonb, uuid)"

  period="$(q "select min(period) from public.kpi_targets")"
  [ -n "$period" ] \
    || fail "public.kpi_targets holds no period, so there is no live period lock to stage; this gate cannot measure the guard on an empty table"
  lock_key="$(q "select hashtextextended('public.kpi_targets:' || '$period', 0)")"
  echo "  staging on period '$period' (advisory key $lock_key)"

  install_stub() {
    # Dropped and created, not replaced: the live round-4 function returns
    # SETOF kpi_targets and `create or replace function` cannot change a return
    # type. The stand-in keeps that signature — a `returns void` stub would also
    # make restore_kpi_function()'s `create or replace` fail — and keeps the period
    # lock, because the period lock is precisely what session A must be holding.
    # What it drops is the round-4 session-boundary marker, which is what makes the
    # shipped block willing to drop it at all. Both statements go in one psql -c,
    # so they are one transaction: the save path is never half-present.
    psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -c "
      drop function if exists public.replace_kpi_targets(text, jsonb, uuid);
      create function public.replace_kpi_targets(p_period text, p_rows jsonb, p_set_by uuid)
      returns setof public.kpi_targets language plpgsql security definer set search_path = public, pg_temp as \$fn\$
      begin
        perform pg_advisory_xact_lock(hashtextextended('public.kpi_targets:' || p_period, 0));
        return;
      end
      \$fn\$" >"$work_dir/stub.log" 2>&1 \
      || { cat "$work_dir/stub.log" >&2; fail "could not install the pre-round-4 stand-in for replace_kpi_targets()"; }
    [ "$(q "select pg_get_functiondef(to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)')::oid) like '%assert_current_session_at_entry%'")" = "f" ] \
      || fail "the stand-in still carries the round-4 marker, so the shipped block would refuse to drop it and the measurement would be vacuous"
  }
  fn_present() { q "select to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)') is not null"; }

  [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO")" = "0" ] \
    || fail "the done-marker key ($MARK_HI, $MARK_LO) is already held, so the barrier below would pass without session A having done anything"

  install_stub

  # ── Session A: a KPI writer, mid-transaction, holding the period lock ─────
  coproc A_SESSION { psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 >"$out_a" 2>&1; }
  A_IN="${A_SESSION[1]}"
  A_PID="$A_SESSION_PID"
  # Called from FROM, not from the target list: a set-returning function in a
  # select list is a ProjectSet node, and this gate depends on the body actually
  # running (that is where the period lock is taken), not on how many rows it
  # would have produced.
  printf "set application_name = 'replay_kpi_writer';
          begin;
          select count(*) from public.replace_kpi_targets('%s', '[]'::jsonb, null);
          select pg_advisory_xact_lock(%s, %s);\n" "$period" "$MARK_HI" "$MARK_LO" >&"$A_IN"

  for _ in $(seq 1 200); do
    [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO")" = "1" ] && break
    sleep 0.1
  done
  [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO")" = "1" ] \
    || fail "session A never reached its barrier, so it is not holding the period lock this gate is about"
  # pg_locks splits a single-key advisory lock into classid/objid (both oid, i.e.
  # unsigned 32-bit) with objsubid = 1. The key here is negative, so the obvious
  # `(classid::bigint << 32) + objid::bigint` overflows bigint before it can be
  # compared — the key is decomposed instead, which is exact for either sign.
  [ "$(q "select count(*) from pg_locks l join pg_stat_activity s on s.pid = l.pid
            where l.locktype = 'advisory' and l.granted and l.objsubid = 1
              and s.application_name = 'replay_kpi_writer'
              and l.classid::bigint = ((($lock_key)::bigint >> 32) & 4294967295)
              and l.objid::bigint   = (($lock_key)::bigint & 4294967295)")" = "1" ] \
    || fail "session A holds its marker but not the period lock for '$period'; the staging is wrong"
  echo "  session A holds the period lock for '$period', uncommitted"

  # ── Control · the bare drop this file used to contain ─────────────────────
  control_start="$(date +%s)"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -c "drop function public.replace_kpi_targets(text, jsonb, uuid)" >"$work_dir/control.log" 2>&1 \
    || { cat "$work_dir/control.log" >&2; fail "the bare drop failed for some reason other than the lock; the guarded measurement below would not be comparable"; }
  control_secs=$(( $(date +%s) - control_start ))
  [ "$(fn_present)" = "f" ] \
    || fail "the bare drop reported success and the function is still there; this gate has lost track of the database"
  [ "$control_secs" -lt 5 ] \
    || fail "the bare drop took ${control_secs}s, so it was not the immediate, unserialized drop this control is supposed to reproduce"
  echo "  control: the bare drop removed the save path in ${control_secs}s while A's KPI write was still in flight"

  install_stub

  # ── Guarded · the shipped block must WAIT, then time out ──────────────────
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -c "set application_name = 'replay_kpi_drop'" -f "$work_dir/kpi_drop.sql" \
    >"$work_dir/guarded.log" 2>&1 &
  guarded_pid=$!

  waited=0
  for _ in $(seq 1 200); do
    if [ "$(q "select count(*) from pg_locks l join pg_stat_activity s on s.pid = l.pid
                where l.locktype = 'advisory' and not l.granted and l.objsubid = 1
                  and s.application_name = 'replay_kpi_drop'
                  and l.classid::bigint = ((($lock_key)::bigint >> 32) & 4294967295)
                  and l.objid::bigint   = (($lock_key)::bigint & 4294967295)")" != "0" ]; then
      waited=1
      break
    fi
    kill -0 "$guarded_pid" 2>/dev/null || break
    sleep 0.1
  done
  [ "$waited" = "1" ] \
    || { cat "$work_dir/guarded.log" >&2; fail "the guarded block was never seen waiting on the period lock; whatever it did, it did not queue behind the in-flight KPI write"; }
  echo "  guarded: the drop is waiting on A's period lock"

  guarded_exit=0
  wait "$guarded_pid" || guarded_exit=$?
  [ "$guarded_exit" != "0" ] \
    || { cat "$work_dir/guarded.log" >&2; fail "the guarded block completed while A still held the period lock, so the lock it takes does not order it against an in-flight KPI write"; }
  grep -qi "lock timeout" "$work_dir/guarded.log" \
    || { cat "$work_dir/guarded.log" >&2; fail "the guarded block failed, but not on lock_timeout; without the timeout an operator's rollback blocks indefinitely while holding the DDL locks the sections above took"; }
  [ "$(fn_present)" = "t" ] \
    || fail "the guarded block timed out AND dropped the function; a refused rollback must persist nothing"
  echo "  guarded: refused with a lock timeout, save path still present"

  # ── Positive · A commits, the same block drops it ─────────────────────────
  printf 'commit;\n' >&"$A_IN"
  for _ in $(seq 1 200); do
    [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO")" = "0" ] && break
    sleep 0.1
  done
  [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO")" = "0" ] \
    || fail "session A did not release the period lock after committing"

  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$work_dir/kpi_drop.sql" >"$work_dir/positive.log" 2>&1 \
    || { cat "$work_dir/positive.log" >&2; fail "the guarded block cannot drop the pre-round-4 definition even with no lock held, so the timeout above is not attributable to the lock"; }
  [ "$(fn_present)" = "f" ] \
    || fail "the guarded block reported success without dropping the function"
  grep -q "period lock(s) held" "$work_dir/positive.log" \
    || { cat "$work_dir/positive.log" >&2; fail "the successful drop did not report how many period locks it held; an operator reading a rollback log must be able to see it took them"; }
  echo "  positive: with the lock released, the same block dropped the pre-round-4 definition"

  # ── Reentry · a re-run with the function already gone ─────────────────────
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$work_dir/kpi_drop.sql" >"$work_dir/reentry.log" 2>&1 \
    || { cat "$work_dir/reentry.log" >&2; fail "re-running the KPI drop block with the function already absent failed; a repeated hand-run rollback step must not raise"; }
  grep -q "already absent" "$work_dir/reentry.log" \
    || { cat "$work_dir/reentry.log" >&2; fail "the re-run did not take the already-absent path"; }
  echo "  reentry: already-absent path, clean exit"

  restore_kpi_function
  [ "$(q "select pg_get_functiondef(to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)')::oid) like '%assert_current_session_at_entry%'")" = "t" ] \
    || fail "the round-4 definition of replace_kpi_targets() was not restored; this database no longer represents the release"
  : >"$work_dir/kpi_orig.sql"

  [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO")" = "0" ] \
    || fail "this gate leaked its advisory done-marker"
  echo "== KPI drop lock OK (control + waiting + timeout + positive + reentry, round-4 definition restored) =="
  exit 0
fi

fail "unknown EXPECT=$EXPECT (expected companion_guards or kpi_drop)"
