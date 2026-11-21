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
# Alert key (the state the repeat/recovery logic is keyed on) and the plain-words name shown in the message. The four backup
# keys are unchanged. Every other unit that uses newme-backup-alert@ gets its own key (its unit name) so a failing sync no
# longer shares, or closes, the database backup's alert state.
case "$unit" in
  newme-db-backup.service) BACKUP_ALERT_KEY=db-backup; name="数据库备份" ;;
  newme-restore-drill.service) BACKUP_ALERT_KEY=db-restore-drill; name="备份恢复演练" ;;
  newme-backup-freshness.service) BACKUP_ALERT_KEY=db-backup-freshness; name="备份新鲜度检查" ;;
  newme-nas-push.service) BACKUP_ALERT_KEY=nas-push; name="备份上传 NAS" ;;
  newme-os-drive-sync.service) BACKUP_ALERT_KEY=newme-os-drive-sync; name="表格同步" ;;
  newme-os-drive-reconcile.service) BACKUP_ALERT_KEY=newme-os-drive-reconcile; name="表格对账" ;;
  newme-drive-sync.service) BACKUP_ALERT_KEY=newme-drive-sync; name="表格回读" ;;
  newme-meta-ids-export.service) BACKUP_ALERT_KEY=newme-meta-ids-export; name="广告编号导出" ;;
  *) BACKUP_ALERT_KEY="" ; name="" ;;
esac
# Unit names are ours; keep only safe characters in the alert text and key.
safe="$(printf '%s' "$unit" | tr -cd 'A-Za-z0-9_.@-')"
if [ -z "$BACKUP_ALERT_KEY" ]; then
  # A unit this script does not know yet: its own name is the key and the label (never the database backup's key).
  base="${safe%.service}"
  BACKUP_ALERT_KEY="${base:-unknown}"
  name="$safe"
fi
send_alert failure "$name（systemd 单元 $safe）运行失败，查看：journalctl -u $safe"
# An alert that reached nobody must not look like success (audit 2026-11-20 F6).
if [ "$ALERT_FAILED" = 1 ]; then
  backup_log "ERROR: the failure of $safe was not delivered to anyone (see alerts.log)"
  exit 1
fi
exit 0
