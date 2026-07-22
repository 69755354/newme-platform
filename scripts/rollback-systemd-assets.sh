#!/usr/bin/env bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exit 77
BACKUP="${1:-}"
[ -d "$BACKUP/rootfs" ] && [ -f "$BACKUP/managed.list" ] && [ -f "$BACKUP/present.list" ] && [ -f "$BACKUP/manifest.sha256" ] || exit 64
(cd "$BACKUP/rootfs" && sha256sum -c "$BACKUP/manifest.sha256")

while IFS= read -r dest; do
  [ -n "$dest" ] || continue
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
echo "restored systemd and observability assets from $BACKUP"
