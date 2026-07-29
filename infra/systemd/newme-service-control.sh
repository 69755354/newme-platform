#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: newme-service-control <restart|reset-failed> <provenance-reason>" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
action=$1
reason=$2
case "$action" in
  restart|reset-failed) ;;
  *) usage ;;
esac
[[ "$reason" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,191}$ ]] || usage
[[ "$reason" =~ ^[A-Za-z0-9_.@:-]+\.(service|socket|timer|target|mount|path|slice)$ ]] && usage

if [ "$(id -u)" -ne 0 ]; then
  echo "newme-service-control must run as root" >&2
  exit 77
fi

actor=${SUDO_USER:-$(id -un)}
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
