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

BACKUP_ALERT_SCRIPT="${BACKUP_ALERT_SCRIPT:-/usr/local/libexec/newme/newme-whatsapp-alert.sh}"
BACKUP_ALERT_KEY=db-backup-freshness
ENV_FILE="${BACKUP_ENV_FILE:-/etc/newme/backup.env}"
if [ -r "$ENV_FILE" ]; then
  require_private "$ENV_FILE" "backup env file"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
BACKUP_DIR="${BACKUP_DIR:-/var/backups/newme-db}"
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
# The local backup is fresh: say so now, before the drill and NAS checks, which may exit early.
send_alert recovery "database backup is fresh ($(( AGE_SECONDS / 3600 ))h old)"
# Monthly drill: when a pass stamp exists (or DRILL_REQUIRED=1), it must be <= 35 days old.
DRILL_STAMP="$BACKUP_DIR/.restore-drill-last-pass"
DRILL_MAX_DAYS="${DRILL_MAX_DAYS:-35}"
if [ -f "$DRILL_STAMP" ] || [ "${DRILL_REQUIRED:-0}" = 1 ]; then
  BACKUP_ALERT_KEY=db-restore-drill-freshness
  if [ ! -f "$DRILL_STAMP" ]; then
    backup_die "no restore drill has passed yet (DRILL_REQUIRED=1)" 1
  fi
  DRILL_AGE_DAYS=$(( ( $(date +%s) - $(stat -c '%Y' "$DRILL_STAMP") ) / 86400 ))
  if [ "$DRILL_AGE_DAYS" -gt "$DRILL_MAX_DAYS" ]; then
    backup_die "the last passing restore drill is $DRILL_AGE_DAYS days old (limit $DRILL_MAX_DAYS); the monthly drill did not run or keeps failing" 1
  fi
  send_alert recovery "restore drill is fresh (${DRILL_AGE_DAYS}d old)"
  BACKUP_ALERT_KEY=db-backup-freshness
fi
# NAS pull (S17): once NAS_PULL_REQUIRED=1, the NAS must have finished a pull recently. The forced
# command (newme-nas-rsync-ro.sh) stamps last-pull-ok after every successful read-only rsync.
if [ "${NAS_PULL_REQUIRED:-0}" = 1 ]; then
  NAS_STAMP="${NAS_PULL_STATE_DIR:-/var/lib/newme-nas-pull/state}/last-pull-ok"
  NAS_MAX_HOURS="${NAS_PULL_MAX_AGE_HOURS:-30}"
  case "$NAS_MAX_HOURS" in ''|*[!0-9]*) backup_die "NAS_PULL_MAX_AGE_HOURS must be a number" 2;; esac
  # A NAS problem is reported under its own key and does NOT fail the unit: a failing unit would trigger
  # OnFailure with a different key and send a second message for the same problem every hour.
  BACKUP_ALERT_KEY=nas-pull-freshness
  NAS_PROBLEM=""
  if [ ! -f "$NAS_STAMP" ]; then
    NAS_PROBLEM="the NAS has never completed a pull (NAS_PULL_REQUIRED=1)"
  else
    NAS_AGE_HOURS=$(( ( $(date +%s) - $(stat -c '%Y' "$NAS_STAMP") ) / 3600 ))
    if [ "$NAS_AGE_HOURS" -gt "$NAS_MAX_HOURS" ]; then
      NAS_PROBLEM="the NAS has not pulled the backup for $NAS_AGE_HOURS hours (limit ${NAS_MAX_HOURS}); check the NAS scheduled task, its network and its key"
    fi
  fi
  if [ -n "$NAS_PROBLEM" ]; then
    backup_log "ERROR: $NAS_PROBLEM"
    send_alert failure "$NAS_PROBLEM"
  else
    send_alert recovery "the NAS pulled the backup ${NAS_AGE_HOURS}h ago"
  fi
  BACKUP_ALERT_KEY=db-backup-freshness
fi
backup_log "OK: newest backup $(basename "$NEWEST") is $(( AGE_SECONDS / 3600 )) hours old"
exit 0
