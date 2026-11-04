#!/usr/bin/env bash
# Backup freshness check (S7 review must-fix 4): alert when the newest finished
# backup is older than MAX_AGE_HOURS (default 26) or there is none. This catches
# a timer that never fired, which no in-script alert can notice.
#
#   newme-backup-freshness.sh        run hourly (newme-backup-freshness.timer)
#
# Exit codes: 0 fresh, 1 stale or missing, 2 configuration.
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=newme-backup-lib.sh
. "${BACKUP_LIB:-$HERE/newme-backup-lib.sh}"

BACKUP_ALERT_SCRIPT="${BACKUP_ALERT_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
BACKUP_ALERT_KEY=db-backup-freshness
ENV_FILE="${BACKUP_ENV_FILE:-/etc/newme/backup.env}"
if [ -r "$ENV_FILE" ]; then
  require_private "$ENV_FILE" "backup env file"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
BACKUP_DIR="${BACKUP_DIR:-/root/claude-ops-backups/db-daily}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
case "$MAX_AGE_HOURS" in ''|*[!0-9]*) backup_die "MAX_AGE_HOURS must be a number" 2;; esac

# Finished artefacts only: *.dump.enc (the .part file is renamed on success) that
# also have their checksum file.
NEWEST=""
for f in $(ls -1t "$BACKUP_DIR"/newme-prod-*.dump.enc 2>/dev/null || true); do
  if [ -f "$f.sha256" ]; then NEWEST="$f"; break; fi
done
[ -n "$NEWEST" ] || backup_die "no finished database backup found in $BACKUP_DIR" 1

AGE_SECONDS=$(( $(date +%s) - $(stat -c '%Y' "$NEWEST") ))
if [ "$AGE_SECONDS" -gt $(( MAX_AGE_HOURS * 3600 )) ]; then
  backup_die "newest database backup is $(( AGE_SECONDS / 3600 )) hours old (limit ${MAX_AGE_HOURS}); the daily backup did not run or keeps failing" 1
fi
backup_log "OK: newest backup $(basename "$NEWEST") is $(( AGE_SECONDS / 3600 )) hours old"
send_alert recovery "database backup is fresh ($(( AGE_SECONDS / 3600 ))h old)"
exit 0
