#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "newme-service-control must run as root" >&2
  exit 77
fi

action=${1:-}
reason=${2:-}
case "$action" in
  start|stop|restart|try-restart|reset-failed) ;;
  *) echo "usage: newme-service-control <start|stop|restart|try-restart|reset-failed> <reason>" >&2; exit 64 ;;
esac
if [ -z "$reason" ]; then
  echo "a non-empty provenance reason is required" >&2
  exit 64
fi

actor=${SUDO_USER:-$(id -un)}
reason=${reason//$'\n'/ }
reason=${reason//$'\r'/ }
release=$(readlink -f /opt/newme/current 2>/dev/null || echo unavailable)
build_id=$(cat /opt/newme/current/.next/BUILD_ID 2>/dev/null || echo unavailable)
manifest_sha256=$(sha256sum /opt/newme/current/manifest.json 2>/dev/null | awk '{print $1}' || echo unavailable)

/usr/bin/logger --journald <<EOF
MESSAGE=newme service control request
PRIORITY=5
SYSLOG_IDENTIFIER=newme-service-control
NEWME_ACTION=$action
NEWME_UNIT=newme-platform.service
NEWME_ACTOR=$actor
NEWME_REASON=$reason
NEWME_RELEASE=$release
NEWME_BUILD_ID=$build_id
NEWME_MANIFEST_SHA256=$manifest_sha256
EOF

exec /usr/bin/systemctl "$action" newme-platform.service
