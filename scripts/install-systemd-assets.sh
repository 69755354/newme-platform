#!/usr/bin/env bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exit 77
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/var/backups/newme-systemd-assets/$STAMP"
ROOTFS="$BACKUP/rootfs"
mkdir -p "$ROOTFS"
: > "$BACKUP/present.list"
: > "$BACKUP/managed.list"
: > "$BACKUP/manifest.sha256"

remember() {
  local dest="$1" rel="${1#/}"
  printf '%s\n' "$dest" >> "$BACKUP/managed.list"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    printf '%s\n' "$dest" >> "$BACKUP/present.list"
    mkdir -p "$ROOTFS/$(dirname "$rel")"
    cp -a -- "$dest" "$ROOTFS/$rel"
    sha256sum "$ROOTFS/$rel" >> "$BACKUP/manifest.sha256"
  fi
}

UNIT="$ROOT/infra/systemd/newme-platform.service"
[ "$(grep -c '^ExecStopPost=' "$UNIT")" -eq 1 ] || exit 65
cmp -s "$UNIT" "$ROOT/newme-platform.service" || exit 65

MANAGED=(
  /etc/systemd/system/newme-platform.service
  /usr/local/libexec/newme/newme-forensic.sh
  /usr/local/libexec/newme/newme-readiness.sh
  /usr/local/sbin/newme-service-control
  /etc/logrotate.d/newme-forensic
  /etc/cron.d/newme-observability
  /etc/hermes/observability/hermes-alert-v1.env
  /opt/hermes-scripts/observability/health-check.sh
  /opt/hermes-scripts/observability/login-probe.sh
  /opt/hermes-scripts/observability/hermes-alert-notifier-v1.sh
  /opt/hermes-scripts/observability/hermes-alert-state-v1.sh
  /opt/hermes-scripts/observability/incident-capture.sh
  /opt/hermes-scripts/observability/incident-review.sh
  /opt/hermes-scripts/observability/newme-service-health.py
  /opt/hermes-scripts/observability/sentry-cron-checkin.sh
  /opt/hermes-scripts/observability/sentry-release.sh
  /opt/hermes-scripts/observability/supabase-pool-monitor.sh
)
for p in "${MANAGED[@]}" /etc/systemd/system/newme-platform.service.d/forensic.conf /etc/systemd/system/newme-platform.service.d/restart-always.conf /etc/newme/newme-runtime.env; do remember "$p"; done

install -D -o root -g root -m 0644 "$UNIT" /etc/systemd/system/newme-platform.service
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-forensic.sh" /usr/local/libexec/newme/newme-forensic.sh
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-readiness.sh" /usr/local/libexec/newme/newme-readiness.sh
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-service-control.sh" /usr/local/sbin/newme-service-control
install -D -o root -g root -m 0644 "$ROOT/infra/logrotate/newme-forensic" /etc/logrotate.d/newme-forensic
install -D -o root -g root -m 0644 "$ROOT/infra/observability/newme-observability.cron" /etc/cron.d/newme-observability

install -d -o root -g root -m 0750 /etc/newme /etc/hermes/observability
install -d -o root -g root -m 0755 /opt/newme/releases /opt/hermes-scripts/observability
if [ ! -e /opt/newme/current ]; then
  mkdir -p /opt/newme/releases/.bootstrap
  ln -s /opt/newme/releases/.bootstrap /opt/newme/current
fi
[ -L /opt/newme/current ] || { echo "current must be a symlink" >&2; exit 66; }
case "$(readlink -f /opt/newme/current)" in /opt/newme/releases/*) ;; *) echo "current must target /opt/newme/releases" >&2; exit 66;; esac
if [ ! -e /etc/newme/newme-runtime.env ]; then
  umask 077
  printf 'NEWME_READINESS_TOKEN=%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" > /etc/newme/newme-runtime.env
fi
chown root:root /etc/newme/newme-runtime.env
chmod 0600 /etc/newme/newme-runtime.env
grep -Eq '^NEWME_READINESS_TOKEN=[0-9a-f]{64}$' /etc/newme/newme-runtime.env || exit 65

rm -f /etc/systemd/system/newme-platform.service.d/forensic.conf /etc/systemd/system/newme-platform.service.d/restart-always.conf
install -d -o root -g adm -m 0750 /var/log/newme-forensic
touch /var/log/newme-forensic/newme-forensic.log
chown root:adm /var/log/newme-forensic/newme-forensic.log
chmod 0640 /var/log/newme-forensic/newme-forensic.log

OBS=/opt/hermes-scripts/observability
for a in health-check.sh login-probe.sh hermes-alert-notifier-v1.sh hermes-alert-state-v1.sh incident-capture.sh incident-review.sh newme-service-health.py sentry-cron-checkin.sh sentry-release.sh supabase-pool-monitor.sh; do
  install -D -o root -g root -m 0755 "$ROOT/infra/observability/$a" "$OBS/$a"
done
[ -e /etc/hermes/observability/hermes-alert-v1.env ] || install -D -o root -g root -m 0640 "$ROOT/infra/observability/hermes-alert-v1.env.example" /etc/hermes/observability/hermes-alert-v1.env

systemctl daemon-reload
FRAGMENT="$(systemctl show newme-platform.service -p FragmentPath --value)"
DROP_INS="$(systemctl show newme-platform.service -p DropInPaths --value)"
[ "$FRAGMENT" = /etc/systemd/system/newme-platform.service ]
[ -z "$DROP_INS" ]
grep -Fqx '/var/log/newme-forensic/newme-forensic.log {' /etc/logrotate.d/newme-forensic
grep -Fq /opt/hermes-scripts/observability/health-check.sh /etc/cron.d/newme-observability
grep -Fq /opt/hermes-scripts/observability/login-probe.sh /etc/cron.d/newme-observability
echo "backup=$BACKUP rollback=sudo bash $ROOT/scripts/rollback-systemd-assets.sh $BACKUP"
