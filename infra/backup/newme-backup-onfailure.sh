#!/usr/bin/env bash
# Run by systemd (OnFailure=newme-backup-alert@%n.service) when a backup or drill
# unit ends in failure -- including cases the script itself cannot report: killed
# by the timeout or the OOM killer, or unable to start at all.
#   newme-backup-onfailure.sh <failed-unit-name>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=newme-backup-lib.sh
. "${BACKUP_LIB:-$HERE/newme-backup-lib.sh}"
BACKUP_ALERT_SCRIPT="${BACKUP_ALERT_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
unit="${1:-unknown}"
case "$unit" in
  newme-db-backup.service) BACKUP_ALERT_KEY=db-backup ;;
  newme-restore-drill.service) BACKUP_ALERT_KEY=db-restore-drill ;;
  newme-backup-freshness.service) BACKUP_ALERT_KEY=db-backup-freshness ;;
  *) BACKUP_ALERT_KEY=db-backup ;;
esac
# Unit names are ours; keep only safe characters in the alert text.
safe="$(printf '%s' "$unit" | tr -cd 'A-Za-z0-9_.@-')"
send_alert failure "systemd unit $safe ended in failure (see: journalctl -u $safe)"
exit 0
