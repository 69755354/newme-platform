#!/usr/bin/env bash
# S3 #1 behaviour proof on a THROWAWAY PostgreSQL 17 (never production).
# Usage: PGHOST=... PGPORT=... PGUSER=postgres tests/database/milestone-stage-advance.sh
# Builds two scratch databases from the captured production schema baseline:
# one without and one with 20261104120100, runs the rolled-back scenario on
# both, and requires the stuck-at-new result before and the advanced result after.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
expected='unconfirmed_first_contact|new
confirmed_first_contact|contacted
after_first_contact|contacted
after_drawings|contacted
after_requirements|requirement_confirmed
after_all|quotation_submitted
stage_events|4
rerun|quotation_submitted
stage_events_after_rerun|4
gate_not_met|new
won_rerun|won
authenticated_can_execute|false'
for db in s3_stage_before_test s3_stage_after_test; do
  "${PSQL[@]}" -d postgres -c "drop database if exists $db" -c "create database $db"
  "${PSQL[@]}" -d "$db" -f "$ROOT/supabase/replay/00_platform_bootstrap.sql" >/dev/null
  "${PSQL[@]}" -d "$db" -1 -f "$ROOT/supabase/replay/production-schema-baseline.sql" >/dev/null
done
"${PSQL[@]}" -d s3_stage_after_test -f "$ROOT/supabase/migrations/20261104120100_milestone_completion_advances_lead_stage.sql" >/dev/null
"${PSQL[@]}" -d s3_stage_after_test -f "$ROOT/supabase/migrations/20261104120100_milestone_completion_advances_lead_stage.sql" >/dev/null 2>&1 # re-entry
before="$("${PSQL[@]}" -At -d s3_stage_before_test -f "$ROOT/tests/database/milestone-stage-advance.sql" 2>/dev/null || true)"
after="$("${PSQL[@]}" -At -d s3_stage_after_test -f "$ROOT/tests/database/milestone-stage-advance.sql")"
grep -qx 'after_all|new' <<<"$before" || { echo "FAIL: control did not reproduce the stuck stage"; exit 1; }
[ "$after" = "$expected" ] || { echo "FAIL: unexpected result"; diff <(echo "$expected") <(echo "$after"); exit 1; }
for db in s3_stage_before_test s3_stage_after_test; do "${PSQL[@]}" -d postgres -c "drop database $db"; done
echo "PASS milestone-stage-advance (before: stuck at new; after: advanced, idempotent, gated)"
