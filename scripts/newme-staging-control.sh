#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly ROOT="/opt/newme-staging"
readonly REPOSITORY="$ROOT/repository.git"
readonly RELEASES="$ROOT/releases"
readonly CURRENT="$ROOT/current"
readonly INCOMING="$ROOT/incoming"
readonly ENV_FILE="/etc/newme-staging/staging.env"
readonly DEPLOY_KEY="/etc/newme-staging/github_deploy_key"
readonly KNOWN_HOSTS="/etc/newme-staging/github_known_hosts"
readonly BRANCH="agent/saas-staging-isolation"
readonly SELF="/usr/local/sbin/newme-staging-control"
readonly SELF_SOURCE="scripts/newme-staging-control.sh"
readonly LOCK="/run/lock/newme-staging-control.lock"
readonly STATE_DIR="/var/lib/newme-staging-control"
readonly STATE_FILE="$STATE_DIR/last-deploy.state"
readonly STAGING_REF="bfsiibofuzoglziltgyd"
readonly PRODUCTION_REF="vfopmpxlhwzpxqegayew"
readonly SAM20_RUNNER="scripts/uat/sam20-lead-organization-isolation.mjs"
readonly SAM20_MIGRATION="supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql"
readonly UAT_IMAGE_PREFIX="newme-staging-uat"
TEMPORARY_PATHS=()

cleanup_temporary_paths() {
  local path
  for path in "${TEMPORARY_PATHS[@]}"; do
    [ -n "$path" ] && rm -rf -- "$path"
  done
}

register_temporary_path() {
  TEMPORARY_PATHS+=("$1")
}

trap cleanup_temporary_paths EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "staging control failed: $*" >&2
  exit 1
}

usage() {
  echo "usage: newme-staging-control build|deploy|uat|uat-sam20|rollback <40-character-sha>" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
readonly ACTION="$1"
readonly SHA="$2"
case "$ACTION" in
  build|deploy|uat|uat-sam20|rollback) ;;
  *) usage ;;
esac
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || usage
[ "$(id -u)" -eq 0 ] || fail "root is required"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "invalid staging branch"

for required_path in \
  "$REPOSITORY" \
  "$DEPLOY_KEY" \
  "$KNOWN_HOSTS" \
  "$SELF" \
  "$STATE_DIR"; do
  [ -e "$required_path" ] || fail "required staging control asset is missing"
done
[ -x "$SELF" ] || fail "installed staging controller is not executable"
[ "$(stat -c '%u:%g:%a' "$STATE_DIR")" = "0:0:700" ] ||
  fail "staging control state directory must be root:root mode 0700"

exec 9>"$LOCK"
flock -n 9 || fail "another staging control action is active"

export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"
git --git-dir="$REPOSITORY" fetch origin \
  "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
readonly CANONICAL_SHA="$(
  git --git-dir="$REPOSITORY" rev-parse "refs/remotes/origin/$BRANCH"
)"
[[ "$CANONICAL_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "canonical staging head is invalid"

readonly INSTALLED_CONTROLLER_BLOB="$(git hash-object "$SELF")"
readonly EXPECTED_CONTROLLER_BLOB="$(
  git --git-dir="$REPOSITORY" rev-parse "$CANONICAL_SHA:$SELF_SOURCE"
)"
[ "$INSTALLED_CONTROLLER_BLOB" = "$EXPECTED_CONTROLLER_BLOB" ] ||
  fail "installed controller blob does not match canonical staging head"
if [ "$ACTION" != "rollback" ]; then
  [ "$SHA" = "$CANONICAL_SHA" ] ||
    fail "target SHA must equal the canonical staging head"
fi

production_healthy() {
  curl -fsS --max-time 5 http://127.0.0.1:3001/api/health |
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"'
}

staging_healthy() {
  curl -fsS --max-time 5 http://127.0.0.1:3101/api/health |
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"'
}

manifest_sha() {
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f]{40}$/.test(value.git_sha)) process.exit(1);
    process.stdout.write(value.git_sha);
  ' "$1"
}

verify_release() {
  local sha="$1"
  local release="$RELEASES/$sha"
  [ -d "$release" ] || fail "immutable release is missing: $sha"
  [ -f "$release/server.js" ] || fail "immutable release server is missing: $sha"
  [ -f "$release/manifest.json" ] || fail "immutable release manifest is missing: $sha"
  [ "$(manifest_sha "$release/manifest.json")" = "$sha" ] ||
    fail "immutable release manifest does not match: $sha"
}

verify_current_release() {
  local sha="$1"
  verify_release "$sha"
  [ "$(readlink -f "$CURRENT" 2>/dev/null || true)" = "$RELEASES/$sha" ] ||
    fail "requested release is not the current staging release"
  staging_healthy || fail "current staging release is not healthy"
}

