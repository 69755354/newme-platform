#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
[ "$MODE" = "bootstrap" ] || [ "$MODE" = "final" ] || {
  echo "usage: install-staging-edge.sh bootstrap|final" >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || {
  echo "install-staging-edge.sh must run as root" >&2
  exit 77
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AVAILABLE="/etc/nginx/sites-available/staging.newme.ae"
ENABLED="/etc/nginx/sites-enabled/staging.newme.ae"
BACKUP="$AVAILABLE.previous"
SOURCE="$ROOT/infra/nginx/staging.newme.ae.$MODE.conf"
if [ "$MODE" = "final" ]; then
  SOURCE="$ROOT/infra/nginx/staging.newme.ae.conf"
fi
CHANGED=0

production_healthy() {
  curl -fsS --max-time 5 http://127.0.0.1:3001/api/health |
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"'
}

staging_tls_healthy() {
  curl --noproxy "*" -fsS --max-time 5 \
    --resolve staging.newme.ae:443:127.0.0.1 \
    https://staging.newme.ae/api/health 2>/dev/null |
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"'
}

wait_for_staging_tls() {
  local attempt
  for attempt in $(seq 1 30); do
    if staging_tls_healthy; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  local rc=$?
  trap - EXIT
  if [ "$CHANGED" -eq 1 ]; then
    if [ -f "$BACKUP" ]; then
      mv -f "$BACKUP" "$AVAILABLE"
    else
      rm -f -- "$AVAILABLE" "$ENABLED"
    fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  fi
  exit "$rc"
}
trap rollback EXIT

[ -f "$SOURCE" ] || { echo "staging nginx source is missing" >&2; exit 1; }
command -v nginx >/dev/null || { echo "nginx is not installed" >&2; exit 1; }
production_healthy || { echo "production health is not green" >&2; exit 1; }

if [ "$MODE" = "final" ]; then
  curl -fsS --max-time 5 http://127.0.0.1:3101/api/health |
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"' ||
    { echo "staging runtime is not healthy" >&2; exit 1; }
  [ -r /etc/letsencrypt/live/staging.newme.ae/fullchain.pem ] ||
    { echo "staging TLS certificate is missing" >&2; exit 1; }
  [ -r /etc/letsencrypt/live/staging.newme.ae/privkey.pem ] ||
    { echo "staging TLS private key is missing" >&2; exit 1; }
fi

install -d -m 0755 /var/www/newme-staging-acme
if [ -f "$AVAILABLE" ]; then
  cp -a "$AVAILABLE" "$BACKUP"
fi
install -m 0644 "$SOURCE" "$AVAILABLE"
ln -sfn "$AVAILABLE" "$ENABLED"
CHANGED=1
nginx -t
systemctl reload nginx

if [ "$MODE" = "final" ]; then
  wait_for_staging_tls ||
    { echo "local staging TLS health check failed" >&2; exit 1; }
fi
production_healthy || { echo "production health changed after nginx reload" >&2; exit 1; }

CHANGED=0
rm -f -- "$BACKUP"
trap - EXIT
echo "staging nginx $MODE configuration installed"
