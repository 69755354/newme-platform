#!/usr/bin/env bash
set -Eeuo pipefail

[ "$(id -u)" -eq 0 ] || { echo "install-staging-assets.sh must run as root" >&2; exit 77; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ENV="/etc/newme-staging/staging.env"
BUILD_ENV="/etc/newme-staging/build.env"

id newme-staging >/dev/null 2>&1 ||
  useradd --system --home-dir /opt/newme-staging --shell /usr/sbin/nologin newme-staging

install -d -m 0750 -o root -g newme-staging /etc/newme-staging
install -d -m 0755 -o root -g root /opt/newme-staging /opt/newme-staging/control
install -d -m 0750 -o root -g newme-staging /opt/newme-staging/validation
install -d -m 0750 -o root -g newme-staging /opt/newme-staging/repository.git
install -d -m 0770 -o newme-staging -g newme-staging /opt/newme-staging/incoming
install -d -m 0750 -o newme-staging -g newme-staging /opt/newme-staging/releases
install -d -m 0750 -o newme-staging -g newme-staging /opt/newme-staging/build
install -d -m 0750 -o newme-staging -g newme-staging /opt/newme-staging/cache /opt/newme-staging/cache/npm
if [ ! -e "$BUILD_ENV" ] && [ -r "$RUNTIME_ENV" ]; then
  public_env="$(mktemp)"
  trap 'rm -f -- "$public_env"' EXIT
  awk -F= '
    $1 == "SUPABASE_PROJECT_REF" ||
    $1 == "NEXT_PUBLIC_SUPABASE_URL" ||
    $1 == "NEXT_PUBLIC_SUPABASE_ANON_KEY" ||
    $1 == "NEXT_PUBLIC_SITE_URL" ||
    $1 == "NEWME_STAGING_PROJECT_REF" ||
    $1 == "NEWME_STAGING_BRANCH" { print }
  ' "$RUNTIME_ENV" > "$public_env"
  for required in \
    SUPABASE_PROJECT_REF \
    NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL; do
    grep -q "^${required}=" "$public_env" ||
      { echo "cannot derive build.env: $required is missing" >&2; exit 1; }
  done
  install -m 0640 -o root -g newme-staging "$public_env" "$BUILD_ENV"
  rm -f -- "$public_env"
  trap - EXIT
fi
if [ ! -f /opt/newme-staging/repository.git/HEAD ]; then
  git init --bare /opt/newme-staging/repository.git
  git --git-dir=/opt/newme-staging/repository.git remote add origin \
    git@github.com:69755354/newme-platform.git
fi
chown -R root:newme-staging /opt/newme-staging/repository.git
chmod -R g+rX,o-rwx /opt/newme-staging/repository.git
install -m 0755 "$ROOT/scripts/deploy-staging.sh" /opt/newme-staging/control/deploy-staging.sh
install -m 0755 "$ROOT/scripts/run-staging-build.sh" /opt/newme-staging/control/run-staging-build.sh
install -m 0755 "$ROOT/scripts/check-staging-boundaries.sh" /opt/newme-staging/control/check-staging-boundaries.sh
install -m 0755 "$ROOT/scripts/run-staging-live-security-gate.sh" /opt/newme-staging/control/run-staging-live-security-gate.sh
install -m 0644 "$ROOT/supabase/security/check-authenticated-security-definer-rpc-allowlist.sql" /opt/newme-staging/control/check-authenticated-security-definer-rpc-allowlist.sql
install -m 0644 "$ROOT/infra/systemd/newme-staging.service" /etc/systemd/system/newme-staging.service
install -m 0644 "$ROOT/infra/systemd/newme-staging-build@.service" /etc/systemd/system/newme-staging-build@.service
install -m 0644 "$ROOT/infra/systemd/newme-staging-deploy@.service" /etc/systemd/system/newme-staging-deploy@.service

systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/newme-staging.service
systemd-analyze verify /etc/systemd/system/newme-staging-build@.service
systemd-analyze verify /etc/systemd/system/newme-staging-deploy@.service
echo "staging assets installed; runtime remains stopped until isolated GitHub trust, build.env, and a verified release exist"