verify_unit_success() {
  local unit="$1"
  [ "$(systemctl show "$unit" --property=Result --value)" = "success" ] ||
    fail "systemd action did not succeed: $unit"
  [ "$(systemctl show "$unit" --property=ExecMainStatus --value)" = "0" ] ||
    fail "systemd action exited nonzero: $unit"
}

sam20_database_contract_absent() {
  [ -r "$ENV_FILE" ] || return 1
  local staging_url service_key compatibility_env rc
  staging_url="$(
    sed -n 's/^NEXT_PUBLIC_SUPABASE_URL=//p' "$ENV_FILE" | tail -n 1
  )"
  service_key="$(
    sed -n 's/^SUPABASE_SERVICE_ROLE_KEY=//p' "$ENV_FILE" | tail -n 1
  )"
  [ "$staging_url" = "https://$STAGING_REF.supabase.co" ] || return 1
  [[ "$staging_url" != *"$PRODUCTION_REF"* ]] || return 1
  [[ "$service_key" =~ ^sb_secret_[A-Za-z0-9_-]+$ ]] || return 1

  compatibility_env="$(mktemp "/run/newme-staging-db-compatibility.XXXXXX")"
  register_temporary_path "$compatibility_env"
  printf 'NEXT_PUBLIC_SUPABASE_URL=%s\nSUPABASE_SERVICE_ROLE_KEY=%s\n' \
    "$staging_url" "$service_key" >"$compatibility_env"
  chown root:newme-staging "$compatibility_env"
  chmod 0640 "$compatibility_env"

  rc=0
  runuser -u newme-staging -- env -i \
    HOME="$ROOT" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    /usr/bin/node --input-type=module --env-file="$compatibility_env" -e '
      const stagingRef = "bfsiibofuzoglziltgyd";
      const productionRef = "vfopmpxlhwzpxqegayew";
      const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (
        baseUrl !== `https://${stagingRef}.supabase.co` ||
        baseUrl.includes(productionRef) ||
        !/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey ?? "")
      ) process.exit(1);

      const probes = [
        ["GET", "/rest/v1/organizations?select=id&limit=0", "PGRST205"],
        ["GET", "/rest/v1/memberships?select=id&limit=0", "PGRST205"],
        ["GET", "/rest/v1/platform_staff?select=id&limit=0", "PGRST205"],
        ["GET", "/rest/v1/support_sessions?select=id&limit=0", "PGRST205"],
        ["GET", "/rest/v1/audit_events?select=id&limit=0", "PGRST205"],
        ["POST", "/rest/v1/rpc/requested_organization_id", "PGRST202"],
        ["GET", "/rest/v1/leads?select=organization_id&limit=0", "PGRST204"],
      ];
      for (const [method, path, expectedCode] of probes) {
        let response;
        try {
          response = await fetch(`${baseUrl}${path}`, {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
              ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
            },
            ...(method === "POST" ? { body: "{}" } : {}),
          });
        } catch {
          process.exit(1);
        }
        let body;
        try {
          body = await response.json();
        } catch {
          process.exit(1);
        }
        if (response.ok || body?.code !== expectedCode) process.exit(1);
      }
    ' >/dev/null 2>&1 || rc=$?
  rm -f -- "$compatibility_env"
  [ "$rc" -eq 0 ]
}

write_state() {
  local old_sha="$1"
  local new_sha="$2"
  local controller_sha="$3"
  local status="$4"
  local temporary
  temporary="$(mktemp "$STATE_DIR/.last-deploy.XXXXXX")"
  register_temporary_path "$temporary"
  printf 'old_sha=%s\nnew_sha=%s\ncontroller_sha=%s\nstatus=%s\n' \
    "$old_sha" "$new_sha" "$controller_sha" "$status" >"$temporary"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$STATE_FILE"
}

load_state() {
  [ -f "$STATE_FILE" ] || fail "deployment state is missing"
  [ "$(stat -c '%u:%g:%a' "$STATE_FILE")" = "0:0:600" ] ||
    fail "deployment state must be root:root mode 0600"
  STATE_OLD_SHA=""
  STATE_NEW_SHA=""
  STATE_CONTROLLER_SHA=""
  STATE_STATUS=""
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      old_sha) [ -z "$STATE_OLD_SHA" ] || fail "duplicate old_sha state"; STATE_OLD_SHA="$value" ;;
      new_sha) [ -z "$STATE_NEW_SHA" ] || fail "duplicate new_sha state"; STATE_NEW_SHA="$value" ;;
      controller_sha) [ -z "$STATE_CONTROLLER_SHA" ] || fail "duplicate controller_sha state"; STATE_CONTROLLER_SHA="$value" ;;
      status) [ -z "$STATE_STATUS" ] || fail "duplicate status state"; STATE_STATUS="$value" ;;
      *) fail "unknown deployment state field" ;;
    esac
  done <"$STATE_FILE"
  for state_sha in "$STATE_OLD_SHA" "$STATE_NEW_SHA" "$STATE_CONTROLLER_SHA"; do
    [[ "$state_sha" =~ ^[0-9a-f]{40}$ ]] || fail "deployment state contains an invalid SHA"
  done
  [ "$STATE_STATUS" = "deployed" ] || fail "deployment state is not rollback-eligible"
}

