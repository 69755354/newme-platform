#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "install-systemd-assets.sh must run as root" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
install -D -o root -g root -m 0644 "$ROOT/infra/systemd/newme-platform.service" /etc/systemd/system/newme-platform.service
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-forensic.sh" /usr/local/libexec/newme/newme-forensic.sh
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-readiness.sh" /usr/local/libexec/newme/newme-readiness.sh
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-service-control.sh" /usr/local/sbin/newme-service-control
install -D -o root -g root -m 0644 "$ROOT/infra/logrotate/newme-forensic" /etc/logrotate.d/newme-forensic

install -d -o root -g adm -m 0750 /var/log/newme-forensic
if [ -f /var/log/newme-forensic.log ]; then
  if [ ! -e /var/log/newme-forensic/newme-forensic.log ]; then
    mv /var/log/newme-forensic.log /var/log/newme-forensic/newme-forensic.log
  else
    cat /var/log/newme-forensic.log >> /var/log/newme-forensic/newme-forensic.log
    rm -f /var/log/newme-forensic.log
  fi
  chown root:adm /var/log/newme-forensic/newme-forensic.log
  chmod 0640 /var/log/newme-forensic/newme-forensic.log
fi

systemctl daemon-reload
echo "Versioned NewMe systemd assets and log rotation installed."
