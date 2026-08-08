#!/usr/bin/env bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exit 77
BACKUP="${1:-}"
[ -d "$BACKUP/rootfs" ] && [ -f "$BACKUP/managed.list" ] && [ -f "$BACKUP/present.list" ] && [ -f "$BACKUP/manifest.sha256" ] && [ -f "$BACKUP/symlink.sha256" ] || exit 64
if [ -s "$BACKUP/manifest.sha256" ]; then
  (cd "$BACKUP/rootfs" && sha256sum -c "$BACKUP/manifest.sha256")
fi
while read -r expected dest extra; do
  [ -n "$expected" ] || continue
  [ -n "$dest" ] && [ -z "${extra:-}" ] || exit 65
  rel="${dest#/}"
  [ -L "$BACKUP/rootfs/$rel" ] || exit 65
  actual="$(printf '%s' "$(readlink -- "$BACKUP/rootfs/$rel")" | sha256sum | awk '{print $1}')"
  [ "$actual" = "$expected" ] || exit 65
done < "$BACKUP/symlink.sha256"

NGINX_SNAPSHOT=""
NGINX_MANAGED=0
NGINX_TRANSACTION_COMMITTED=0
CRON_PATH=/etc/cron.d/newme-observability
CRON_MANAGED=0
CRON_TMP=""
if grep -Fqx /etc/nginx/sites-available/newme-platform "$BACKUP/managed.list" ||
  grep -Fqx /etc/nginx/sites-enabled/newme-platform "$BACKUP/managed.list"; then
  NGINX_MANAGED=1
  NGINX_SNAPSHOT="$(mktemp -d /run/newme-nginx-current.XXXXXX)"
  : > "$NGINX_SNAPSHOT/present.list"
  for nginx_path in /etc/nginx/sites-available/newme-platform /etc/nginx/sites-enabled/newme-platform; do
    if [ -e "$nginx_path" ] || [ -L "$nginx_path" ]; then
      printf '%s\n' "$nginx_path" >> "$NGINX_SNAPSHOT/present.list"
      mkdir -p "$NGINX_SNAPSHOT/rootfs/$(dirname "${nginx_path#/}")"
      cp -a -- "$nginx_path" "$NGINX_SNAPSHOT/rootfs/${nginx_path#/}"
    fi
  done
fi
if grep -Fqx "$CRON_PATH" "$BACKUP/managed.list"; then
  CRON_MANAGED=1
fi

restore_nginx_snapshot() {
  local nginx_path=""
  for nginx_path in /etc/nginx/sites-available/newme-platform /etc/nginx/sites-enabled/newme-platform; do
    rm -f -- "$nginx_path" || return 1
    if grep -Fqx "$nginx_path" "$NGINX_SNAPSHOT/present.list"; then
      mkdir -p "$(dirname "$nginx_path")" || return 1
      cp -a -- "$NGINX_SNAPSHOT/rootfs/${nginx_path#/}" "$nginx_path" || return 1
    fi
  done
}

discard_nginx_snapshot() {
  if [ -n "$NGINX_SNAPSHOT" ]; then
    case "$NGINX_SNAPSHOT" in /run/newme-nginx-current.*) rm -rf -- "$NGINX_SNAPSHOT" ;; esac
  fi
}

cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ -n "$CRON_TMP" ]; then
    case "$CRON_TMP" in /etc/cron.d/.newme-observability.rollback.*) rm -f -- "$CRON_TMP" ;; esac
  fi
  if [ "$rc" -ne 0 ] && [ "$NGINX_MANAGED" -eq 1 ] && [ "$NGINX_TRANSACTION_COMMITTED" -eq 0 ]; then
    if restore_nginx_snapshot && nginx -t && systemctl reload nginx && systemctl is-active --quiet nginx; then
      NGINX_TRANSACTION_COMMITTED=1
      discard_nginx_snapshot
      echo "prior live Nginx configuration restored after interrupted asset rollback" >&2
    else
      echo "CRITICAL: interrupted asset rollback could not restore Nginx; snapshot retained at $NGINX_SNAPSHOT" >&2
    fi
  else
    discard_nginx_snapshot
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

restore_managed_cron() {
  local rel="${CRON_PATH#/}"
  [ "$CRON_MANAGED" -eq 1 ] || return 0
  if grep -Fqx "$CRON_PATH" "$BACKUP/present.list"; then
    CRON_TMP="$(mktemp /etc/cron.d/.newme-observability.rollback.XXXXXX)" || return 1
    rm -f -- "$CRON_TMP" || return 1
    cp -a -- "$BACKUP/rootfs/$rel" "$CRON_TMP" || return 1
    mv -Tf "$CRON_TMP" "$CRON_PATH" || return 1
    CRON_TMP=""
  else
    rm -f -- "$CRON_PATH" || return 1
  fi
  sync -f /etc/cron.d || return 1
}

while IFS= read -r dest; do
  [ -n "$dest" ] || continue
  [ "$dest" != "$CRON_PATH" ] || continue
  if grep -Fqx "$dest" "$BACKUP/present.list"; then
    rel="${dest#/}"
    mkdir -p "$(dirname "$dest")"
    rm -f -- "$dest"
    cp -a -- "$BACKUP/rootfs/$rel" "$dest"
  else
    rm -f -- "$dest"
  fi
done < "$BACKUP/managed.list"

for dropin in /etc/systemd/system/newme-platform.service.d/forensic.conf /etc/systemd/system/newme-platform.service.d/restart-always.conf /etc/newme/newme-runtime.env; do
  rel="${dropin#/}"
  if grep -Fqx "$dropin" "$BACKUP/present.list"; then
    mkdir -p "$(dirname "$dropin")"
    rm -f -- "$dropin"
    cp -a -- "$BACKUP/rootfs/$rel" "$dropin"
  else
    rm -f -- "$dropin"
  fi
done

systemctl daemon-reload
if [ "$NGINX_MANAGED" -eq 1 ]; then
  if ! nginx -t; then
    restore_nginx_snapshot
    nginx -t && systemctl reload nginx || {
      echo "CRITICAL: prior Nginx configuration could not be restored" >&2
      exit 66
    }
    NGINX_TRANSACTION_COMMITTED=1
    echo "asset backup Nginx configuration failed validation; prior live files restored" >&2
    exit 65
  fi
  if ! systemctl reload nginx; then
    restore_nginx_snapshot
    nginx -t && systemctl reload nginx || {
      echo "CRITICAL: prior Nginx configuration could not be reloaded" >&2
      exit 66
    }
    NGINX_TRANSACTION_COMMITTED=1
    echo "asset backup Nginx reload failed; prior live files restored" >&2
    exit 65
  fi
  systemctl is-active --quiet nginx
  NGINX_TRANSACTION_COMMITTED=1
fi
restore_managed_cron
for durable_path in /etc /usr/local /opt /var; do
  sync -f "$durable_path"
done
echo "restored systemd and observability assets from $BACKUP"