copy_commit_blob() {
  local sha="$1"
  local source="$2"
  local destination="$3"
  local blob
  blob="$(git --git-dir="$REPOSITORY" rev-parse "$sha:$source")" ||
    fail "required commit asset is missing: $source"
  git --git-dir="$REPOSITORY" cat-file blob "$blob" >"$destination"
}

build_uat_image() {
  command -v docker >/dev/null 2>&1 || fail "docker is required for staging UAT"
  local context
  context="$(mktemp -d "$ROOT/build/.uat-context-$SHA.XXXXXX")"
  register_temporary_path "$context"
  copy_commit_blob "$SHA" "infra/staging/uat-runner/Dockerfile" "$context/Dockerfile"
  copy_commit_blob "$SHA" "infra/staging/uat-runner/package.json" "$context/package.json"
  copy_commit_blob "$SHA" "infra/staging/uat-runner/package-lock.json" "$context/package-lock.json"
  copy_commit_blob "$SHA" "infra/staging/uat-runner/run.sh" "$context/run.sh"
  copy_commit_blob "$SHA" "scripts/verify-staging-sam26-roles.mjs" \
    "$context/verify-staging-sam26-roles.mjs"
  docker build \
    --label "org.opencontainers.image.revision=$SHA" \
    --tag "$UAT_IMAGE_PREFIX:$SHA" \
    --file "$context/Dockerfile" \
    "$context"
  [ "$(
    docker image inspect "$UAT_IMAGE_PREFIX:$SHA" \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
  )" = "$SHA" ] || fail "staging UAT image provenance does not match"
  rm -rf -- "$context"
}

run_build() {
  production_healthy || fail "production health is not green"
  local unit="newme-staging-build@$SHA.service"
  systemctl start "$unit"
  verify_unit_success "$unit"
  [ -f "$INCOMING/$SHA.tar.gz" ] || fail "staging artifact is missing"
  [ -f "$INCOMING/$SHA.tar.gz.sha256" ] || fail "staging artifact checksum is missing"
  build_uat_image
  echo "staging control build passed SHA=$SHA"
}

run_deploy() {
  production_healthy || fail "production health is not green"
  local previous old_sha unit
  previous="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  [[ "$previous" =~ ^$RELEASES/[0-9a-f]{40}$ ]] ||
    fail "current staging release is not an immutable release"
  old_sha="${previous##*/}"
  verify_current_release "$old_sha"
  unit="newme-staging-deploy@$SHA.service"
  systemctl start "$unit"
  verify_unit_success "$unit"
  verify_current_release "$SHA"
  production_healthy || fail "production health changed after staging deploy"
  write_state "$old_sha" "$SHA" "$CANONICAL_SHA" "deployed"
  echo "staging control deploy passed SHA=$SHA previous=$old_sha"
}

run_uat() {
  verify_current_release "$SHA"
  command -v docker >/dev/null 2>&1 || fail "docker is required for staging UAT"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  [ "$(
    docker image inspect "$UAT_IMAGE_PREFIX:$SHA" \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
  )" = "$SHA" ] || fail "staging UAT image provenance does not match"
  local output rc
  output="$(mktemp "$STATE_DIR/.uat-sam26.XXXXXX")"
  register_temporary_path "$output"
  rc=0
  docker run \
    --rm \
    --init \
    --ipc=host \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m \
    --tmpfs /runner/home:rw,nosuid,nodev,size=64m \
    --env-file "$ENV_FILE" \
    --env "SAM26_EXPECTED_RELEASE_SHA=$SHA" \
    --env "SAM26_BASE_URL=https://staging.newme.ae" \
    --env "SAM26_RELEASE_MANIFEST=/runner/release/manifest.json" \
    --mount "type=bind,src=$RELEASES/$SHA/manifest.json,dst=/runner/release/manifest.json,readonly" \
    "$UAT_IMAGE_PREFIX:$SHA" >"$output" 2>&1 || rc=$?
  rm -f -- "$output"
  [ "$rc" -eq 0 ] || fail "SAM-26 staging UAT failed with status $rc"
  echo "staging control UAT passed SHA=$SHA"
}

