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
RESTORE_TMP=""
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

# Defined before restore_managed_path() and calling it: both are in place before
# anything calls either. This is the path taken when the BACKUP's own Nginx
# configuration turns out to be invalid, i.e. the second failure in a row, so it
# gets the same atomic replacement as everything else — including the
# sites-enabled symlink, which is why restore_managed_path() handles links.
restore_nginx_snapshot() {
  local nginx_path=""
  for nginx_path in /etc/nginx/sites-available/newme-platform /etc/nginx/sites-enabled/newme-platform; do
    restore_managed_path "$nginx_path" "$NGINX_SNAPSHOT/rootfs" "$NGINX_SNAPSHOT/present.list" || return 1
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
  if [ -n "$RESTORE_TMP" ]; then
    case "$RESTORE_TMP" in */.newme-asset-rollback.*) rm -f -- "$RESTORE_TMP" ;; esac
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

# Put one managed path back, atomically (round-4 review C3).
#
# `rm -f` followed by `cp -a` — which every path except the cron file used to do —
# has a window in which the destination does not exist, and a second window in
# which it exists half-written. Both windows are real: this script is what runs
# when a deploy has already failed, so it runs on a host that is already having a
# bad day, and it is also called by the installer's own failure trap and by
# newme-production-rollback. Lose power inside the first window and the file is
# simply gone; inside the second and it is truncated. For
# /etc/sudoers.d/newme-platform that is the difference between a rollback and a
# host whose operator can no longer sudo the deploy wrapper; for the unit file it
# is a service that cannot start.
#
# The temp-and-rename idiom below was already here, applied to exactly one path
# (the cron file, whose window would have let cron fire a half-written schedule).
# It is the same fix for the same reason everywhere else, so it is now the only
# restore path, and rename replaces the destination in one step: a reader sees the
# old file or the new one, a crash leaves one or the other, and re-running this
# script from the same backup converges — which is what makes an interrupted
# rollback recoverable by repeating it.
#
# The temp is created in the destination's own directory (rename is only atomic
# within a filesystem) with a leading dot in its name, which is what keeps it inert
# while it exists: cron.d and sudoers.d both ignore names containing a dot, and
# nginx's include globs do not match a leading dot. cleanup() removes it if a
# signal arrives between mktemp and mv.
restore_managed_path() {
  local dest="$1" source_root="${2:-$BACKUP/rootfs}" present="${3:-$BACKUP/present.list}"
  local rel="${1#/}" directory=""
  directory="$(dirname "$dest")"
  if grep -Fqx "$dest" "$present"; then
    mkdir -p "$directory" || return 1
    RESTORE_TMP="$(mktemp "$directory/.newme-asset-rollback.XXXXXX")" || return 1
    # cp -a must create the copy itself, symlink or file, so the placeholder goes.
    rm -f -- "$RESTORE_TMP" || return 1
    cp -a -- "$source_root/$rel" "$RESTORE_TMP" || return 1
    if [ -L "$RESTORE_TMP" ]; then
      # sync -f follows the link, and a restored symlink may point at something
      # this run has not restored yet. Its filesystem is the directory's.
      sync -f "$directory" || return 1
    else
      sync -f "$RESTORE_TMP" || return 1
    fi
    mv -Tf "$RESTORE_TMP" "$dest" || return 1
    RESTORE_TMP=""
  else
    rm -f -- "$dest" || return 1
  fi
}

restore_managed_cron() {
  [ "$CRON_MANAGED" -eq 1 ] || return 0
  restore_managed_path "$CRON_PATH" || return 1
  sync -f /etc/cron.d || return 1
}

while IFS= read -r dest; do
  [ -n "$dest" ] || continue
  [ "$dest" != "$CRON_PATH" ] || continue
  restore_managed_path "$dest"
done < "$BACKUP/managed.list"

for dropin in /etc/systemd/system/newme-platform.service.d/forensic.conf /etc/systemd/system/newme-platform.service.d/restart-always.conf /etc/newme/newme-runtime.env; do
  restore_managed_path "$dropin"
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
