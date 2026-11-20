#!/usr/bin/env bash
# Run by systemd (OnFailure=newme-backup-alert@%n.service) when a backup or drill
# unit ends in failure -- including cases the script itself cannot report: killed
# by the timeout or the OOM killer, or unable to start at all.
#   newme-backup-onfailure.sh <failed-unit-name>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=newme-backup-lib.sh
. "${BACKUP_LIB:-$HERE/newme-backup-lib.sh}"
BACKUP_ALERT_SCRIPT="${BACKUP_ALERT_SCRIPT:-/usr/local/libexec/newme/newme-whatsapp-alert.sh}"
unit="${1:-unknown}"
case "$unit" in
  newme-db-backup.service) BACKUP_ALERT_KEY=db-backup ;;
  newme-restore-drill.service) BACKUP_ALERT_KEY=db-restore-drill ;;
  newme-backup-freshness.service) BACKUP_ALERT_KEY=db-backup-freshness ;;
  newme-nas-push.service) BACKUP_ALERT_KEY=nas-push ;;
  *) BACKUP_ALERT_KEY=db-backup ;;
esac
# Unit names are ours; keep only safe characters in the alert text.
safe="$(printf '%s' "$unit" | tr -cd 'A-Za-z0-9_.@-')"
send_alert failure "systemd unit $safe ended in failure (see: journalctl -u $safe)"
# An alert that reached nobody must not look like success (audit 2026-11-20 F6).
if [ "$ALERT_FAILED" = 1 ]; then
  backup_log "ERROR: the failure of $safe was not delivered to anyone (see alerts.log)"
  exit 1
fi
exit 0
