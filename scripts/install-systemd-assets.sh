#!/usr/bin/env bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exit 77
exec 8>/run/lock/newme-systemd-assets.lock
flock -n 8 || { echo "another versioned asset installation is active" >&2; exit 75; }
MODE="${1:-install}"
case "$MODE:$#" in
  install:0|snapshot:1) ;;
  *) echo "usage: install-systemd-assets.sh [snapshot]" >&2; exit 64 ;;
esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${NEWME_ASSET_SOURCE_ROOT:-}" ]; then
  [ "$MODE" = snapshot ] || { echo "asset source override is snapshot-only" >&2; exit 64; }
  [ "$(dirname -- "$NEWME_ASSET_SOURCE_ROOT")" = /opt/newme/releases ] &&
    [[ "$(basename -- "$NEWME_ASSET_SOURCE_ROOT")" =~ ^[0-9a-f]{40}$ ]] || {
    echo "asset snapshot source is outside the immutable release root" >&2
    exit 65
  }
  [ -d "$NEWME_ASSET_SOURCE_ROOT" ] && [ ! -L "$NEWME_ASSET_SOURCE_ROOT" ] &&
    [ -f "$NEWME_ASSET_SOURCE_ROOT/.newme-protect" ] || exit 65
  ROOT="$NEWME_ASSET_SOURCE_ROOT"
fi
SOURCE_SHA=""
if [ "$MODE" = install ]; then
  SOURCE_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 65
