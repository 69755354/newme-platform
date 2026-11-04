#!/usr/bin/env bash
# Monthly restore drill (S7 item 7): prove a backup can really be restored, into a
# throwaway database on the STAGING Supabase project. It never touches production
# and never touches the staging project's own databases: it creates a scratch
# database, restores into it, compares every table's row count with the count
# recorded at backup time, and drops the scratch database again.
#
#   newme-restore-drill.sh [--dry-run] [--backup FILE]
#
# Exit codes: 0 pass, 1 fail, 2 configuration or safety refusal.
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

# Alert settings first so that even a configuration or safety refusal alerts.
BACKUP_ALERT_SCRIPT="${BACKUP_ALERT_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
BACKUP_ALERT_KEY=db-restore-drill
WORK=""
SCRATCH_CREATED=0
SCRATCH_DB="drill_$(date -u +%Y%m%d%H%M%S)"
FAIL_LINE=""

# Drop the scratch database and PROVE it is gone. A leftover would be a full copy
# of production data (including password hashes) sitting in the staging project.
drop_scratch() {
  [ "$SCRATCH_CREATED" = 1 ] || return 0
  psql "service=newme" -qAt -c "drop database if exists \"$SCRATCH_DB\" with (force)" >/dev/null 2>&1 || true
  local left
  left="$(psql "service=newme" -qAt -c "select count(*) from pg_database where datname = '$SCRATCH_DB'" 2>/dev/null || echo UNKNOWN)"
  if [ "$left" != 0 ]; then
    backup_log "CRITICAL: scratch database $SCRATCH_DB still exists on the staging project"
    ALERTED=1
    send_alert failure "CRITICAL: restore drill scratch database $SCRATCH_DB still exists on the STAGING project and holds a copy of production data; drop it by hand now"
    return 1
  fi
  return 0
}
cleanup_and_alert() {
  local rc=$?
  trap - EXIT
  drop_scratch || { [ "$rc" -eq 0 ] && rc=1; }
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

ENV_FILE=
if [ -r "$ENV_FILE" ]; then
  require_private "$ENV_FILE" "backup env file"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
BACKUP_DIR="${BACKUP_DIR:-/root/claude-ops-backups/db-daily}"
KEY_FILE="${BACKUP_KEY_FILE:-/etc/newme/backup-encryption.key}"
STAGING_URL_FILE="${STAGING_DB_URL_FILE:-/etc/newme/staging-db.url}"
STAGING_REF="${STAGING_PROJECT_REF:-bfsiibofuzoglziltgyd}"
PROD_REF="${PROD_PROJECT_REF:-vfopmpxlhwzpxqegayew}"
DRILL_EXTENSIONS="${DRILL_EXTENSIONS:-pgcrypto uuid-ossp pg_trgm}"

require_private "$STAGING_URL_FILE" "staging database URL file"
require_private "$KEY_FILE" "encryption key file"
for tool in pg_restore psql openssl sha256sum python3; do
  command -v "$tool" >/dev/null 2>&1 || backup_die "required tool missing: $tool" 2
done

# Safety gate 1: decided on what libpq will really connect to (URL parsed, percent-
# decoded, lower-cased), not on the raw text. See check_staging_target in the lib.
VERDICT="$(check_staging_target "$STAGING_URL_FILE" "$STAGING_REF" "$PROD_REF")" || VERDICT="REFUSED:could not parse the URL"
[ "$VERDICT" = OK ] || backup_die "REFUSED: target is not the staging project (${VERDICT#REFUSED:})" 2

if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE="$(ls -1t "$BACKUP_DIR"/newme-prod-*.dump.enc 2>/dev/null | head -1 || true)"
fi
[ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ] || backup_die "no backup file found in $BACKUP_DIR" 2
[ -f "$BACKUP_FILE.counts.tsv" ] && [ -f "$BACKUP_FILE.sha256" ] || backup_die "counts/checksum files missing next to the backup" 2

if [ "$DRY_RUN" = 1 ]; then
  backup_log "dry run: would verify checksum of $(basename "$BACKUP_FILE"), decrypt it, restore into scratch database $SCRATCH_DB on the staging project, compare $(wc -l < "$BACKUP_FILE.counts.tsv") table counts, then drop the scratch database"
  backup_log "dry run: configuration, target safety and backup files are valid"
  exit 0
fi

# Plaintext leftovers from a killed earlier run (SIGKILL skips every trap).
find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'newme-drill.*' -mmin +1440 -exec rm -rf -- {} + 2>/dev/null || true
WORK="$(mktemp -d "${TMPDIR:-/tmp}/newme-drill.XXXXXX")"
chmod 700 "$WORK"
SERVICE_FILE="$WORK/pg_service.conf"
write_pg_service "$STAGING_URL_FILE" "$SERVICE_FILE" >/dev/null
export PGSERVICEFILE="$SERVICE_FILE" PGCONNECT_TIMEOUT=20

( cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256" >/dev/null ) || backup_die "backup checksum mismatch" 1
STARTED="$(date +%s)"
decrypt_file "$BACKUP_FILE" "$WORK/restore.dump" "$KEY_FILE"

SCRATCH_CREATED=1
psql "service=newme" -qAt -c "create database \"$SCRATCH_DB\"" >/dev/null
cat >> "$SERVICE_FILE" <<SVC

[scratch]
$(sed -n '2,7p' "$SERVICE_FILE" | sed -E "s/^dbname=.*/dbname=$SCRATCH_DB/")
SVC
# Safety gate 2: the session must really be inside the scratch database we just
# created, otherwise nothing is restored.
CONNECTED_DB="$(psql "service=scratch" -qAt -c "select current_database()" 2>/dev/null || echo UNKNOWN)"
[ "$CONNECTED_DB" = "$SCRATCH_DB" ] || backup_die "REFUSED: connected database is not the scratch database" 2
psql "service=scratch" -qAt -c "create schema if not exists extensions" >/dev/null
for ext in $DRILL_EXTENSIONS; do
  psql "service=scratch" -qAt -c "create extension if not exists \"$ext\" with schema extensions" >/dev/null 2>&1 || backup_log "extension $ext unavailable (continuing)"
done
RESTORE_LOG="$WORK/restore.log"
# pg_restore 17 continues past errors by default (-e / --exit-on-error takes no
# argument and would stop at the first one), so no error option is passed.
pg_restore --dbname="service=scratch" --no-owner --no-privileges "$WORK/restore.dump" >"$RESTORE_LOG" 2>&1 || true
ERRORS="$(grep -c '^pg_restore: error' "$RESTORE_LOG" || true)"

FAILS=0
: > "$WORK/actual.tsv"
while IFS=$'\t' read -r table expected; do
  # Table names come from our own counts file; accept only plain identifiers.
  [[ "$table" =~ ^[a-z_]+\.[A-Za-z0-9_]+$ ]] || { backup_log "unexpected table name in counts file"; FAILS=$((FAILS + 1)); continue; }
  actual="$(psql "service=scratch" -qAt -c "select count(*) from $table" 2>/dev/null || echo MISSING)"
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
backup_log "DRILL PASSED: $TABLES tables match, restore errors $ERRORS, ${ELAPSED}s"
# Leave through the EXIT handler: it drops the scratch database, proves it is gone
# and only then lets a passing drill report success.
DRILL_PASSED_MSG="monthly restore drill passed: $TABLES tables match in ${ELAPSED}s"
drop_scratch || exit 1
SCRATCH_CREATED=0
send_alert recovery "$DRILL_PASSED_MSG"
exit 0
