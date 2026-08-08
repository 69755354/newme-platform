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

restore_path() {
  local dest="$1" rel="${1#/}"
  rm -f -- "$dest"
  if grep -Fqx "$dest" "$BACKUP/present.list"; then
    mkdir -p "$(dirname "$dest")"
    cp -a -- "$ROOTFS/$rel" "$dest"
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
  /usr/local/sbin/newme-production-rollback
  /usr/local/sbin/newme-deploy
  /etc/sudoers.d/newme-platform
  /etc/sudoers.d/ubuntu-nopasswd
  /etc/logrotate.d/newme-forensic
  /etc/cron.d/newme-observability
  /etc/nginx/sites-available/newme-platform
  /etc/nginx/sites-enabled/newme-platform
  /etc/hermes/observability/hermes-alert-v1.env
  /opt/hermes-scripts/observability/health-check.sh
  /opt/hermes-scripts/observability/login-probe.sh
  /opt/hermes-scripts/observability/dependency-probe.sh
  /opt/hermes-scripts/observability/l0-composite-probe.sh
  /opt/hermes-scripts/observability/auth-log-probe.py
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
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-production-rollback.sh" /usr/local/sbin/newme-production-rollback
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-deploy.sh" /usr/local/sbin/newme-deploy
install -D -o root -g root -m 0440 "$ROOT/infra/sudoers/newme-platform" /etc/sudoers.d/newme-platform
visudo -cf /etc/sudoers.d/newme-platform
rm -f /etc/sudoers.d/ubuntu-nopasswd
install -D -o root -g root -m 0644 "$ROOT/infra/logrotate/newme-forensic" /etc/logrotate.d/newme-forensic
install -D -o root -g root -m 0644 "$ROOT/infra/observability/newme-observability.cron" /etc/cron.d/newme-observability

install -d -o root -g root -m 0750 /etc/newme /etc/hermes/observability
install -d -o root -g root -m 0755 /opt/newme/releases /opt/hermes-scripts/observability

MIRROR=/opt/newme/repository.git
EXPECTED_MIRROR_ORIGIN=https://github.com/69755354/newme-platform.git
if [ -e "$MIRROR" ] || [ -L "$MIRROR" ]; then
  mirror_origin="$(git --git-dir="$MIRROR" remote get-url origin 2>/dev/null || true)"
  if [ "$mirror_origin" != "$EXPECTED_MIRROR_ORIGIN" ] && [ "$mirror_origin" != git@github.com:69755354/newme-platform.git ]; then
    mv -- "$MIRROR" "$BACKUP/repository.git.invalid"
  fi
fi
if [ ! -d "$MIRROR" ]; then
  git clone --bare "$EXPECTED_MIRROR_ORIGIN" "$MIRROR"
fi
chown -R root:root "$MIRROR"
chmod 0700 "$MIRROR"
if [ ! -e /opt/newme/current ]; then
  mkdir -p /opt/newme/releases/.bootstrap
  ln -s /opt/newme/releases/.bootstrap /opt/newme/current
fi
[ -L /opt/newme/current ] || { echo "current must be a symlink" >&2; exit 66; }
case "$(readlink -f /opt/newme/current)" in /opt/newme/releases/*) ;; *) echo "current must target /opt/newme/releases" >&2; exit 66;; esac
RUNTIME_ENV=/etc/newme/newme-runtime.env
if [ ! -e "$RUNTIME_ENV" ]; then
  umask 077
  printf 'NEWME_READINESS_TOKEN=%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" > "$RUNTIME_ENV"
fi
[ ! -L "$RUNTIME_ENV" ] && [ -f "$RUNTIME_ENV" ] || exit 65
[ "$(grep -Ec '^NEWME_READINESS_TOKEN=' "$RUNTIME_ENV")" -eq 1 ] || exit 65
grep -Eq '^NEWME_READINESS_TOKEN=[0-9a-f]{64}$' "$RUNTIME_ENV" || exit 65
umask 077
RUNTIME_TMP="$(mktemp /etc/newme/newme-runtime.env.XXXXXX)"
awk '$0 !~ /^[[:space:]]*(export[[:space:]]+)?NEXT_PUBLIC_SITE_URL=/' "$RUNTIME_ENV" > "$RUNTIME_TMP"
printf 'NEXT_PUBLIC_SITE_URL=https://app.newme.ae\n' >> "$RUNTIME_TMP"
chown root:root "$RUNTIME_TMP"
chmod 0600 "$RUNTIME_TMP"
mv -f "$RUNTIME_TMP" "$RUNTIME_ENV"
[ "$(grep -Ec '^NEXT_PUBLIC_SITE_URL=https://app\.newme\.ae$' "$RUNTIME_ENV")" -eq 1 ] || exit 65
python3 "$ROOT/scripts/validate-production-config.py" \
  --release-env /opt/newme/current/.env.local \
  --runtime-env "$RUNTIME_ENV"

rm -f /etc/systemd/system/newme-platform.service.d/forensic.conf /etc/systemd/system/newme-platform.service.d/restart-always.conf
install -d -o root -g adm -m 0750 /var/log/newme-forensic
touch /var/log/newme-forensic/newme-forensic.log
chown root:adm /var/log/newme-forensic/newme-forensic.log
chmod 0640 /var/log/newme-forensic/newme-forensic.log

OBS=/opt/hermes-scripts/observability
for a in health-check.sh login-probe.sh dependency-probe.sh l0-composite-probe.sh auth-log-probe.py hermes-alert-notifier-v1.sh hermes-alert-state-v1.sh incident-capture.sh incident-review.sh newme-service-health.py sentry-cron-checkin.sh sentry-release.sh supabase-pool-monitor.sh; do
  install -D -o root -g root -m 0755 "$ROOT/infra/observability/$a" "$OBS/$a"
done
[ -e /etc/hermes/observability/hermes-alert-v1.env ] || install -D -o root -g root -m 0640 "$ROOT/infra/observability/hermes-alert-v1.env.example" /etc/hermes/observability/hermes-alert-v1.env

NGINX_AVAILABLE=/etc/nginx/sites-available/newme-platform
NGINX_ENABLED=/etc/nginx/sites-enabled/newme-platform
nginx -V 2>&1 | grep -Fq -- '--with-http_realip_module' || {
  echo "nginx realip module is required" >&2
  exit 65
}
install -D -o root -g root -m 0644 "$ROOT/infra/nginx/newme-platform.conf" "$NGINX_AVAILABLE"
install -D -o root -g root -m 0644 "$ROOT/infra/nginx/newme-platform.conf" "$NGINX_ENABLED"
if ! nginx -t; then
  restore_path "$NGINX_AVAILABLE"
  restore_path "$NGINX_ENABLED"
  nginx -t || true
  echo "nginx configuration validation failed and was restored" >&2
  exit 65
fi
if ! systemctl reload nginx; then
  restore_path "$NGINX_AVAILABLE"
  restore_path "$NGINX_ENABLED"
  nginx -t && systemctl reload nginx || true
  echo "nginx reload failed and the prior configuration was restored" >&2
  exit 65
fi

systemctl daemon-reload
FRAGMENT="$(systemctl show newme-platform.service -p FragmentPath --value)"
DROP_INS="$(systemctl show newme-platform.service -p DropInPaths --value)"
[ "$FRAGMENT" = /etc/systemd/system/newme-platform.service ]
[ -z "$DROP_INS" ]
grep -Fqx '/var/log/newme-forensic/newme-forensic.log {' /etc/logrotate.d/newme-forensic
grep -Fqx '*/2 * * * * ubuntu /usr/bin/flock -n /run/lock/newme-observability-l0.lock /opt/hermes-scripts/observability/l0-composite-probe.sh' /etc/cron.d/newme-observability
test -x /opt/hermes-scripts/observability/auth-log-probe.py
test -x /opt/hermes-scripts/observability/dependency-probe.sh
test -x /opt/hermes-scripts/observability/l0-composite-probe.sh
cmp -s /etc/nginx/sites-available/newme-platform /etc/nginx/sites-enabled/newme-platform
grep -Fq 'real_ip_header CF-Connecting-IP;' /etc/nginx/sites-enabled/newme-platform
! grep -Eq '/codex_uat_key|/qr\.png|/tmp/codex_uat_key|/tmp/astrbot_qr' /etc/nginx/sites-enabled/newme-platform
systemctl is-active --quiet nginx
test -x /usr/local/sbin/newme-deploy
test -x /usr/local/sbin/newme-production-rollback
case "$(git --git-dir=/opt/newme/repository.git remote get-url origin)" in
  https://github.com/69755354/newme-platform.git|git@github.com:69755354/newme-platform.git) ;;
  *) exit 65 ;;
esac
echo "backup=$BACKUP rollback=sudo bash $ROOT/scripts/rollback-systemd-assets.sh $BACKUP"
