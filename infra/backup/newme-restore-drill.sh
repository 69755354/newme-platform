#!/usr/bin/env bash
# Monthly restore drill (S7): prove the newest backup can really be restored.
# The restore goes into a THROWAWAY PostgreSQL 17 instance on this server that
# listens on a Unix socket only (no TCP port, no network connection of any kind),
# runs as the postgres system user, keeps its data directory in the service's
# private /tmp, and is stopped and deleted when the drill ends. Production data
# never leaves the server and no other database is involved.
#
#   newme-restore-drill.sh [--dry-run] [--backup FILE]
#
# Needs the PostgreSQL 17 server programs (apt install postgresql-17, without
# creating a cluster). Exit codes: 0 pass, 1 fail, 2 configuration or refusal.
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=newme-backup-lib.sh
. "${BACKUP_LIB:-$HERE/newme-backup-lib.sh}"

DRY_RUN=0; BACKUP_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; export BACKUP_DRY_RUN=1 ;;
    --backup) BACKUP_FILE="${2:-}"; shift ;;
    *) backup_die "unknown argument: $1" 2 ;;
  esac
  shift
done

# Alert settings first so that even a configuration failure alerts.
BACKUP_ALERT_SCRIPT="${BACKUP_ALERT_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
BACKUP_ALERT_KEY=db-restore-drill
WORK=""
STARTED_DB=0
DRILL_TOUCHED=0   # set once this run owns $DRILL_ROOT; dry runs and early refusals never delete anything
FAIL_LINE=""
DRILL_ROOT="${DRILL_ROOT:-/tmp/newme-drill}"      # private /tmp under the systemd unit
DATA="$DRILL_ROOT/data"
SOCK="$DRILL_ROOT/sock"                           # short path: socket paths are limited to 107 bytes
PG_PORT="${DRILL_PG_PORT:-5439}"                  # only names the socket file; nothing listens on TCP
PG_BIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"
PG_USER="${DRILL_PG_USER:-postgres}"
DB=drill

# Connections are only ever made through the local socket of our own instance.
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGUSER PGPASSWORD PGPORT PGOPTIONS PGPASSFILE PGSSLMODE
run_as_pg() { runuser -u "$PG_USER" -- "$@"; }
dpsql() { psql -h "$SOCK" -p "$PG_PORT" -U postgres -d "$DB" -qAt -v ON_ERROR_STOP=1 "$@"; }
adminpsql() { psql -h "$SOCK" -p "$PG_PORT" -U postgres -d postgres -qAt -v ON_ERROR_STOP=1 "$@"; }

# Stop the instance and delete everything, then PROVE it is gone: the data
# directory holds a full copy of production data (password hashes included).
teardown() {
  [ "$DRILL_TOUCHED" = 1 ] || return 0
  if [ "$STARTED_DB" = 1 ]; then
    run_as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || true
    STARTED_DB=0
  fi
  rm -rf -- "$DRILL_ROOT"
  if [ -e "$DRILL_ROOT" ]; then
    backup_log "CRITICAL: drill directory $DRILL_ROOT could not be removed"
    ALERTED=1
    send_alert failure "CRITICAL: restore drill directory $DRILL_ROOT still exists and holds a copy of production data; remove it by hand now"
    return 1
  fi
  return 0
}
cleanup_and_alert() {
  local rc=$?
  trap - EXIT
  teardown || { [ "$rc" -eq 0 ] && rc=1; }
  [ -n "$WORK" ] && rm -rf "$WORK"
  if [ "$rc" -ne 0 ] && [ "$ALERTED" != 1 ]; then
    ALERTED=1
    send_alert failure "monthly restore drill FAILED (exit $rc${FAIL_LINE:+, line $FAIL_LINE})"
  fi
  exit "$rc"
}
trap 'FAIL_LINE=$LINENO' ERR
trap cleanup_and_alert EXIT
trap 'exit 143' TERM INT HUP

