#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "newme-production-rollback must run as root" >&2
  exit 77
fi
exec 9>/run/lock/newme-production-release.lock
flock -n 9 || {
  echo "another production release operation is active" >&2
  exit 69
}

action=${1:-}
case "$action" in
  status)
    [ "$#" -eq 1 ] || { echo "usage: newme-production-rollback status" >&2; exit 64; }
    current=$(readlink -f /opt/newme/current)
    rollback=$(readlink -f /opt/newme/current.rollback)
    printf 'current=%s\nrollback=%s\nservice=%s\nhealth_http=%s\n' \
      "$current" \
      "$rollback" \
      "$(systemctl is-active newme-platform.service)" \
      "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3001/api/health || true)"
    ;;
  execute)
    [ "$#" -eq 2 ] && [ -n "$2" ] || {
      echo "usage: newme-production-rollback execute <reason>" >&2
      exit 64
    }
    reason=${2//$'\n'/ }
    reason=${reason//$'\r'/ }
    current=$(readlink -f /opt/newme/current)
    rollback=$(readlink -f /opt/newme/current.rollback)
    for release in "$current" "$rollback"; do
      case "$release" in
        /opt/newme/releases/*) ;;
        *) echo "release outside approved root: $release" >&2; exit 65 ;;
      esac
      [ -d "$release" ] && [ -f "$release/.newme-protect" ] && [ -f "$release/.next/BUILD_ID" ] || {
        echo "release is not protected and complete: $release" >&2
        exit 66
      }
    done
    [ "$current" != "$rollback" ] || {
      echo "current and rollback are identical" >&2
      exit 67
    }

    old_current=$current
    old_rollback=$rollback
    restore() {
      ln -sfn "releases/$(basename "$old_current")" /opt/newme/current.restore
      mv -Tf /opt/newme/current.restore /opt/newme/current
      ln -sfn "releases/$(basename "$old_rollback")" /opt/newme/current.rollback.restore
      mv -Tf /opt/newme/current.rollback.restore /opt/newme/current.rollback
      /usr/local/sbin/newme-service-control restart \
        "automatic rollback recovery: candidate verification failed" || true
    }
    trap 'rc=$?; if [ $rc -ne 0 ]; then restore; fi; exit $rc' EXIT

    ln -sfn "releases/$(basename "$rollback")" /opt/newme/current.rollback-candidate
    mv -Tf /opt/newme/current.rollback-candidate /opt/newme/current
    ln -sfn "releases/$(basename "$current")" /opt/newme/rollback.previous-current
    mv -Tf /opt/newme/rollback.previous-current /opt/newme/current.rollback
    /usr/local/sbin/newme-service-control restart "production rollback: $reason"

    health=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
      http://127.0.0.1:3001/api/health || true)
    auth=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
      http://127.0.0.1:3001/api/auth/me || true)
    [ "$health" = 200 ] \
      && [ "$auth" = 401 ] \
      && [ "$(systemctl is-active newme-platform.service)" = active ] || {
        echo "rollback target failed verification health=$health auth=$auth" >&2
        exit 68
      }

    trap - EXIT
    /usr/bin/logger --journald <<EOF
MESSAGE=newme production rollback completed
PRIORITY=5
SYSLOG_IDENTIFIER=newme-production-rollback
NEWME_ACTOR=${SUDO_USER:-$(id -un)}
NEWME_REASON=$reason
NEWME_CURRENT=$(readlink -f /opt/newme/current)
NEWME_ROLLBACK=$(readlink -f /opt/newme/current.rollback)
EOF
    printf 'current=%s\nrollback=%s\nhealth_http=%s\nauth_http=%s\n' \
      "$(readlink -f /opt/newme/current)" \
      "$(readlink -f /opt/newme/current.rollback)" \
      "$health" \
      "$auth"
    ;;
  *)
    echo "usage: newme-production-rollback <status|execute> [reason]" >&2
    exit 64
    ;;
esac