fi
STATE_ROOT=/var/lib/newme/deploy-state
install -d -o root -g root -m 0700 "$STATE_ROOT"
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || exit 65
[ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] || exit 65
[ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || exit 65
PENDING_RECORD="$STATE_ROOT/systemd-assets.pending"
PRODUCTION_ROLLBACK_PENDING="$STATE_ROOT/production-rollback.pending"
if [ "$MODE" = install ] && { [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; }; then
  echo "an unresolved production rollback must be recovered before installing assets" >&2
  exit 75
fi
if [ "$MODE" = install ] && { [ -e "$PENDING_RECORD" ] || [ -L "$PENDING_RECORD" ]; }; then
  [ -f "$PENDING_RECORD" ] && [ ! -L "$PENDING_RECORD" ] || {
    echo "the unresolved versioned asset pointer is invalid" >&2
    exit 65
  }
  [ "$(stat -c '%U:%G' "$PENDING_RECORD")" = root:root ] || exit 65
  [ "$(stat -c '%a' "$PENDING_RECORD")" = 600 ] || exit 65
  [ "$(wc -l < "$PENDING_RECORD")" -eq 5 ] || exit 65
  [ "$(grep -Ec '^sha=[0-9a-f]{40}$' "$PENDING_RECORD")" -eq 1 ] || exit 65
  [ "$(grep -Ec '^backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$PENDING_RECORD")" -eq 1 ] || exit 65
  [ "$(grep -Ec '^previous=/opt/newme/releases/[0-9a-f]{40}$' "$PENDING_RECORD")" -eq 1 ] || exit 65
  [ "$(grep -Ec '^previous_rollback=(/opt/newme/releases/[0-9a-f]{40})?$' "$PENDING_RECORD")" -eq 1 ] || exit 65
  [ "$(grep -Ec '^candidate_preexisting=0$' "$PENDING_RECORD")" -eq 1 ] || exit 65
  PENDING_SHA="$(sed -n 's/^sha=//p' "$PENDING_RECORD")"
  PENDING_BACKUP="$(sed -n 's/^backup=//p' "$PENDING_RECORD")"
  PENDING_PREVIOUS="$(sed -n 's/^previous=//p' "$PENDING_RECORD")"
  PENDING_PREVIOUS_ROLLBACK="$(sed -n 's/^previous_rollback=//p' "$PENDING_RECORD")"
  [ -d "$PENDING_BACKUP/rootfs" ] &&
    [ -f "$PENDING_BACKUP/managed.list" ] &&
    [ -f "$PENDING_BACKUP/present.list" ] &&
    [ -f "$PENDING_BACKUP/manifest.sha256" ] &&
    [ -f "$PENDING_BACKUP/symlink.sha256" ] || exit 65
  LIVE_CURRENT="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  if [ "$LIVE_CURRENT" = "/opt/newme/releases/$PENDING_SHA" ]; then
    echo "an unresolved deployment still has its candidate release active; protected asset pointer retained" >&2
    exit 75
  fi
  [ "$LIVE_CURRENT" = "$PENDING_PREVIOUS" ] || {
    echo "the unresolved deployment current target does not match its protected recovery point" >&2
    exit 65
  }
  echo "recovering unresolved versioned assets from $PENDING_BACKUP" >&2
  if ! bash "$ROOT/scripts/rollback-systemd-assets.sh" "$PENDING_BACKUP"; then
    echo "CRITICAL: unresolved versioned asset recovery failed for $PENDING_BACKUP" >&2
    exit 66
  fi
  RECOVERY_ROLLBACK_NEXT="/opt/newme/current.rollback.recovery-$$"
  rm -f -- "$RECOVERY_ROLLBACK_NEXT"
  if [ -n "$PENDING_PREVIOUS_ROLLBACK" ]; then
    ln -s "$PENDING_PREVIOUS_ROLLBACK" "$RECOVERY_ROLLBACK_NEXT"
    mv -Tf "$RECOVERY_ROLLBACK_NEXT" /opt/newme/current.rollback
  else
    rm -f -- /opt/newme/current.rollback
  fi
  sync -f /opt/newme
  /usr/local/sbin/newme-service-control reset-failed "deploy:pending-recovery:reset" || true
  /usr/local/sbin/newme-service-control restart "deploy:pending-recovery"
  curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null
  RECOVERY_CANDIDATE="/opt/newme/releases/$PENDING_SHA"
  if [ -e "$RECOVERY_CANDIDATE" ] || [ -L "$RECOVERY_CANDIDATE" ]; then
    [ -d "$RECOVERY_CANDIDATE" ] && [ ! -L "$RECOVERY_CANDIDATE" ] || exit 65
    [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" != "$RECOVERY_CANDIDATE" ] || exit 65
    [ "$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)" != "$RECOVERY_CANDIDATE" ] || exit 65
    rm -rf --one-file-system -- "$RECOVERY_CANDIDATE"
    [ ! -e "$RECOVERY_CANDIDATE" ] && [ ! -L "$RECOVERY_CANDIDATE" ] || exit 65
  fi
  sync -f /opt/newme/releases
  rm -f -- "$PENDING_RECORD"
  sync -f "$STATE_ROOT"
fi
if [ "$MODE" = install ]; then
  CANDIDATE_RELEASE="/opt/newme/releases/$SOURCE_SHA"
  if [ -e "$CANDIDATE_RELEASE" ] || [ -L "$CANDIDATE_RELEASE" ]; then
    echo "candidate release already exists before asset installation" >&2
    exit 65
  fi
fi
PREVIOUS_CURRENT="$(readlink -f /opt/newme/current 2>/dev/null || true)"
PREVIOUS_ROLLBACK="$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)"
[[ "$PREVIOUS_CURRENT" =~ ^/opt/newme/releases/[0-9a-f]{40}$ ]] || exit 65
if [ -n "$PREVIOUS_ROLLBACK" ]; then
  [[ "$PREVIOUS_ROLLBACK" =~ ^/opt/newme/releases/[0-9a-f]{40}$ ]] || exit 65
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0700 /var/backups/newme-systemd-assets
BACKUP="$(mktemp -d "/var/backups/newme-systemd-assets/${STAMP}.XXXXXX")"
ROOTFS="$BACKUP/rootfs"
mkdir -p "$ROOTFS"
: > "$BACKUP/present.list"
: > "$BACKUP/managed.list"
: > "$BACKUP/manifest.sha256"
: > "$BACKUP/symlink.sha256"

remember() {
  local dest="$1" rel="${1#/}"
  printf '%s\n' "$dest" >> "$BACKUP/managed.list"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    printf '%s\n' "$dest" >> "$BACKUP/present.list"
    mkdir -p "$ROOTFS/$(dirname "$rel")"
    cp -a -- "$dest" "$ROOTFS/$rel"
    if [ -L "$dest" ]; then
      link_hash="$(printf '%s' "$(readlink -- "$dest")" | sha256sum | awk '{print $1}')"
      printf '%s  %s\n' "$link_hash" "$dest" >> "$BACKUP/symlink.sha256"
    elif [ -f "$dest" ]; then
      sha256sum "$ROOTFS/$rel" >> "$BACKUP/manifest.sha256"
    else
      echo "managed asset must be a regular file or symlink: $dest" >&2
      exit 65
    fi
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

install_control_script() {
  local source="$1" dest="$2" directory="" temporary=""
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  directory="$(dirname "$dest")"
  install -d -o root -g root -m 0755 "$directory" || return 1
  temporary="$(mktemp "${dest}.new.XXXXXX")" || return 1
  if ! install -o root -g root -m 0755 "$source" "$temporary" ||
    ! bash -n "$temporary" ||
    ! sync -f "$temporary" ||
    ! mv -Tf "$temporary" "$dest" ||
    ! sync -f "$directory"; then
    rm -f -- "$temporary" 2>/dev/null || true
    return 1
  fi
}

install_control_sudoers() {
  local source="$1" dest="$2" directory="" temporary=""
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  directory="$(dirname "$dest")"
  install -d -o root -g root -m 0755 "$directory" || return 1
  temporary="$(mktemp "${dest}.new.XXXXXX")" || return 1
  if ! install -o root -g root -m 0440 "$source" "$temporary" ||
    ! visudo -cf "$temporary" ||
    ! sync -f "$temporary" ||
    ! mv -Tf "$temporary" "$dest" ||
    ! sync -f "$directory"; then
    rm -f -- "$temporary" 2>/dev/null || true
    return 1
  fi
}

UNIT="$ROOT/infra/systemd/newme-platform.service"
[ "$(grep -c '^ExecStopPost=' "$UNIT")" -eq 1 ] || exit 65
cmp -s "$UNIT" "$ROOT/newme-platform.service" || exit 65

MANAGED=(
  /etc/systemd/system/newme-platform.service
  /usr/local/libexec/newme/newme-forensic.sh
  /usr/local/libexec/newme/newme-readiness.sh
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

if [ "$MODE" = snapshot ]; then
  SNAPSHOT_RECORD="${NEWME_ASSET_SNAPSHOT_RECORD:-}"
  case "$SNAPSHOT_RECORD" in
    "$STATE_ROOT"/asset-snapshot.*) ;;
    *) echo "asset snapshot record must be in the protected persistent deploy-state directory" >&2; exit 64 ;;
  esac
  [ -f "$SNAPSHOT_RECORD" ] && [ ! -L "$SNAPSHOT_RECORD" ] || exit 65
  [ "$(stat -c '%U:%G' "$SNAPSHOT_RECORD")" = root:root ] || exit 65
  [ "$(stat -c '%a' "$SNAPSHOT_RECORD")" = 600 ] || exit 65
  printf '%s\n' "$BACKUP" > "$SNAPSHOT_RECORD"
  sync -f "$BACKUP"
  sync -f "$STATE_ROOT"
  echo "snapshot=$BACKUP"
  exit 0
fi

# The recovery control plane is forward-only. Install every dependency before
# the controller that consumes it, and atomically replace each executable. No
# versioned runtime asset is mutated until the complete recovery plane is live.
install_control_script "$ROOT/scripts/install-systemd-assets.sh" /usr/local/libexec/newme/newme-install-systemd-assets
install_control_script "$ROOT/scripts/rollback-systemd-assets.sh" /usr/local/libexec/newme/newme-rollback-systemd-assets
install_control_script "$ROOT/infra/systemd/newme-service-control.sh" /usr/local/sbin/newme-service-control
install_control_script "$ROOT/infra/systemd/newme-production-rollback.sh" /usr/local/sbin/newme-production-rollback
install_control_script "$ROOT/infra/systemd/newme-deploy.sh" /usr/local/sbin/newme-deploy
install_control_sudoers "$ROOT/infra/sudoers/newme-platform" /etc/sudoers.d/newme-platform
rm -f -- /etc/sudoers.d/ubuntu-nopasswd
sync -f /etc/sudoers.d
visudo -c

INSTALL_COMMITTED=0
PENDING_TMP=""
ROLLBACK_COMPLETED=0
rollback_on_error() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$rc" -ne 0 ] && [ "$INSTALL_COMMITTED" -eq 0 ]; then
    echo "asset installation failed; restoring $BACKUP" >&2
    if bash "$ROOT/scripts/rollback-systemd-assets.sh" "$BACKUP"; then
      ROLLBACK_COMPLETED=1
    else
      echo "CRITICAL: automatic asset rollback failed for $BACKUP" >&2
    fi
  fi
  if [ "$ROLLBACK_COMPLETED" -eq 1 ] && [ -f "$PENDING_RECORD" ] && [ ! -L "$PENDING_RECORD" ]; then
    pending_backup="$(sed -n 's/^backup=//p' "$PENDING_RECORD" | head -n 1)"
    [ "$pending_backup" != "$BACKUP" ] || rm -f -- "$PENDING_RECORD"
  fi
  if [ "$ROLLBACK_COMPLETED" -eq 1 ] && ! sync -f "$STATE_ROOT"; then
    echo "CRITICAL: rolled-back asset transaction state could not be flushed" >&2
    ROLLBACK_COMPLETED=0
    rc=2
  fi
  if [ -n "$PENDING_TMP" ]; then
    case "$PENDING_TMP" in "$STATE_ROOT"/systemd-assets.pending.*) rm -f -- "$PENDING_TMP" ;; esac
  fi
  if [ "$ROLLBACK_COMPLETED" -eq 1 ] && [ -n "${NEWME_ASSET_BACKUP_RECORD:-}" ]; then
    : > "$NEWME_ASSET_BACKUP_RECORD" 2>/dev/null || true
  fi
  exit "$rc"
}
trap rollback_on_error EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Publish both recovery pointers after the backup is complete and before the
# first live asset mutation. The fixed pointer is created without replacement,
# so an unresolved transaction can never lose its original rollback target.
if [ -n "${NEWME_ASSET_BACKUP_RECORD:-}" ]; then
  case "$NEWME_ASSET_BACKUP_RECORD" in
    "$STATE_ROOT"/systemd-assets-backup.*) ;;
    *) echo "asset backup record must be in the protected persistent deploy-state directory" >&2; exit 64 ;;
  esac
  [ -f "$NEWME_ASSET_BACKUP_RECORD" ] && [ ! -L "$NEWME_ASSET_BACKUP_RECORD" ] || exit 65
  [ "$(stat -c '%U:%G' "$NEWME_ASSET_BACKUP_RECORD")" = root:root ] || exit 65
  [ "$(stat -c '%a' "$NEWME_ASSET_BACKUP_RECORD")" = 600 ] || exit 65
  printf '%s\n' "$BACKUP" > "$NEWME_ASSET_BACKUP_RECORD"
