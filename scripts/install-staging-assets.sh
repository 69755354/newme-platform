#!/usr/bin/env bash
set -Eeuo pipefail

[ "$(id -u)" -eq 0 ] || { echo "install-staging-assets.sh must run as root" >&2; exit 77; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

id newme-staging >/dev/null 2>&1 ||
  useradd --system --home-dir /opt/newme-staging --shell /usr/sbin/nologin newme-staging

install -d -m 0750 -o root -g newme-staging /etc/newme-staging
install -d -m 0755 -o root -g root /opt/newme-staging /opt/newme-staging/control
install -d -m 0750 -o newme-staging -g newme-staging /opt/newme-staging/releases
install -m 0755 "$ROOT/scripts/deploy-staging.sh" /opt/newme-staging/control/deploy-staging.sh
install -m 0644 "$ROOT/infra/systemd/newme-staging.service" /etc/systemd/system/newme-staging.service
install -m 0644 "$ROOT/infra/systemd/newme-staging-deploy@.service" /etc/systemd/system/newme-staging-deploy@.service

systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/newme-staging.service
systemd-analyze verify /etc/systemd/system/newme-staging-deploy@.service
echo "staging assets installed; runtime remains stopped until staging.env and a verified release exist"