run_uat_sam20() {
  verify_current_release "$SHA"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  [ -d "$RELEASES/$SHA/node_modules/@supabase/supabase-js" ] ||
    fail "current release lacks the fixed SAM-20 runner dependency"
  local run_dir runner output rc
  run_dir="$(mktemp -d "/run/newme-staging-sam20-$SHA.XXXXXX")"
  runner="$run_dir/sam20-lead-organization-isolation.mjs"
  output="$(mktemp "$STATE_DIR/.uat-sam20.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  copy_commit_blob "$SHA" "$SAM20_RUNNER" "$runner"
  chown root:newme-staging "$run_dir" "$runner"
  chmod 0750 "$run_dir"
  chmod 0550 "$runner"
  ln -s "$RELEASES/$SHA/node_modules" "$run_dir/node_modules"
  rc=0
  runuser -u newme-staging -- env -i \
    HOME="$ROOT" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    NEWME_STAGING_ENV_FILE="$ENV_FILE" \
    SAM20_RUNNER_PATH="$runner" \
    SAM20_UAT_BASE_URL="https://staging.newme.ae" \
    SAM20_RELEASE_SHA="$SHA" \
    SAM20_RELEASE_MANIFEST="$RELEASES/$SHA/manifest.json" \
    SAM20_UAT_CONFIRM="SAM20_STAGING_ONLY" \
    /bin/bash -c \
      'set -a; . "$NEWME_STAGING_ENV_FILE"; set +a; exec /usr/bin/node "$SAM20_RUNNER_PATH"' \
    >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "SAM-20 staging UAT failed with status $rc"
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const required = [
      "organizations",
      "memberships",
      "leads",
      "platform_staff",
      "support_sessions",
      "audit_events",
      "profiles",
      "auth_fixtures",
    ];
    if (
      body.linearId !== "SAM-20" ||
      body.releaseSha !== process.argv[2] ||
      body.projectRef !== process.argv[3] ||
      body.cleanup !== "verified" ||
      required.some((key) => body.cleanupCounts?.[key] !== 0)
    ) process.exit(1);
  ' "$output" "$SHA" "$STAGING_REF" ||
    fail "SAM-20 UAT cleanup evidence is incomplete"
  rm -rf -- "$run_dir"
  rm -f -- "$output"
  echo "staging control SAM-20 UAT passed SHA=$SHA cleanup=verified"
}

run_rollback() {
  load_state
  [ "$SHA" = "$STATE_OLD_SHA" ] ||
    fail "rollback target is not the recorded direct previous release"
  [ "$STATE_NEW_SHA" = "$CANONICAL_SHA" ] ||
    fail "canonical staging head moved after the recorded deploy"
  [ "$STATE_CONTROLLER_SHA" = "$CANONICAL_SHA" ] ||
    fail "deployment state controller provenance does not match"
  verify_current_release "$STATE_NEW_SHA"
  verify_release "$STATE_OLD_SHA"

  if git --git-dir="$REPOSITORY" cat-file -e \
    "$STATE_NEW_SHA:$SAM20_MIGRATION" 2>/dev/null &&
    ! git --git-dir="$REPOSITORY" cat-file -e \
      "$STATE_OLD_SHA:$SAM20_MIGRATION" 2>/dev/null; then
    sam20_database_contract_absent ||
      fail "SAM-20 database contract may still be active; refusing an incompatible application-only rollback"
  fi

  production_healthy || fail "production health is not green"
  local next failed_next
  next="$CURRENT.rollback-$$"
  failed_next="$CURRENT.restore-$$"
  ln -s "$RELEASES/$STATE_OLD_SHA" "$next"
  mv -Tf "$next" "$CURRENT"
  systemctl restart newme-staging.service
  if ! staging_healthy || ! production_healthy; then
    ln -s "$RELEASES/$STATE_NEW_SHA" "$failed_next"
    mv -Tf "$failed_next" "$CURRENT"
    systemctl restart newme-staging.service
    staging_healthy || fail "rollback failed and the deployed release could not be restored"
    fail "rollback target failed health and the deployed release was restored"
  fi
  verify_current_release "$STATE_OLD_SHA"
  write_state "$STATE_OLD_SHA" "$STATE_NEW_SHA" "$STATE_CONTROLLER_SHA" "rolled_back"
  echo "staging control rollback passed SHA=$STATE_OLD_SHA from=$STATE_NEW_SHA"
}

case "$ACTION" in
  build) run_build ;;
  deploy) run_deploy ;;
  uat) run_uat ;;
  uat-sam20) run_uat_sam20 ;;
  rollback) run_rollback ;;
esac
