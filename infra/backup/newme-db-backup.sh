#!/usr/bin/env bash
# Daily encrypted logical backup of the production database (S7 item 7).
# Read-only against production: pg_dump only. Output is encrypted before it is
# kept; the plaintext exists only in a 0700 work directory and is removed on exit.
#
#   newme-db-backup.sh [--dry-run]
#
# Config file (BACKUP_ENV_FILE, default /etc/newme/backup.env, root:root 0600).
# See backup.env.example. Exit codes: 0 ok, 1 backup failed, 2 configuration,
# 3 local backup fine but the NAS copy failed.
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=newme-backup-lib.sh
. "${BACKUP_LIB:-$HERE/newme-backup-lib.sh}"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
export BACKUP_DRY_RUN="$DRY_RUN"
# Alert settings come first so that even a configuration failure (missing key or
# URL file, bad permissions) reaches the alert channel; the env file may override.
BACKUP_ALERT_SCRIPT="${BACKUP_ALERT_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
BACKUP_ALERT_KEY=db-backup
WORK=""
FAIL_LINE=""
cleanup_and_alert() {
  local rc=$?
  trap - EXIT
  [ -n "$WORK" ] && rm -rf "$WORK"
  if [ "$rc" -ne 0 ] && [ "$ALERTED" != 1 ]; then
    ALERTED=1
    send_alert failure "database backup failed (exit $rc${FAIL_LINE:+, line $FAIL_LINE}; see journal unit newme-db-backup)"
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
DB_URL_FILE="${NEWME_DB_URL_FILE:-/etc/newme/migration-db.url}"
BACKUP_DIR="${BACKUP_DIR:-/root/claude-ops-backups/db-daily}"
KEY_FILE="${BACKUP_KEY_FILE:-/etc/newme/backup-encryption.key}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
KEEP_MIN="${KEEP_MIN:-7}"
SYNC_TARGET="${SYNC_TARGET:-}"
SYNC_SSH_KEY="${SYNC_SSH_KEY:-}"
STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
MIN_PLAIN_BYTES="${MIN_PLAIN_BYTES:-100000}"

case "$RETENTION_DAYS" in ''|*[!0-9]*) backup_die "RETENTION_DAYS must be a number" 2;; esac
require_private "$DB_URL_FILE" "database URL file"
require_private "$KEY_FILE" "encryption key file"
[ "$(wc -c < "$KEY_FILE")" -ge 32 ] || backup_die "encryption key file must hold at least 32 bytes" 2
for tool in pg_dump pg_restore openssl sha256sum python3; do
  command -v "$tool" >/dev/null 2>&1 || backup_die "required tool missing: $tool" 2
done
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
[ "$(stat -c '%a' "$BACKUP_DIR")" = 700 ] || backup_die "backup dir must be mode 700: $BACKUP_DIR" 2

if [ "$DRY_RUN" = 1 ]; then
  backup_log "dry run: would dump production (schemas public, auth, supabase_migrations) to $BACKUP_DIR/newme-prod-$STAMP.dump.enc"
  backup_log "dry run: retention ${RETENTION_DAYS} days (keep at least ${KEEP_MIN}); NAS sync: ${SYNC_TARGET:-not configured}"
  backup_log "dry run: configuration and permissions are valid"
  exit 0
fi

# A SIGKILL (timeout, out of memory) skips every trap and leaves a plaintext dump in
# .work.* and a half-written .part file behind. Clear anything older than a day
# (a live run never takes that long) before starting.
find "$BACKUP_DIR" -maxdepth 1 -type d -name '.work.*' -mmin +1440 -exec rm -rf -- {} + 2>/dev/null || true
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.part' -mmin +1440 -delete 2>/dev/null || true

WORK="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"

SERVICE_FILE="$WORK/pg_service.conf"
write_pg_service "$DB_URL_FILE" "$SERVICE_FILE" >/dev/null
export PGSERVICEFILE="$SERVICE_FILE" PGCONNECT_TIMEOUT=20

PLAIN="$WORK/plain.dump"
# auth sessions/tokens are re-creatable and large; accounts, identities and MFA are kept.
pg_dump "service=newme" --format=custom --no-owner --no-privileges \
  --schema=public --schema=auth --schema=supabase_migrations \
  --exclude-table-data='auth.refresh_tokens' --exclude-table-data='auth.sessions' \
  --exclude-table-data='auth.one_time_tokens' --exclude-table-data='auth.audit_log_entries' \
  --file="$PLAIN"
[ "$(stat -c '%s' "$PLAIN")" -ge "$MIN_PLAIN_BYTES" ] || backup_die "dump is suspiciously small" 1

OUT="$BACKUP_DIR/newme-prod-$STAMP.dump.enc"
table_counts "$PLAIN" > "$WORK/counts.tsv"
[ -s "$WORK/counts.tsv" ] || backup_die "dump has no table data" 1
encrypt_file "$PLAIN" "$OUT.part" "$KEY_FILE"

# Prove the encrypted artefact is usable before trusting it.
decrypt_file "$OUT.part" "$WORK/verify.dump" "$KEY_FILE"
pg_restore --list "$WORK/verify.dump" >/dev/null
[ "$(table_counts "$WORK/verify.dump" | sha256sum)" = "$(sha256sum < "$WORK/counts.tsv")" ] || backup_die "verification counts differ" 1

mv "$OUT.part" "$OUT"
cp "$WORK/counts.tsv" "$OUT.counts.tsv"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
chmod 600 "$OUT" "$OUT.counts.tsv" "$OUT.sha256"
backup_log "backup written: $(basename "$OUT") ($(stat -c '%s' "$OUT") bytes, $(wc -l < "$OUT.counts.tsv") tables)"

# Retention: drop artefacts older than RETENTION_DAYS but always keep KEEP_MIN newest.
mapfile -t ALL < <(ls -1t "$BACKUP_DIR"/newme-prod-*.dump.enc 2>/dev/null || true)
if [ "${#ALL[@]}" -gt "$KEEP_MIN" ]; then
  for old in "${ALL[@]:$KEEP_MIN}"; do
    if [ -n "$(find "$old" -mtime "+$RETENTION_DAYS" -print 2>/dev/null)" ]; then
      rm -f -- "$old" "$old.counts.tsv" "$old.sha256"
      backup_log "pruned $(basename "$old")"
    fi
  done
fi

SYNC_RC=0
if [ -n "$SYNC_TARGET" ]; then
  command -v rsync >/dev/null 2>&1 || backup_die "rsync is required for SYNC_TARGET" 2
  SSH_CMD="ssh -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=yes"
  [ -n "$SYNC_SSH_KEY" ] && SSH_CMD="$SSH_CMD -i $SYNC_SSH_KEY"
  if rsync -a --partial --timeout=120 -e "$SSH_CMD" "$OUT" "$OUT.counts.tsv" "$OUT.sha256" "$SYNC_TARGET/"; then
    backup_log "NAS copy delivered to configured target"
  else
    SYNC_RC=3
    backup_log "NAS copy FAILED (local backup is intact)"
  fi
fi

if [ "$SYNC_RC" -ne 0 ]; then
  ALERTED=1
  send_alert failure "database backup is stored locally but the NAS copy failed"
  exit "$SYNC_RC"
fi
send_alert recovery "database backup completed ($(basename "$OUT"))"
exit 0
