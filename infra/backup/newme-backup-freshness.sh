#!/usr/bin/env bash
# Backup freshness check (S7 review must-fix 4): alert when the newest finished
# backup is older than MAX_AGE_HOURS (default 26) or there is none; also checks the
# weekly restore drill, the NAS push and (optionally) the NAS pull. This catches
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
# Weekly drill (newme-restore-drill.timer). The pass stamp must be at most DRILL_MAX_DAYS (default 9) old. A MISSING
# stamp raises an alert (the unit stays green) from DRILL_REQUIRED_FROM on (UTC date, default 2026-12-01; the grace covers installing the server
# package and the first weekly run), or at once with DRILL_REQUIRED=1. Before the grace date a missing stamp is only
# logged. (Audit 2026-11-20 F3: a missing stamp used to skip the check for good, so a drill that never ran never alerted.)
DRILL_STAMP="$BACKUP_DIR/.restore-drill-last-pass"
DRILL_MAX_DAYS="${DRILL_MAX_DAYS:-9}"
DRILL_REQUIRED_FROM="${DRILL_REQUIRED_FROM:-2026-12-01}"
case "$DRILL_MAX_DAYS" in ''|*[!0-9]*) backup_die "DRILL_MAX_DAYS must be a number" 2;; esac
[[ "$DRILL_REQUIRED_FROM" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || backup_die "DRILL_REQUIRED_FROM must be a date YYYY-MM-DD" 2
TODAY="$(date -u +%Y-%m-%d)"
DRILL_DUE=0
if [ "${DRILL_REQUIRED:-0}" = 1 ] || ! [[ "$TODAY" < "$DRILL_REQUIRED_FROM" ]]; then DRILL_DUE=1; fi
if [ -f "$DRILL_STAMP" ] || [ "$DRILL_DUE" = 1 ]; then
  BACKUP_ALERT_KEY=db-restore-drill-freshness
  if [ ! -f "$DRILL_STAMP" ]; then
    # Alert under the drill key only; the unit stays green (like the NAS checks below), otherwise OnFailure would send
    # a second message under another key every hour.
    DRILL_PROBLEM="no restore drill has passed yet (required since $DRILL_REQUIRED_FROM); check newme-restore-drill.timer and that postgresql-17 is installed"
    backup_log "ERROR: $DRILL_PROBLEM"
    send_alert failure "$DRILL_PROBLEM"
  else
    DRILL_AGE_DAYS=$(( ( $(date +%s) - $(stat -c '%Y' "$DRILL_STAMP") ) / 86400 ))
    if [ "$DRILL_AGE_DAYS" -gt "$DRILL_MAX_DAYS" ]; then
      backup_die "the last passing restore drill is $DRILL_AGE_DAYS days old (limit $DRILL_MAX_DAYS); the weekly drill did not run or keeps failing" 1
    fi
    send_alert recovery "restore drill is fresh (${DRILL_AGE_DAYS}d old)"
  fi
  BACKUP_ALERT_KEY=db-backup-freshness
else
  backup_log "NOTE: no restore drill has passed yet; this becomes a failure on $DRILL_REQUIRED_FROM"
fi
# NAS push (newme-nas-push.timer, daily): checked whenever the push is installed (its state directory exists) or
# NAS_PUSH_REQUIRED=1. last-ok older than NAS_PUSH_MAX_AGE_HOURS (default 26) or missing raises an alert under its own
# key and, like the NAS pull below, does not fail the unit (that would send a second message under another key).
NAS_PUSH_DIR="${NAS_PUSH_STATE_DIR:-/var/lib/newme-nas-push}"
if [ -d "$NAS_PUSH_DIR" ] || [ "${NAS_PUSH_REQUIRED:-0}" = 1 ]; then
  PUSH_MAX_HOURS="${NAS_PUSH_MAX_AGE_HOURS:-26}"
  case "$PUSH_MAX_HOURS" in ''|*[!0-9]*) backup_die "NAS_PUSH_MAX_AGE_HOURS must be a number" 2;; esac
  BACKUP_ALERT_KEY=nas-push-freshness
  PUSH_PROBLEM=""
  if [ ! -f "$NAS_PUSH_DIR/last-ok" ]; then
    PUSH_PROBLEM="the backup has never been pushed to the NAS successfully (no $NAS_PUSH_DIR/last-ok)"
  else
    PUSH_AGE_HOURS=$(( ( $(date +%s) - $(stat -c '%Y' "$NAS_PUSH_DIR/last-ok") ) / 3600 ))
    if [ "$PUSH_AGE_HOURS" -gt "$PUSH_MAX_HOURS" ]; then
      PUSH_PROBLEM="the last successful NAS push is $PUSH_AGE_HOURS hours old (limit ${PUSH_MAX_HOURS}); see journalctl -u newme-nas-push"
    fi
  fi
  if [ -n "$PUSH_PROBLEM" ]; then
    backup_log "ERROR: $PUSH_PROBLEM"
    send_alert failure "$PUSH_PROBLEM"
  else
    send_alert recovery "the NAS push succeeded ${PUSH_AGE_HOURS}h ago"
  fi
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
# Recovery only after every fatal check above has passed: a stale drill fails the unit (OnFailure opens this same
# key), so clearing it earlier would flap failure -> recovery -> failure every hour.
send_alert recovery "database backup is fresh ($(( AGE_SECONDS / 3600 ))h old)"
backup_log "OK: newest backup $(basename "$NEWEST") is $(( AGE_SECONDS / 3600 )) hours old"
exit 0
