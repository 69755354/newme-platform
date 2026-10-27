#!/usr/bin/env bash
# =============================================================================
# Stand up a real GoTrue and measure what an administrator password reset does
# to the target's sessions.
# =============================================================================
# The environment behind scripts/gotrue-revocation-drill.mjs, which is the
# evidence cited by
# supabase/migrations/20260817120000_admin_reset_session_revocation.sql for
# round-4 finding A3. Read that file for what the three probes mean; this one
# only builds the thing they run against and tears it down again.
#
#   ./scripts/gotrue-revocation-drill.sh          run and clean up
#   KEEP=1 ./scripts/gotrue-revocation-drill.sh   leave the containers running
#
# Requires Docker, node and openssl. Not a CI gate: it pulls two large images and
# is a deliberate on-demand measurement, not part of `npm test`.
#
# Secrets: both the postgres password and the GoTrue JWT secret are generated
# fresh on every run, never written into the repository, and never passed as a
# command argument — the database gets its password through a docker environment
# pass-through and GoTrue reads its connection string from an --env-file in a
# temporary directory that is removed on exit. There is no credential in this
# file to leak, and by construction it cannot be pointed at a real project: the
# secret it signs tokens with is one it just invented.
#
# Ports and names default away from the interactive containers a developer may
# already have running, so this can be run without disturbing them.
# =============================================================================
set -euo pipefail

DB_IMAGE="${DB_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.158}"
GOTRUE_IMAGE="${GOTRUE_IMAGE:-public.ecr.aws/supabase/gotrue:v2.195.0}"
DB_NAME="${DB_NAME:-newme-auth-drill-db}"
GOTRUE_NAME="${GOTRUE_NAME:-newme-auth-drill-gotrue}"
NET_NAME="${NET_NAME:-newme-auth-drill-net}"
GOTRUE_PORT="${GOTRUE_PORT:-9998}"
KEEP="${KEEP:-0}"

# Docker on Windows/MSYS otherwise rewrites container-side paths.
export MSYS_NO_PATHCONV=1

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_dir=""

log() { printf '== %s\n' "$*"; }

cleanup() {
  local status=$?
  if [ -n "$env_dir" ]; then rm -rf "$env_dir"; fi
  if [ "$KEEP" = "1" ]; then
    log "KEEP=1: leaving $DB_NAME and $GOTRUE_NAME running (GoTrue on http://127.0.0.1:$GOTRUE_PORT)"
    log "remove them with: docker rm -f $GOTRUE_NAME $DB_NAME && docker network rm $NET_NAME"
  else
    docker rm -f "$GOTRUE_NAME" "$DB_NAME" >/dev/null 2>&1 || true
    docker network rm "$NET_NAME" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

for tool in docker node openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 2; }
done

# A previous interrupted run must not silently hand us a half-configured stack.
docker rm -f "$GOTRUE_NAME" "$DB_NAME" >/dev/null 2>&1 || true
docker network rm "$NET_NAME" >/dev/null 2>&1 || true

# Per-run, memory-only. Exported so docker can pass them through by name and the
# probe can sign with the same secret GoTrue verifies with.
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export GOTRUE_JWT_SECRET="$(openssl rand -hex 32)"
auth_admin_password="$(openssl rand -hex 16)"

log "network $NET_NAME"
docker network create "$NET_NAME" >/dev/null

log "postgres $DB_IMAGE as $DB_NAME"
docker run -d --name "$DB_NAME" --network "$NET_NAME" \
  -e POSTGRES_PASSWORD \
  "$DB_IMAGE" >/dev/null

# Readiness has to be TCP readiness, not socket readiness. This image runs an
# initdb phase whose server listens on the unix socket only, so a plain
# `pg_isready -U postgres` goes green while GoTrue — which connects over the
# network — still gets ECONNREFUSED and exits fatally on its first migration.
log "waiting for postgres to accept network connections"
for _ in $(seq 1 120); do
  if docker exec "$DB_NAME" pg_isready -h 127.0.0.1 -p 5432 -U postgres -q >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$DB_NAME" pg_isready -h 127.0.0.1 -p 5432 -U postgres -q || {
  echo "postgres did not start listening; last log lines:" >&2
  docker logs --tail 20 "$DB_NAME" >&2 || true
  exit 1
}

# GoTrue connects as supabase_auth_admin, which exists in this image but has no
# password. Set one over the container's local socket and via stdin, so it is
# never an argument to anything. It has to be supabase_admin that does it:
# supabase_auth_admin is a reserved role in this image and `postgres` is not a
# superuser here — the same asymmetry that made 20260817120000 assert the owner's
# privileges at apply time instead of assuming them.
printf "alter role supabase_auth_admin with login password '%s';\n" "$auth_admin_password" \
  | docker exec -i "$DB_NAME" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -f -

env_dir="$(mktemp -d)"
chmod 700 "$env_dir"
env_file="$env_dir/gotrue.env"
umask 077
cat >"$env_file" <<EOF
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:$auth_admin_password@$DB_NAME:5432/postgres
GOTRUE_DB_MIGRATIONS_PATH=/usr/local/etc/auth/migrations
GOTRUE_JWT_SECRET=$GOTRUE_JWT_SECRET
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_API_HOST=0.0.0.0
PORT=9999
API_EXTERNAL_URL=http://localhost:9999
GOTRUE_SITE_URL=http://localhost:3000
GOTRUE_DISABLE_SIGNUP=false
GOTRUE_MAILER_AUTOCONFIRM=true
GOTRUE_LOG_LEVEL=info
EOF

log "gotrue $GOTRUE_IMAGE as $GOTRUE_NAME on 127.0.0.1:$GOTRUE_PORT"
# The docker client is a native Windows binary under MSYS and cannot open a
# /tmp/... path, and MSYS_NO_PATHCONV (which the rest of this script needs) is
# exactly what stops the shell from translating it.
env_file_arg="$env_file"
if command -v cygpath >/dev/null 2>&1; then env_file_arg="$(cygpath -w "$env_file")"; fi
docker run -d --name "$GOTRUE_NAME" --network "$NET_NAME" \
  -p "127.0.0.1:$GOTRUE_PORT:9999" \
  --env-file "$env_file_arg" \
  "$GOTRUE_IMAGE" >/dev/null

log "waiting for gotrue (it runs its own auth-schema migrations first)"
GOTRUE_URL="http://127.0.0.1:$GOTRUE_PORT"
export GOTRUE_URL
if ! node --input-type=module -e '
const base = process.env.GOTRUE_URL;
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const response = await fetch(`${base}/health`);
    if (response.ok) { console.log(`   ${JSON.stringify(await response.json())}`); process.exit(0); }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
process.exit(1);
'; then
  echo "gotrue did not become healthy; last log lines:" >&2
  docker logs --tail 40 "$GOTRUE_NAME" >&2 || true
  exit 1
fi

log "probing"
# Same reason as the --env-file argument above: node is a native binary here and
# MSYS_NO_PATHCONV is what keeps the shell from translating the path for it.
probe="$repo_root/scripts/gotrue-revocation-drill.mjs"
if command -v cygpath >/dev/null 2>&1; then probe="$(cygpath -w "$probe")"; fi
AUTH_DB_CONTAINER="$DB_NAME" node "$probe"