fi
PENDING_TMP="$(mktemp "$STATE_ROOT/systemd-assets.pending.XXXXXX")"
chmod 0600 "$PENDING_TMP"
printf 'sha=%s\nbackup=%s\nprevious=%s\nprevious_rollback=%s\ncandidate_preexisting=0\n' \
  "$SOURCE_SHA" "$BACKUP" "$PREVIOUS_CURRENT" "$PREVIOUS_ROLLBACK" > "$PENDING_TMP"
ln -- "$PENDING_TMP" "$PENDING_RECORD"
rm -f -- "$PENDING_TMP"
PENDING_TMP=""
sync -f "$BACKUP"
sync -f "$STATE_ROOT"

install -D -o root -g root -m 0644 "$UNIT" /etc/systemd/system/newme-platform.service
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-forensic.sh" /usr/local/libexec/newme/newme-forensic.sh
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-readiness.sh" /usr/local/libexec/newme/newme-readiness.sh
install -D -o root -g root -m 0644 "$ROOT/infra/logrotate/newme-forensic" /etc/logrotate.d/newme-forensic

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

# Publish the new schedule only after every script it references is installed
# and Nginx has accepted the versioned ingress configuration.
install -D -o root -g root -m 0644 "$ROOT/infra/observability/newme-observability.cron" /etc/cron.d/newme-observability

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
test -x /usr/local/libexec/newme/newme-install-systemd-assets
test -x /usr/local/libexec/newme/newme-rollback-systemd-assets
case "$(git --git-dir=/opt/newme/repository.git remote get-url origin)" in
  https://github.com/69755354/newme-platform.git|git@github.com:69755354/newme-platform.git) ;;
  *) exit 65 ;;
esac
for durable_path in /etc /usr/local /opt /var; do
  sync -f "$durable_path"
done
echo "backup=$BACKUP rollback=sudo bash $ROOT/scripts/rollback-systemd-assets.sh $BACKUP"
INSTALL_COMMITTED=1
trap - EXIT HUP INT TERM