ENV_FILE="${BACKUP_ENV_FILE:-/etc/newme/backup.env}"
if [ -r "$ENV_FILE" ]; then
  require_private "$ENV_FILE" "backup env file"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
BACKUP_DIR="${BACKUP_DIR:-/root/claude-ops-backups/db-daily}"
KEY_FILE="${BACKUP_KEY_FILE:-/etc/newme/backup-encryption.key}"
# Restore errors that are known to be harmless (matched after quoted names are
# replaced by "X"). The pass criterion is the per-table row count, not this list.
ALLOWED_ERRORS="${DRILL_ALLOWED_ERRORS:-schema \"X\" already exists}"
# Bootstrap that a plain PostgreSQL lacks: the Supabase roles referenced by the
# dump's policies, the extensions schema and the two extensions.
BOOTSTRAP_SQL='
do $b$ begin
  if not exists (select 1 from pg_roles where rolname = '"'"'anon'"'"') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = '"'"'authenticated'"'"') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = '"'"'service_role'"'"') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = '"'"'supabase_auth_admin'"'"') then create role supabase_auth_admin nologin; end if;
end $b$;
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;'

require_private "$KEY_FILE" "encryption key file"
for tool in pg_restore psql openssl sha256sum runuser; do
  command -v "$tool" >/dev/null 2>&1 || backup_die "required tool missing: $tool" 2
done
[ -x "$PG_BIN/initdb" ] && [ -x "$PG_BIN/pg_ctl" ] || backup_die "PostgreSQL 17 server programs not found in $PG_BIN (apt install postgresql-17, no cluster needed)" 2
[ "${#SOCK}" -le 90 ] || backup_die "socket directory path is too long: $SOCK" 2

if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE="$(ls -1t "$BACKUP_DIR"/newme-prod-*.dump.enc 2>/dev/null | head -1 || true)"
fi
[ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ] || backup_die "no backup file found in $BACKUP_DIR" 2
[ -f "$BACKUP_FILE.counts.tsv" ] && [ -f "$BACKUP_FILE.sha256" ] || backup_die "counts/checksum files missing next to the backup" 2

if [ "$DRY_RUN" = 1 ]; then
  backup_log "dry run: would verify checksum of $(basename "$BACKUP_FILE"), decrypt it, restore it into a throwaway local PostgreSQL 17 (socket only), compare $(wc -l < "$BACKUP_FILE.counts.tsv") table counts, then delete the instance"
  backup_log "dry run: configuration and backup files are valid"
  exit 0
fi

# Leftover from an earlier run that was killed outside a private /tmp.
DRILL_TOUCHED=1
if [ -e "$DRILL_ROOT" ]; then
  [ -f "$DATA/postmaster.pid" ] && run_as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf -- "$DRILL_ROOT"
fi
# Plaintext leftovers from a killed earlier run (SIGKILL skips every trap).
find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'newme-drill.*' -mmin +1440 -exec rm -rf -- {} + 2>/dev/null || true
WORK="$(mktemp -d "${TMPDIR:-/tmp}/newme-drill.XXXXXX")"
chmod 700 "$WORK"

( cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256" >/dev/null ) || backup_die "backup checksum mismatch" 1
STARTED="$(date +%s)"
decrypt_file "$BACKUP_FILE" "$WORK/restore.dump" "$KEY_FILE"

install -d -o "$PG_USER" -m 700 "$DRILL_ROOT" "$DATA" "$SOCK"
run_as_pg "$PG_BIN/initdb" -D "$DATA" -U postgres -A trust --no-sync >/dev/null
STARTED_DB=1
run_as_pg "$PG_BIN/pg_ctl" -D "$DATA" -w -s \
  -o "-c listen_addresses='' -k $SOCK -p $PG_PORT -c shared_buffers=128MB -c fsync=off -c full_page_writes=off -c max_connections=5" \
  start >/dev/null
adminpsql -c "create database $DB" >/dev/null

# Safety gate: the session must be a Unix-socket connection to OUR instance.
GOT_DIR="$(dpsql -c "select current_setting('data_directory')" 2>/dev/null || echo UNKNOWN)"
GOT_SOCKET="$(dpsql -c "select inet_server_addr() is null" 2>/dev/null || echo UNKNOWN)"
[ "$GOT_DIR" = "$DATA" ] && [ "$GOT_SOCKET" = t ] || backup_die "REFUSED: not connected to the throwaway local instance over its socket" 2

dpsql -c "$BOOTSTRAP_SQL" >/dev/null

RESTORE_LOG="$WORK/restore.log"
# pg_restore 17 continues past errors by default; no error option is passed.
pg_restore -h "$SOCK" -p "$PG_PORT" -U postgres -d "$DB" --no-owner --no-privileges "$WORK/restore.dump" >"$RESTORE_LOG" 2>&1 || true
ERRORS="$(grep -c '^pg_restore: error' "$RESTORE_LOG" || true)"
# Error categories with quoted names replaced, counted and logged; unknown ones are reported.
UNEXPECTED=0
if [ "$ERRORS" -gt 0 ]; then
  grep '^pg_restore: error' "$RESTORE_LOG" | sed -E 's/^.*ERROR: +//; s/"[^"]*"/"X"/g' | sort | uniq -c | while read -r n cat; do backup_log "restore error category (${n}x): $cat"; done
  while IFS= read -r category; do
    case "$ALLOWED_ERRORS" in *"$category"*) ;; *) UNEXPECTED=$((UNEXPECTED + 1)) ;; esac
  done < <(grep '^pg_restore: error' "$RESTORE_LOG" | sed -E 's/^.*ERROR: +//; s/"[^"]*"/"X"/g' | sort -u)
fi

FAILS=0
: > "$WORK/actual.tsv"
while IFS=$'\t' read -r table expected; do
  # Table names come from our own counts file; accept only plain identifiers.
  [[ "$table" =~ ^[a-z_]+\.[A-Za-z0-9_]+$ ]] || { backup_log "unexpected table name in counts file"; FAILS=$((FAILS + 1)); continue; }
  actual="$(dpsql -c "select count(*) from $table" 2>/dev/null || echo MISSING)"
  printf '%s\t%s\n' "$table" "$actual" >> "$WORK/actual.tsv"
  if [ "$actual" != "$expected" ]; then
    FAILS=$((FAILS + 1))
    backup_log "MISMATCH $table: backup=$expected restored=$actual"
  fi
done < "$BACKUP_FILE.counts.tsv"

ELAPSED=$(( $(date +%s) - STARTED ))
TABLES="$(wc -l < "$BACKUP_FILE.counts.tsv")"
if [ "$FAILS" -ne 0 ]; then
  ALERTED=1
  send_alert failure "monthly restore drill FAILED: $FAILS of $TABLES tables differ (restore errors: $ERRORS)"
  backup_log "DRILL FAILED: $FAILS of $TABLES tables differ, restore errors $ERRORS"
  exit 1
fi
# Delete the instance and prove it is gone before reporting success.
teardown || exit 1
: > "$BACKUP_DIR/.restore-drill-last-pass"; chmod 600 "$BACKUP_DIR/.restore-drill-last-pass"
backup_log "DRILL PASSED: $TABLES tables match, restore errors $ERRORS ($UNEXPECTED unexpected), ${ELAPSED}s"
if [ "$UNEXPECTED" -gt 0 ]; then
  ALERTED=1
  send_alert failure "restore drill: all $TABLES table counts match, but $UNEXPECTED unexpected restore error categories; see journal unit newme-restore-drill"
  exit 0
fi
send_alert recovery "monthly restore drill passed: $TABLES tables match in ${ELAPSED}s"
exit 0
