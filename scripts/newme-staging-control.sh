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
readonly SAM27_EVIDENCE="$STATE_DIR/last-uat-sam27.json"
readonly SAM52_EVIDENCE="$STATE_DIR/last-uat-sam52.json"
readonly SAM21_STATE_DIR="$STATE_DIR/sam21"
readonly SAM21_EVIDENCE="$STATE_DIR/last-uat-sam21.json"
readonly SAM23_EVIDENCE="$STATE_DIR/last-uat-sam23.json"
readonly SAM68_EVIDENCE="$STATE_DIR/last-uat-sam68.json"
readonly SAM54_EVIDENCE="$STATE_DIR/last-uat-sam54.json"
readonly SAM78_EVIDENCE="$STATE_DIR/last-migrate-sam78.json"
readonly SAM78_UAT_EVIDENCE="$STATE_DIR/last-uat-sam78.json"
readonly SAM78_UAT_FAILURE_EVIDENCE="$STATE_DIR/last-uat-sam78-failure.json"
readonly PRODUCT_SAAS_UAT_FAILURE_EVIDENCE="$STATE_DIR/last-uat-product-saas-failure.json"
readonly V4_ACCEPTANCE_RUNNER="scripts/uat/v4-staging-acceptance.mjs"
readonly V4_ACCEPTANCE_EVIDENCE="$STATE_DIR/last-uat-v4-acceptance.json"
readonly SAM87_RUNNER="scripts/verify-staging-sam87-release-rehearsal.mjs"
readonly SAM87_EVIDENCE="$STATE_DIR/last-rehearse-sam87.json"
readonly SAM87_COLD_RECOVERY_EVIDENCE="$STATE_DIR/last-cold-recover-sam87.json"
readonly SAM88_RUNNER="scripts/verify-staging-sam88-design-partner-pilot.mjs"
readonly SAM88_MANIFEST="$STATE_DIR/sam88-design-partner-pilot-manifest.json"
readonly SAM88_EVIDENCE="$STATE_DIR/last-validate-sam88-pilot.json"
readonly STAGING_REF="bfsiibofuzoglziltgyd"
readonly PRODUCTION_REF="vfopmpxlhwzpxqegayew"
readonly SAM20_RUNNER="scripts/uat/sam20-lead-organization-isolation.mjs"
readonly SAM20_MIGRATION="supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql"
readonly SAM21_CAPTURE="scripts/capture-staging-sam21-reconciliation.mjs"
readonly SAM21_VERIFY="scripts/verify-staging-sam21-migration-rehearsal.mjs"
readonly SAM21_RECONCILIATION="scripts/uat/sam21-readonly-reconciliation.sql"
readonly SAM21_PGPASS="/etc/newme-staging/sam21-db.pgpass"
readonly SAM20_ROLLBACK="supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql"
readonly SAM22_ROLLBACK="supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql"
readonly SAM22_RUNNER="scripts/uat/sam22-two-organization-isolation.mjs"
readonly SAM22_WEBHOOK_ROUTE="src/app/api/leads/meta-capi/route.ts"
readonly SAM23_RUNNER="scripts/uat/sam23-organization-commercial-core.mjs"
readonly SAM27_RUNNER="scripts/verify-staging-sam27-integrations.mjs"
readonly SAM27_LIBRARY="src/lib/integration-execution.mjs"
readonly SAM52_RUNNER="scripts/verify-staging-sam52-alert-bridge.mjs"
readonly SAM52_BRIDGE="src/lib/sentry-webhook-bridge.mjs"
readonly SAM68_RUNNER="scripts/verify-staging-sam68-observability.mjs"
readonly SAM54_RUNNER="scripts/verify-staging-sam54-diagnostics.mjs"
readonly SAM54_ALERT_STATE="infra/observability/hermes-alert-state-v1.sh"
readonly SAM78_EXECUTOR="scripts/run-staging-sam78-migrations.mjs"
readonly SAM78_VERIFY="scripts/uat/sam78-staging-migration-verify.sql"
readonly SAM78_HISTORY_MANIFEST="scripts/uat/sam78-canonical-migration-history.txt"
readonly SAM78_MIGRATION_031000="supabase/migrations/20260803100000_v4_tenant_capability_boundary.sql"
readonly SAM78_MIGRATION_143000="supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"
readonly SAM78_MIGRATION_041530="supabase/migrations/20260804153000_sam78_govern_v4_authenticated_rpcs.sql"
readonly SAM78_MIGRATION_041657="supabase/migrations/20260804165734_sam26_synthetic_audit_cleanup_boundary.sql"
readonly SAM78_MIGRATION_041853="supabase/migrations/20260804185311_sam80_shared_operational_services.sql"
readonly SAM78_MIGRATION_041930="supabase/migrations/20260804193000_sam20_synthetic_support_cleanup_boundary.sql"
readonly SAM78_MIGRATION_050000="supabase/migrations/20260805000000_sam78_product_saas_synthetic_cleanup_boundary.sql"
readonly SAM78_MIGRATION_050100="supabase/migrations/20260805010000_sam78_v4_exit_digest_contract.sql"
readonly SAM81_MIGRATION_050200="supabase/migrations/20260805020000_sam81_real_estate_listing_foundation.sql"
readonly SAM82_MIGRATION_051200="supabase/migrations/20260805120000_sam82_retail_catalog_inventory_pricing.sql"
readonly SAM83_MIGRATION_051300="supabase/migrations/20260805130000_sam83_retail_order_procurement_fulfillment_finance.sql"
readonly SAM79_MIGRATION_051900="supabase/migrations/20260805190000_v4_commercial_control_plane.sql"
readonly SAM84_MIGRATION_060000="supabase/migrations/20260806000000_sam84_controlled_agent_integration_gateway.sql"
readonly V4_MIGRATION_060100="supabase/migrations/20260806010000_v4_fix_membership_paid_seat_trigger.sql"
readonly SAM83_MIGRATION_060200="supabase/migrations/20260806020000_sam83_v4_synthetic_cleanup_boundary.sql"
readonly SAM83_MIGRATION_060300="supabase/migrations/20260806030000_sam83_v4_synthetic_cleanup_marker_case.sql"
readonly SAM84_MIGRATION_060400="supabase/migrations/20260806040000_sam84_v4_synthetic_gateway_cleanup_boundary.sql"
readonly SAM82_MIGRATION_060500="supabase/migrations/20260806050000_sam82_v4_synthetic_inventory_cleanup_boundary.sql"
readonly SAM78_MIGRATION_060600="supabase/migrations/20260806060000_sam78_product_saas_closed_cleanup_boundary.sql"
readonly SAM78_MIGRATION_060700="supabase/migrations/20260806070000_sam78_product_saas_inactive_audit_cleanup_boundary.sql"
readonly SAM78_MIGRATION_060800="supabase/migrations/20260806080000_sam78_product_saas_inactive_admin_cleanup_boundary.sql"
readonly SAM78_ROLLBACK_031000="supabase/rollback/20260803100000_v4_tenant_capability_boundary_rollback.sql"
readonly SAM78_ROLLBACK_143000="supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql"
readonly SAM78_ROLLBACK_041530="supabase/rollback/20260804153000_sam78_govern_v4_authenticated_rpcs_rollback.sql"
readonly SAM78_ROLLBACK_041657="supabase/rollback/20260804165734_sam26_synthetic_audit_cleanup_boundary_rollback.sql"
readonly SAM78_ROLLBACK_041853="supabase/rollback/20260804185311_sam80_shared_operational_services_rollback.sql"
readonly SAM78_ROLLBACK_041930="supabase/rollback/20260804193000_sam20_synthetic_support_cleanup_boundary_rollback.sql"
readonly SAM78_ROLLBACK_050000="supabase/rollback/20260805000000_sam78_product_saas_synthetic_cleanup_boundary_rollback.sql"
readonly SAM78_ROLLBACK_050100="supabase/rollback/20260805010000_sam78_v4_exit_digest_contract_rollback.sql"
readonly SAM81_ROLLBACK_050200="supabase/rollback/20260805020000_sam81_real_estate_listing_foundation_rollback.sql"
readonly SAM82_ROLLBACK_051200="supabase/rollback/20260805120000_sam82_retail_catalog_inventory_pricing_rollback.sql"
readonly SAM83_ROLLBACK_051300="supabase/rollback/20260805130000_sam83_retail_order_procurement_fulfillment_finance_rollback.sql"
readonly SAM79_ROLLBACK_051900="supabase/rollback/20260805190000_v4_commercial_control_plane_rollback.sql"
readonly SAM84_ROLLBACK_060000="supabase/rollback/20260806000000_sam84_controlled_agent_integration_gateway_rollback.sql"
readonly V4_ROLLBACK_060100="supabase/rollback/20260806010000_v4_fix_membership_paid_seat_trigger_rollback.sql"
readonly SAM83_ROLLBACK_060200="supabase/rollback/20260806020000_sam83_v4_synthetic_cleanup_boundary_rollback.sql"
readonly SAM83_ROLLBACK_060300="supabase/rollback/20260806030000_sam83_v4_synthetic_cleanup_marker_case_rollback.sql"
readonly SAM84_ROLLBACK_060400="supabase/rollback/20260806040000_sam84_v4_synthetic_gateway_cleanup_boundary_rollback.sql"
readonly SAM82_ROLLBACK_060500="supabase/rollback/20260806050000_sam82_v4_synthetic_inventory_cleanup_boundary_rollback.sql"
readonly SAM78_ROLLBACK_060600="supabase/rollback/20260806060000_sam78_product_saas_closed_cleanup_boundary_rollback.sql"
readonly SAM78_ROLLBACK_060700="supabase/rollback/20260806070000_sam78_product_saas_inactive_audit_cleanup_boundary_rollback.sql"
readonly SAM78_ROLLBACK_060800="supabase/rollback/20260806080000_sam78_product_saas_inactive_admin_cleanup_boundary_rollback.sql"
readonly SAM78_PGPASS="/etc/newme-staging/staging-migration.pgpass"
readonly SAM78_CA="/etc/newme-staging/supabase-root-2021-ca.crt"
readonly SAM78_PLATFORM_STAFF_ROLE_MAPPING="/etc/newme-staging/sam78-platform-staff-role-mapping.json"
readonly PRODUCT_SAAS_RUNNER="scripts/uat/product-saas-final.mjs"
readonly SAM78_UAT_RUNNER="scripts/uat/sam78-staging-tenant-closure.mjs"
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
  echo "usage: newme-staging-control build|deploy|cold-recover-sam87|uat|uat-sam20|reconcile-sam21|uat-sam21|uat-sam22|uat-sam23|uat-sam27|uat-sam52|uat-sam54|uat-sam68|uat-sam70|uat-product-saas|uat-sam78|uat-v4|migrate-sam78|rollback-sam78-db|rehearse-sam87|validate-sam88-pilot|rollback <40-character-sha>" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
readonly ACTION="$1"
readonly SHA="$2"
case "$ACTION" in
  build|deploy|cold-recover-sam87|uat|uat-sam20|reconcile-sam21|uat-sam21|uat-sam22|uat-sam23|uat-sam27|uat-sam52|uat-sam54|uat-sam68|uat-sam70|uat-product-saas|uat-sam78|uat-v4|migrate-sam78|rollback-sam78-db|rehearse-sam87|validate-sam88-pilot|rollback) ;;
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
  copy_commit_blob "$SHA" "scripts/verify-staging-sam70-xlsx.mjs" \
    "$context/verify-staging-sam70-xlsx.mjs"
  copy_commit_blob "$SHA" "$SAM23_RUNNER" \
    "$context/sam23-organization-commercial-core.mjs"
  copy_commit_blob "$SHA" "$PRODUCT_SAAS_RUNNER" \
    "$context/product-saas-final.mjs"
  copy_commit_blob "$SHA" "$SAM78_UAT_RUNNER" \
    "$context/sam78-staging-tenant-closure.mjs"
  copy_commit_blob "$SHA" "$V4_ACCEPTANCE_RUNNER" \
    "$context/v4-staging-acceptance.mjs"
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

require_sam78_apply_evidence() {
  [ -f "$SAM78_EVIDENCE" ] ||
    fail "SAM-87 cold recovery requires completed SAM-78 migration evidence"
  [ ! -L "$SAM78_EVIDENCE" ] ||
    fail "SAM-78 migration evidence must not be a symlink"
  [ "$(stat -c '%u:%g:%a' "$SAM78_EVIDENCE")" = "0:0:600" ] ||
    fail "SAM-78 migration evidence must be root:root mode 0600"
  /usr/bin/node -e '
    const fs = require("fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").trim().split(/\r?\n/);
    const versions = [
      "20260803100000", "20260803143000", "20260804153000",
      "20260804165734", "20260804185311", "20260804193000", "20260805000000",
      "20260805010000", "20260805020000", "20260805120000", "20260805130000",
      "20260805190000", "20260806000000", "20260806010000", "20260806020000", "20260806030000", "20260806040000", "20260806050000", "20260806060000", "20260806070000", "20260806080000",
    ];
    if (lines.length !== 1) process.exit(1);
    const body = JSON.parse(lines[0]);
    const appliedHistoryIsValid = Array.isArray(body?.alreadyAppliedVersions) &&
      Array.isArray(body?.appliedVersions) &&
      JSON.stringify([...body.alreadyAppliedVersions, ...body.appliedVersions]) === JSON.stringify(versions);
    if (
      body?.schemaVersion !== 1 ||
      body?.linearId !== "SAM-78" ||
      body?.releaseSha !== process.argv[2] ||
      body?.projectRef !== "bfsiibofuzoglziltgyd" ||
      body?.action !== "apply" ||
      body?.status !== "passed" ||
      body?.history !== "verified" ||
      JSON.stringify(body?.versions) !== JSON.stringify(versions) ||
      !appliedHistoryIsValid
    ) process.exit(1);
  ' "$SAM78_EVIDENCE" "$SHA" ||
    fail "SAM-78 migration evidence is incomplete for cold recovery"
}

require_sam87_cold_recovery_state() {
  [ -L "$CURRENT" ] ||
    fail "SAM-87 cold recovery requires a dangling current staging symlink"
  [ ! -e "$CURRENT" ] ||
    fail "SAM-87 cold recovery refuses a resolvable current staging release"
  local stale_target
  stale_target="$(readlink "$CURRENT")"
  [[ "$stale_target" =~ ^$RELEASES/[0-9a-f]{40}$ ]] ||
    fail "SAM-87 cold recovery refuses an unexpected current symlink target"
  [ ! -e "$STATE_FILE" ] ||
    fail "SAM-87 cold recovery refuses an existing rollback state"
  find "$RELEASES" -mindepth 1 -maxdepth 1 -print -quit | grep -q . &&
    fail "SAM-87 cold recovery requires an empty immutable release directory"
  local incoming expected_incoming entry_count artifact checksum
  artifact="$INCOMING/$SHA.tar.gz"
  checksum="$artifact.sha256"
  incoming="$(find "$INCOMING" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
  expected_incoming="$(printf '%s\n%s' "$SHA.tar.gz" "$SHA.tar.gz.sha256")"
  entry_count="$(printf '%s\n' "$incoming" | sed '/^$/d' | wc -l | tr -d ' ')"
  [ "$entry_count" = "2" ] ||
    fail "SAM-87 cold recovery requires only its exact build artifact pair"
  [ "$incoming" = "$expected_incoming" ] ||
    fail "SAM-87 cold recovery rejects stale or foreign build artifacts"
  [ -f "$artifact" ] && [ ! -L "$artifact" ] ||
    fail "SAM-87 cold recovery requires an exact SHA-bound build artifact"
  [ -f "$checksum" ] && [ ! -L "$checksum" ] ||
    fail "SAM-87 cold recovery requires an exact SHA-bound artifact checksum"
  staging_healthy ||
    fail "SAM-87 cold recovery requires the existing staging process to remain healthy until candidate validation"
}

run_sam87_cold_recovery() {
  production_healthy || fail "production health is not green"
  require_sam87_cold_recovery_state
  require_sam78_apply_evidence
  local artifact checksum artifact_sha256 unit evidence_tmp
  artifact="$INCOMING/$SHA.tar.gz"
  checksum="$artifact.sha256"
  artifact_sha256="$(tr -d '\r\n' < "$checksum")"
  [[ "$artifact_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    fail "SAM-87 cold recovery artifact checksum is invalid"
  [ "$(/usr/bin/sha256sum "$artifact" | awk '{print $1}')" = "$artifact_sha256" ] ||
    fail "SAM-87 cold recovery artifact checksum does not match"
  unit="newme-staging-deploy@$SHA.service"
  systemctl start "$unit"
  verify_unit_success "$unit"
  verify_current_release "$SHA"
  production_healthy || fail "production health changed after staging cold recovery"
  evidence_tmp="$(mktemp "$STATE_DIR/.last-cold-recover-sam87.XXXXXX")"
  register_temporary_path "$evidence_tmp"
  cat >"$evidence_tmp" <<EOF
{"schemaVersion":1,"linearId":"SAM-87","target":"staging-only","releaseSha":"$SHA","artifactSha256":"$artifact_sha256","previousRelease":null,"rollback":"not_available_cold_recovery","migrationEvidence":"verified","status":"passed"}
EOF
  chown root:root "$evidence_tmp"
  chmod 0600 "$evidence_tmp"
  mv -Tf "$evidence_tmp" "$SAM87_COLD_RECOVERY_EVIDENCE"
  echo "staging control SAM-87 cold recovery passed SHA=$SHA rollback=not_available"
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
    --network host \
    --add-host staging.newme.ae:127.0.0.1 \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m \
    --tmpfs /runner/home:rw,nosuid,nodev,size=64m \
    --env-file "$ENV_FILE" \
    --env "SAM_UAT_SUITE=sam26" \
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
  command -v docker >/dev/null 2>&1 || fail "docker is required for staging UAT"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  [ "$(
    docker image inspect "$UAT_IMAGE_PREFIX:$SHA" \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
  )" = "$SHA" ] || fail "staging UAT image provenance does not match"
  local run_dir runner output rc
  run_dir="$(mktemp -d "/run/newme-staging-sam20-$SHA.XXXXXX")"
  runner="$run_dir/sam20-lead-organization-isolation.mjs"
  output="$(mktemp "$STATE_DIR/.uat-sam20.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  copy_commit_blob "$SHA" "$SAM20_RUNNER" "$runner"
  chown root:root "$run_dir" "$runner"
  chmod 0755 "$run_dir"
  chmod 0555 "$runner"
  rc=0
  docker run \
    --rm \
    --init \
    --network host \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --tmpfs /runner/home:rw,nosuid,nodev,size=64m \
    --env-file "$ENV_FILE" \
    --env "HOME=/runner/home" \
    --env "SAM20_UAT_BASE_URL=http://127.0.0.1:3101" \
    --env "SAM20_RELEASE_SHA=$SHA" \
    --env "SAM20_RELEASE_MANIFEST=/runner/release/manifest.json" \
    --env "SAM20_UAT_CONFIRM=SAM20_STAGING_ONLY" \
    --mount "type=bind,src=$runner,dst=/runner/sam20-lead-organization-isolation.mjs,readonly" \
    --mount "type=bind,src=$RELEASES/$SHA/manifest.json,dst=/runner/release/manifest.json,readonly" \
    --entrypoint /usr/bin/node \
    "$UAT_IMAGE_PREFIX:$SHA" \
    /runner/sam20-lead-organization-isolation.mjs \
    >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "SAM-20 staging UAT failed with status $rc"
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const required = [
      "organizations",
      "memberships",
      "membership_roles",
      "leads",
      "platform_staff",
      "support_sessions",
      "platform_action_approvals",
      "platform_action_approval_events",
      "audit_events",
      "user_session_daily",
      "audit_logs",
      "profiles",
      "auth_fixtures",
    ];
    if (
      body.linearId !== "SAM-20" ||
      body.releaseSha !== process.argv[2] ||
      body.projectRef !== process.argv[3] ||
      body.cleanup !== "verified" ||
      body.results?.support?.boundedReasonAndExpiry !== 1 ||
      body.results?.support?.companyAdminDeniedPlatformRole !== 2 ||
      body.results?.support?.startAudit !== 1 ||
      body.results?.support?.objectAudit !== 1 ||
      body.results?.support?.endAudit !== 1 ||
      body.results?.support?.endedSessionDenied !== 1 ||
      body.results?.support?.independentApproval !== 1 ||
      body.results?.support?.approvalEvents !== 3 ||
      body.results?.support?.selfApprovalDenied !== 1 ||
      required.some((key) => body.cleanupCounts?.[key] !== 0)
    ) process.exit(1);
  ' "$output" "$SHA" "$STAGING_REF" ||
    fail "SAM-20 UAT cleanup evidence is incomplete"
  rm -rf -- "$run_dir"
  rm -f -- "$output"
  echo "staging control SAM-20 UAT passed SHA=$SHA cleanup=verified"
}

run_reconcile_sam21() {
  production_healthy || fail "production health is not green"
  staging_healthy || fail "staging health is not green"
  [ -x /usr/bin/psql ] || fail "psql is required for SAM-21 reconciliation"
  [ -f "$SAM21_PGPASS" ] ||
    fail "SAM-21 staging database password file is missing"
  [ ! -L "$SAM21_PGPASS" ] ||
    fail "SAM-21 staging database password file must not be a symlink"
  [ "$(stat -c '%u:%g:%a' "$SAM21_PGPASS")" = "0:0:600" ] ||
    fail "SAM-21 staging database password file must be root:root mode 0600"
  install -d -m 0700 -o root -g root "$SAM21_STATE_DIR"
  [ "$(stat -c '%u:%g:%a' "$SAM21_STATE_DIR")" = "0:0:700" ] ||
    fail "SAM-21 evidence directory must be root:root mode 0700"

  local run_dir capture reconciliation output sql_blob phase target rc
  run_dir="$(mktemp -d "/run/newme-staging-sam21-$SHA.XXXXXX")"
  capture="$run_dir/capture-staging-sam21-reconciliation.mjs"
  reconciliation="$run_dir/sam21-readonly-reconciliation.sql"
  output="$(mktemp "$SAM21_STATE_DIR/.reconciliation.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  copy_commit_blob "$SHA" "$SAM21_CAPTURE" "$capture"
  copy_commit_blob "$SHA" "$SAM21_RECONCILIATION" "$reconciliation"
  sql_blob="$(
    git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM21_RECONCILIATION"
  )"
  chown root:root "$run_dir" "$capture" "$reconciliation"
  chmod 0700 "$run_dir"
  chmod 0500 "$capture"
  chmod 0400 "$reconciliation"
  rc=0
  /usr/bin/env -i \
    HOME="/root" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    PGPASSFILE="$SAM21_PGPASS" \
    SAM21_EXPECTED_RELEASE_SHA="$SHA" \
    SAM21_PROJECT_REF="$STAGING_REF" \
    SAM21_SQL_BLOB="$sql_blob" \
    SAM21_SQL_PATH="$reconciliation" \
    /usr/bin/node "$capture" >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] ||
    fail "SAM-21 read-only staging reconciliation failed with status $rc"
  phase="$(
    node -e '
      const fs = require("fs");
      const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (
        body.schemaVersion !== 1 ||
        body.linearId !== "SAM-21" ||
        body.releaseSha !== process.argv[2] ||
        body.projectRef !== process.argv[3] ||
        body.sqlBlob !== process.argv[4] ||
        !["pre", "post"].includes(body.schemaPhase) ||
        body.evidence?.schema_phase !== body.schemaPhase ||
        body.evidence?.transaction_read_only !== true
      ) process.exit(1);
      process.stdout.write(body.schemaPhase);
    ' "$output" "$SHA" "$STAGING_REF" "$sql_blob"
  )" || fail "SAM-21 reconciliation evidence is incomplete"
  target="$SAM21_STATE_DIR/$SHA-$phase.json"
  [ ! -e "$target" ] ||
    fail "SAM-21 $phase reconciliation evidence already exists"
  chown root:root "$output"
  chmod 0600 "$output"
  mv -f "$output" "$target"
  rm -rf -- "$run_dir"
  echo "staging control SAM-21 reconciliation captured SHA=$SHA phase=$phase evidence=$target"
}

run_uat_sam21() {
  verify_current_release "$SHA"
  local pre post run_dir runner capture output sql_blob sam20_blob sam22_blob rc
  pre="$SAM21_STATE_DIR/$SHA-pre.json"
  post="$SAM21_STATE_DIR/$SHA-post.json"
  for snapshot in "$pre" "$post"; do
    [ -f "$snapshot" ] || fail "SAM-21 reconciliation snapshot is missing"
    [ ! -L "$snapshot" ] ||
      fail "SAM-21 reconciliation snapshot must not be a symlink"
    [ "$(stat -c '%u:%g:%a' "$snapshot")" = "0:0:600" ] ||
      fail "SAM-21 reconciliation snapshot must be root:root mode 0600"
  done
  run_dir="$(mktemp -d "/run/newme-staging-sam21-verify-$SHA.XXXXXX")"
  runner="$run_dir/verify-staging-sam21-migration-rehearsal.mjs"
  capture="$run_dir/capture-staging-sam21-reconciliation.mjs"
  output="$(mktemp "$STATE_DIR/.uat-sam21.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  copy_commit_blob "$SHA" "$SAM21_VERIFY" "$runner"
  copy_commit_blob "$SHA" "$SAM21_CAPTURE" "$capture"
  sql_blob="$(
    git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM21_RECONCILIATION"
  )"
  sam20_blob="$(
    git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM20_ROLLBACK"
  )"
  sam22_blob="$(
    git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM22_ROLLBACK"
  )"
  chown root:root "$run_dir" "$runner" "$capture"
  chmod 0700 "$run_dir"
  chmod 0500 "$runner"
  chmod 0400 "$capture"
  rc=0
  /usr/bin/env -i \
    HOME="/root" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    SAM21_EXPECTED_RELEASE_SHA="$SHA" \
    SAM21_SQL_BLOB="$sql_blob" \
    SAM21_PRE_EVIDENCE="$pre" \
    SAM21_POST_EVIDENCE="$post" \
    SAM21_SAM20_ROLLBACK_BLOB="$sam20_blob" \
    SAM21_SAM22_ROLLBACK_BLOB="$sam22_blob" \
    /usr/bin/node "$runner" >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "SAM-21 staging migration evidence gate failed"
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const preservation = [
      "aggregateCounts",
      "quotationValueTotal",
      "stageCounts",
      "leadOwners",
      "historyRelationships",
      "documentOwnership",
      "legacyLeadBackfill",
      "legacySnapshotBackfill",
      "activeMembershipBackfill",
      "migrationHistory",
    ];
    if (
      body.schemaVersion !== 1 ||
      body.linearId !== "SAM-21" ||
      body.releaseSha !== process.argv[2] ||
      body.projectRef !== process.argv[3] ||
      body.status !== "passed" ||
      preservation.some((key) => body.preservation?.[key] !== "verified") ||
      body.preservation?.orphanCounts !== "unchanged" ||
      body.rollback?.status !== "versioned_assets_verified" ||
      JSON.stringify(body.rollback?.order) !== JSON.stringify(["SAM-22", "SAM-20"]) ||
      body.productionReconciliation?.status !== "contract_ready_read_only" ||
      body.productionReconciliation?.pii !== "excluded" ||
      body.productionReconciliation?.executed !== false ||
      body.cleanup?.status !== "not_applicable" ||
      !Array.isArray(body.cleanup?.fixtureIds) ||
      body.cleanup.fixtureIds.length !== 0
    ) process.exit(1);
  ' "$output" "$SHA" "$STAGING_REF" ||
    fail "SAM-21 migration evidence is incomplete"
  chown root:root "$output"
  chmod 0600 "$output"
  mv -f "$output" "$SAM21_EVIDENCE"
  rm -rf -- "$run_dir"
  echo "staging control SAM-21 UAT passed SHA=$SHA evidence=$SAM21_EVIDENCE cleanup=not_applicable"
}

run_uat_sam22() {
  verify_current_release "$SHA"
  command -v docker >/dev/null 2>&1 || fail "docker is required for staging UAT"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  [ "$(
    docker image inspect "$UAT_IMAGE_PREFIX:$SHA" \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
  )" = "$SHA" ] || fail "staging UAT image provenance does not match"
  local run_dir runner webhook_route output rc
  run_dir="$(mktemp -d "/run/newme-staging-sam22-$SHA.XXXXXX")"
  runner="$run_dir/sam22-two-organization-isolation.mjs"
  webhook_route="$run_dir/meta-capi-route.ts"
  output="$(mktemp "$STATE_DIR/.uat-sam22.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  copy_commit_blob "$SHA" "$SAM22_RUNNER" "$runner"
  copy_commit_blob "$SHA" "$SAM22_WEBHOOK_ROUTE" "$webhook_route"
  chown root:root "$run_dir" "$runner" "$webhook_route"
  chmod 0755 "$run_dir"
  chmod 0555 "$runner"
  chmod 0444 "$webhook_route"
  rc=0
  docker run \
    --rm \
    --init \
    --network host \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --tmpfs /runner/home:rw,nosuid,nodev,size=64m \
    --env-file "$ENV_FILE" \
    --env "HOME=/runner/home" \
    --env "SAM22_UAT_BASE_URL=http://127.0.0.1:3101" \
    --env "SAM22_RELEASE_SHA=$SHA" \
    --env "SAM22_UAT_CONFIRM=SAM22_STAGING_ONLY" \
    --env "SAM22_WEBHOOK_ROUTE_PATH=/runner/meta-capi-route.ts" \
    --mount "type=bind,src=$runner,dst=/runner/sam22-two-organization-isolation.mjs,readonly" \
    --mount "type=bind,src=$webhook_route,dst=/runner/meta-capi-route.ts,readonly" \
    --mount "type=bind,src=$RELEASES/$SHA/manifest.json,dst=/runner/release/manifest.json,readonly" \
    --entrypoint /usr/bin/node \
    "$UAT_IMAGE_PREFIX:$SHA" \
    /runner/sam22-two-organization-isolation.mjs \
    >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "SAM-22 staging UAT failed with status $rc"
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const required = [
      "organizations",
      "memberships",
      "leads",
      "snapshots",
      "audit_events",
      "child_records",
      "user_session_daily",
      "audit_logs",
      "profiles",
      "auth_fixtures",
    ];
    const resultNames = [
      "list_search",
      "direct_id",
      "export",
      "import",
      "webhook",
      "cron",
      "dashboard",
      "member_admin",
    ];
    if (
      body.linearId !== "SAM-22" ||
      body.releaseSha !== process.argv[2] ||
      body.projectRef !== process.argv[3] ||
      body.cleanup !== "verified" ||
      resultNames.some((key) => body.results?.[key] === undefined) ||
      required.some((key) => body.cleanupCounts?.[key] !== 0)
    ) process.exit(1);
  ' "$output" "$SHA" "$STAGING_REF" ||
    fail "SAM-22 UAT evidence or cleanup is incomplete"
  rm -rf -- "$run_dir"
  rm -f -- "$output"
  echo "staging control SAM-22 UAT passed SHA=$SHA cleanup=verified"
}

run_uat_sam23() {
  verify_current_release "$SHA"
  command -v docker >/dev/null 2>&1 || fail "docker is required for staging UAT"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  [ "$(
    docker image inspect "$UAT_IMAGE_PREFIX:$SHA" \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
  )" = "$SHA" ] || fail "staging UAT image provenance does not match"
  local output rc evidence_tmp
  rm -f -- "$SAM23_EVIDENCE"
  output="$(mktemp "$STATE_DIR/.uat-sam23.XXXXXX")"
  register_temporary_path "$output"
  rc=0
  docker run \
    --rm \
    --init \
    --network host \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --tmpfs /runner/home:rw,nosuid,nodev,size=64m \
    --env-file "$ENV_FILE" \
    --env "HOME=/runner/home" \
    --env "SAM_UAT_SUITE=sam23" \
    --env "SAM23_UAT_BASE_URL=http://127.0.0.1:3101" \
    --env "SAM23_RELEASE_SHA=$SHA" \
    --env "SAM23_RELEASE_MANIFEST=/runner/release/manifest.json" \
    --env "SAM23_UAT_CONFIRM=SAM23_STAGING_ONLY" \
    --mount "type=bind,src=$RELEASES/$SHA/manifest.json,dst=/runner/release/manifest.json,readonly" \
    "$UAT_IMAGE_PREFIX:$SHA" >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "SAM-23 staging UAT failed with status $rc"
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const cleanupKeys = [
      "organizations",
      "memberships",
      "membership_roles",
      "provisioning_requests",
      "leads",
      "quotations",
      "contracts",
      "installment_plans",
      "payments",
      "contract_approvals",
      "payment_allocations",
      "projects",
      "tasks",
      "lead_documents",
      "activities",
      "business_events",
      "notifications",
      "follow_up_logs",
      "audit_events",
      "user_session_daily",
      "profiles",
      "auth_fixtures",
    ];
    const scopeKeys = [
      "organizations_by_marker",
      "provisioning_by_idempotency",
      "leads_by_marker",
      "quotations_by_marker",
      "contracts_by_marker",
      "projects_by_marker",
      "tasks_by_marker",
      "lead_documents_by_marker",
      "auth_users_by_marker",
    ];
    const exactZeroObject = (value, keys) =>
      value &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => value[key] === 0);
    const marker = new RegExp(
      `^sam23-${process.argv[2].slice(0, 8)}-` +
      "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-" +
      "[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      "i",
    );
    if (
      body.ok !== true ||
      body.issue !== "SAM-23" ||
      body.releaseSha !== process.argv[2] ||
      body.projectRef !== process.argv[3] ||
      !marker.test(body.marker ?? "") ||
      body.results?.initialization?.organizations !== 2 ||
      body.results?.initialization?.idempotentReplays !== 2 ||
      body.results?.initialization?.payloadMismatchRejected !== true ||
      body.results?.billableSeats?.organizationA !== 1 ||
      body.results?.billableSeats?.organizationB !== 2 ||
      body.results?.billableSeats?.viewerFree !== true ||
      body.results?.billableSeats?.sameUserCountedPerOrganization !== true ||
      body.results?.commercialBoundary?.tables !== 10 ||
      body.results?.commercialBoundary?.ownRowsVisible !== 20 ||
      body.results?.commercialBoundary?.crossRowsHidden !== 20 ||
      body.results?.commercialBoundary?.crossParentRejected !== true ||
      body.results?.commercialBoundary?.crossAssigneeRejected !== true ||
      body.results?.commercialBoundary?.missingContextHidden !== true ||
      body.results?.commercialBoundary?.reporting !== "verified" ||
      body.cleanup !== "verified" ||
      !exactZeroObject(body.cleanupCounts, cleanupKeys) ||
      !exactZeroObject(body.cleanupScopeCounts, scopeKeys)
    ) process.exit(1);
  ' "$output" "$SHA" "$STAGING_REF" ||
    fail "SAM-23 UAT evidence or cleanup is incomplete"
  evidence_tmp="$(mktemp "$STATE_DIR/.last-uat-sam23.XXXXXX")"
  register_temporary_path "$evidence_tmp"
  install -m 0600 -o root -g root "$output" "$evidence_tmp"
  mv -Tf "$evidence_tmp" "$SAM23_EVIDENCE"
  rm -f -- "$output"
  echo "staging control SAM-23 UAT passed SHA=$SHA cleanup=verified evidence=$SAM23_EVIDENCE"
}

run_uat_sam27() {
  verify_current_release "$SHA"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  local run_dir runner library output rc
  run_dir="$(mktemp -d "/run/newme-staging-sam27-$SHA.XXXXXX")"
  runner="$run_dir/scripts/verify-staging-sam27-integrations.mjs"
  library="$run_dir/src/lib/integration-execution.mjs"
  output="$(mktemp "$STATE_DIR/.uat-sam27.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  mkdir -p "$run_dir/scripts" "$run_dir/src/lib"
  copy_commit_blob "$SHA" "$SAM27_RUNNER" "$runner"
  copy_commit_blob "$SHA" "$SAM27_LIBRARY" "$library"
  chown -R root:root "$run_dir"
  chmod 0700 "$run_dir" "$run_dir/scripts" "$run_dir/src" "$run_dir/src/lib"
  chmod 0500 "$runner"
  chmod 0400 "$library"
  rc=0
  /usr/bin/env -i \
    HOME="/root" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    SAM27_EXPECTED_RELEASE_SHA="$SHA" \
    /usr/bin/node "$runner" >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "SAM-27 staging UAT failed with status $rc"
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const disabled = body.disabledIntegrations;
    const synthetic = body.syntheticExecution;
    const exactOutcomes = (actual, expected) =>
      Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]);
    if (
      body.schemaVersion !== 1 ||
      body.linearId !== "SAM-27" ||
      body.releaseSha !== process.argv[2] ||
      body.target !== "staging-loopback" ||
      body.health?.status !== "passed" ||
      body.health?.httpStatus !== 200 ||
      !exactOutcomes(body.health?.responseFields, ["status"]) ||
      disabled?.metaOAuthStart?.status !== "disabled" ||
      disabled?.metaOAuthStart?.httpStatus !== 503 ||
      disabled?.metaOAuthCallback?.status !== "disabled" ||
      disabled?.metaOAuthCallback?.httpStatus !== 503 ||
      disabled?.metaCapi?.status !== "disabled" ||
      disabled?.metaCapi?.httpStatus !== 503 ||
      disabled?.productionCallbackContacted !== false ||
      synthetic?.mode !== "versioned_in_process_contract" ||
      synthetic?.recovered?.status !== "passed" ||
      synthetic?.recovered?.attempts !== 2 ||
      !exactOutcomes(synthetic?.recovered?.auditOutcomes, ["retry", "success"]) ||
      synthetic?.recovered?.finalAlerts !== 0 ||
      synthetic?.terminal?.status !== "passed" ||
      synthetic?.terminal?.attempts !== 1 ||
      !exactOutcomes(synthetic?.terminal?.auditOutcomes, ["failure"]) ||
      synthetic?.terminal?.finalAlerts !== 1 ||
      synthetic?.exhausted?.status !== "passed" ||
      synthetic?.exhausted?.attempts !== 3 ||
      !exactOutcomes(
        synthetic?.exhausted?.auditOutcomes,
        ["retry", "retry", "failure"],
      ) ||
      synthetic?.exhausted?.finalAlerts !== 1 ||
      body.cleanup?.status !== "not_applicable" ||
      body.cleanup?.reason !==
        "read_only_disabled_routes_and_in_process_synthetic_contract" ||
      !Array.isArray(body.cleanup?.fixtureIds) ||
      body.cleanup.fixtureIds.length !== 0
    ) process.exit(1);
  ' "$output" "$SHA" ||
    fail "SAM-27 UAT evidence is incomplete"
  chown root:root "$output"
  chmod 0600 "$output"
  mv -f "$output" "$SAM27_EVIDENCE"
  rm -rf -- "$run_dir"
  echo "staging control SAM-27 UAT passed SHA=$SHA evidence=$SAM27_EVIDENCE cleanup=not_applicable meta=disabled"
}

run_uat_sam54() {
  verify_current_release "$SHA"
  local run_dir runner alert_state state_dir output rc marker synthetic_alert
  run_dir="$(mktemp -d "/run/newme-staging-sam54-$SHA.XXXXXX")"
  runner="$run_dir/verify-staging-sam54-diagnostics.mjs"
  alert_state="$run_dir/hermes-alert-state-v1.sh"
  state_dir="$run_dir/state"
  output="$(mktemp "$STATE_DIR/.uat-sam54.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  copy_commit_blob "$SHA" "$SAM54_RUNNER" "$runner"
  copy_commit_blob "$SHA" "$SAM54_ALERT_STATE" "$alert_state"
  mkdir -m 0700 "$state_dir"
  chown root:root "$run_dir" "$state_dir" "$runner" "$alert_state"
  chmod 0700 "$run_dir"
  chmod 0500 "$runner" "$alert_state"
  marker="sam54-${SHA:0:12}"
  synthetic_alert="$(
    printf \
      '{"schemaVersion":1,"source":"sam54-staging-uat","type":"diagnostic.requested","target":"staging","reason":"synthetic_acceptance","releaseSha":"%s","marker":"%s"}' \
      "$SHA" "$marker"
  )"
  for attempt in 1 2; do
    rc=0
    /usr/bin/env -i \
      HOME="/root" \
      PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      HERMES_ALERT_CONFIG="$run_dir/no-host-config.env" \
      HERMES_ALERT_STATE_DIR="$state_dir" \
      HERMES_ALERT_THRESHOLD="2" \
      HERMES_ALERT_NOTIFIER="/usr/bin/true" \
      HERMES_ALERT_DIAGNOSTIC="$runner" \
      HERMES_ALERT_DIAGNOSTIC_INTERPRETER="/usr/bin/node" \
      SAM54_EXPECTED_RELEASE_SHA="$SHA" \
      SAM54_SYNTHETIC_ALERT="$synthetic_alert" \
      /usr/bin/bash "$alert_state" \
        "sam54-staging-uat" "failure" "synthetic_acceptance" \
        >>"$output" 2>&1 || rc=$?
    [ "$rc" -eq 0 ] ||
      fail "SAM-54 alert-to-diagnostic staging UAT failed with status $rc on attempt $attempt"
  done
  node -e '
    const fs = require("fs");
    const transcript = fs.readFileSync(process.argv[1], "utf8");
    const lines = transcript.split(/\r?\n/).filter(Boolean);
    const bodies = [];
    for (const line of lines) {
      try {
        const body = JSON.parse(line);
        if (body?.linearId === "SAM-54") bodies.push(body);
      } catch {}
    }
    if (
      bodies.length !== 1 ||
      !lines.some((line) =>
        /transition=below-threshold .*failure_count=1$/.test(line)
      ) ||
      !lines.some((line) =>
        /transition=alert .*diagnostic=complete capture=1$/.test(line)
      )
    ) process.exit(1);
    const body = bodies[0];
    const disk = body.checks?.disk;
    const journal = body.checks?.journal;
    const fixedExecutables = body.safety?.fixedExecutables;
    if (
      body.schemaVersion !== 1 ||
      body.linearId !== "SAM-54" ||
      body.releaseSha !== process.argv[2] ||
      body.target !== "staging-loopback" ||
      body.automaticDispatch !== true ||
      body.trigger?.alertKey !== "sam54-staging-uat" ||
      body.trigger?.source !== "sam54-staging-uat" ||
      body.trigger?.type !== "diagnostic.requested" ||
      body.trigger?.marker !== `sam54-${process.argv[2].slice(0, 12)}` ||
      body.checks?.service?.unit !== "newme-staging.service" ||
      body.checks?.service?.state !== "active" ||
      body.checks?.service?.active !== true ||
      body.checks?.health?.httpStatus !== 200 ||
      body.checks?.health?.status !== "ok" ||
      body.checks?.authMe?.httpStatus !== 401 ||
      journal?.unit !== "newme-staging.service" ||
      journal?.windowMinutes !== 15 ||
      !Number.isInteger(journal?.entries) ||
      journal.entries < 0 ||
      !Number.isInteger(journal?.unauthorizedMatches) ||
      journal.unauthorizedMatches < 0 ||
      !Number.isInteger(journal?.errorMatches) ||
      journal.errorMatches < 0 ||
      disk?.root !== "/opt/newme-staging" ||
      !Number.isInteger(disk?.usedPercent) ||
      disk.usedPercent < 0 ||
      disk.usedPercent > 100 ||
      disk?.alertThresholdPercent !== 90 ||
      disk?.overThreshold !== (disk.usedPercent >= 90) ||
      !Number.isSafeInteger(disk?.stagingBytes) ||
      disk.stagingBytes < 0 ||
      JSON.stringify(fixedExecutables) !==
        JSON.stringify(["systemctl", "journalctl", "df", "du"]) ||
      body.safety?.mode !== "read_only" ||
      body.safety?.secretsRead !== false ||
      body.safety?.mutationAttempted !== false ||
      body.cleanup?.status !== "not_applicable" ||
      body.cleanup?.reason !== "read_only_diagnostics" ||
      !Array.isArray(body.cleanup?.fixtureIds) ||
      body.cleanup.fixtureIds.length !== 0
    ) process.exit(1);
    fs.writeFileSync(process.argv[1], `${JSON.stringify(body)}\n`, {
      mode: 0o600,
    });
  ' "$output" "$SHA" ||
    fail "SAM-54 automatic alert dispatch evidence is incomplete"
  chown root:root "$output"
  chmod 0600 "$output"
  mv -f "$output" "$SAM54_EVIDENCE"
  rm -rf -- "$run_dir"
  echo "staging control SAM-54 UAT passed SHA=$SHA evidence=$SAM54_EVIDENCE dispatch=alert-state cleanup=not_applicable mode=read_only"
}

run_uat_sam52() {
  verify_current_release "$SHA"
  local run_dir runner bridge output rc
  run_dir="$(mktemp -d "/run/newme-staging-sam52-$SHA.XXXXXX")"
  runner="$run_dir/scripts/verify-staging-sam52-alert-bridge.mjs"
  bridge="$run_dir/src/lib/sentry-webhook-bridge.mjs"
  output="$(mktemp "$STATE_DIR/.uat-sam52.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  install -d -m 0700 -o root -g root "$run_dir/scripts" "$run_dir/src/lib"
  copy_commit_blob "$SHA" "$SAM52_RUNNER" "$runner"
  copy_commit_blob "$SHA" "$SAM52_BRIDGE" "$bridge"
  chown root:root "$run_dir" "$runner" "$bridge"
  chmod 0700 "$run_dir"
  chmod 0500 "$runner"
  chmod 0400 "$bridge"
  rc=0
  /usr/bin/env -i \
    HOME="/root" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    SAM52_EXPECTED_RELEASE_SHA="$SHA" \
    /usr/bin/node "$runner" >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "SAM-52 staging UAT failed with status $rc"
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const digest = body.bridge?.evidenceDigest;
    const required = [
      "sentry_alert_rule_owner",
      "sentry_service_hook_secret",
      "hermes_destination_owner",
      "wecom_or_telegram_credentials",
    ];
    if (
      body.schemaVersion !== 1 ||
      body.linearId !== "SAM-52" ||
      body.releaseSha !== process.argv[2] ||
      body.target !== "staging-local-synthetic" ||
      body.bridge?.status !== "passed" ||
      body.bridge?.signature !== "verified" ||
      body.bridge?.schema !== "strict" ||
      body.bridge?.replay !== "deduplicated" ||
      body.bridge?.retryAttempts !== 3 ||
      body.bridge?.audit !== "redacted" ||
      !/^[0-9a-f]{64}$/.test(digest ?? "") ||
      body.external?.status !== "blocked" ||
      body.external?.reason !== "third_party_configuration_not_authorized" ||
      !Array.isArray(body.external?.required) ||
      required.some((value) => !body.external.required.includes(value)) ||
      body.cleanup?.status !== "not_applicable" ||
      body.cleanup?.reason !==
        "synthetic_in_memory_transport_and_replay_store" ||
      !Array.isArray(body.cleanup?.fixtureIds) ||
      body.cleanup.fixtureIds.length !== 0
    ) process.exit(1);
  ' "$output" "$SHA" ||
    fail "SAM-52 UAT evidence is incomplete"
  chown root:root "$output"
  chmod 0600 "$output"
  mv -f "$output" "$SAM52_EVIDENCE"
  rm -rf -- "$run_dir"
  echo "staging control SAM-52 UAT passed SHA=$SHA evidence=$SAM52_EVIDENCE external=blocked cleanup=not_applicable"
}

run_uat_sam68() {
  verify_current_release "$SHA"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  local run_dir runner output rc
  run_dir="$(mktemp -d "/run/newme-staging-sam68-$SHA.XXXXXX")"
  runner="$run_dir/verify-staging-sam68-observability.mjs"
  output="$(mktemp "$STATE_DIR/.uat-sam68.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  copy_commit_blob "$SHA" "$SAM68_RUNNER" "$runner"
  chown root:root "$run_dir" "$runner"
  chmod 0700 "$run_dir"
  chmod 0500 "$runner"
  rc=0
  /usr/bin/env -i \
    HOME="/root" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    SAM68_EXPECTED_RELEASE_SHA="$SHA" \
    /usr/bin/node "$runner" >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "SAM-68 staging UAT failed with status $rc"
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const readinessElapsed = body.readiness?.elapsedMs;
    const journalEntries = body.observability?.journald?.entries;
    if (
      body.schemaVersion !== 1 ||
      body.linearId !== "SAM-68" ||
      body.releaseSha !== process.argv[2] ||
      body.target !== "staging-loopback" ||
      body.monitoring?.status !== "passed" ||
      body.monitoring?.httpStatus !== 410 ||
      body.monitoring?.cacheControl !== "no-store, max-age=0" ||
      body.monitoring?.hostileBodyPersisted !== false ||
      body.readiness?.status !== "passed" ||
      body.readiness?.httpStatus !== 200 ||
      body.readiness?.cacheControl !== "no-store, max-age=0" ||
      body.readiness?.timeoutMs !== 3000 ||
      !Number.isInteger(readinessElapsed) ||
      readinessElapsed < 0 ||
      readinessElapsed > 3000 ||
      body.observability?.journald?.status !== "observed" ||
      body.observability?.journald?.unit !== "newme-staging.service" ||
      !Number.isInteger(journalEntries) ||
      journalEntries < 0 ||
      body.observability?.journald?.hostileMarkerMatches !== 0 ||
      body.observability?.journald?.errorMatches !== 0 ||
      body.observability?.sentry?.status !== "not_applicable" ||
      body.observability?.sentry?.reason !==
        "staging_sentry_disabled_by_isolation_contract" ||
      body.cleanup?.status !== "not_applicable" ||
      body.cleanup?.reason !== "read_only_http_and_journal_observation" ||
      !Array.isArray(body.cleanup?.fixtureIds) ||
      body.cleanup.fixtureIds.length !== 0
    ) process.exit(1);
  ' "$output" "$SHA" ||
    fail "SAM-68 UAT evidence is incomplete"
  chown root:root "$output"
  chmod 0600 "$output"
  mv -f "$output" "$SAM68_EVIDENCE"
  rm -rf -- "$run_dir"
  echo "staging control SAM-68 UAT passed SHA=$SHA evidence=$SAM68_EVIDENCE cleanup=not_applicable sentry=not_applicable"
}

run_uat_sam70() {
  verify_current_release "$SHA"
  command -v docker >/dev/null 2>&1 || fail "docker is required for staging UAT"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  [ "$(
    docker image inspect "$UAT_IMAGE_PREFIX:$SHA" \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
  )" = "$SHA" ] || fail "staging UAT image provenance does not match"
  local output rc evidence
  output="$(mktemp "$STATE_DIR/.uat-sam70.XXXXXX")"
  register_temporary_path "$output"
  rc=0
  docker run \
    --rm \
    --init \
    --ipc=host \
    --network host \
    --add-host staging.newme.ae:127.0.0.1 \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m \
    --tmpfs /runner/home:rw,nosuid,nodev,size=64m \
    --env-file "$ENV_FILE" \
    --env "SAM_UAT_SUITE=sam70" \
    --env "SAM70_EXPECTED_RELEASE_SHA=$SHA" \
    --env "SAM70_BASE_URL=https://staging.newme.ae" \
    --env "SAM70_RELEASE_MANIFEST=/runner/release/manifest.json" \
    --env "SAM70_UAT_CONFIRM=SAM70_STAGING_ONLY" \
    --mount "type=bind,src=$RELEASES/$SHA/manifest.json,dst=/runner/release/manifest.json,readonly" \
    "$UAT_IMAGE_PREFIX:$SHA" >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "SAM-70 staging UAT failed with status $rc"
  evidence="$(
    node -e '
      const fs = require("fs");
      const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const requiredCases = [
        "unauthenticated import endpoints return 401",
        "non-management import endpoints return 403",
        "admin import succeeds with exact IDs and batch",
        "boss idempotent replay creates no duplicate",
        "requests over 5 MiB fail closed",
        "2,001 rows fail closed",
        "prototype-pollution keys fail closed",
        "normal workbook reaches authenticated preview",
        "corrupt workbook is rejected before preview",
        "workbook over 5 MiB is rejected before preview",
        "quotation export enforces ownership and management access",
      ];
      const zeroResidue = [
        "leads",
        "follow_up_logs",
        "quotations",
        "profiles",
        "auth_fixtures",
        "organizations",
        "memberships",
        "user_session_daily",
        "audit_logs",
      ];
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const marker = /^SAM70-UAT-[0-9a-f]{16}-[0-9a-f]{8}$/;
      const passed = new Set(
        Array.isArray(body.cases)
          ? body.cases
            .filter((item) => item?.status === "pass")
            .map((item) => item.name)
          : [],
      );
      if (
        body.ok !== true ||
        body.linearId !== "SAM-70" ||
        body.releaseSha !== process.argv[2] ||
        body.projectRef !== process.argv[3] ||
        body.cleanup !== "verified" ||
        !marker.test(body.marker ?? "") ||
        !uuid.test(body.initialBatchId ?? "") ||
        !uuid.test(body.idempotentBatchId ?? "") ||
        !Array.isArray(body.importedIds) ||
        body.importedIds.length !== 1 ||
        !uuid.test(body.importedIds[0] ?? "") ||
        requiredCases.some((name) => !passed.has(name)) ||
        zeroResidue.some((key) => body.cleanupCounts?.[key] !== 0)
      ) process.exit(1);
      process.stdout.write(
        `marker=${body.marker} initial_batch=${body.initialBatchId} `
        + `idempotent_batch=${body.idempotentBatchId} imported_id=${body.importedIds[0]}`,
      );
    ' "$output" "$SHA" "$STAGING_REF"
  )" || fail "SAM-70 UAT evidence or cleanup verification is incomplete"
  rm -f -- "$output"
  echo "staging control SAM-70 UAT passed SHA=$SHA $evidence cleanup=verified"
}

run_uat_product_saas() {
  verify_current_release "$SHA"
  command -v docker >/dev/null 2>&1 || fail "docker is required for staging UAT"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  [ "$(
    docker image inspect "$UAT_IMAGE_PREFIX:$SHA" \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
  )" = "$SHA" ] || fail "staging UAT image provenance does not match"
  local output rc evidence evidence_tmp failure_tmp
  evidence="$STATE_DIR/last-uat-product-saas.json"
  rm -f -- "$evidence"
  output="$(mktemp "$STATE_DIR/.uat-product-saas.XXXXXX")"
  register_temporary_path "$output"
  rc=0
  docker run \
    --rm \
    --init \
    --ipc=host \
    --network host \
    --add-host staging.newme.ae:127.0.0.1 \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m \
    --tmpfs /runner/home:rw,nosuid,nodev,size=64m \
    --env-file "$ENV_FILE" \
    --env "SAM_UAT_SUITE=product-saas-final" \
    --env "PRODUCT_UAT_RELEASE_SHA=$SHA" \
    --env "PRODUCT_UAT_BASE_URL=https://staging.newme.ae" \
    --env "PRODUCT_UAT_RELEASE_MANIFEST=/runner/release/manifest.json" \
    --env "PRODUCT_UAT_CONFIRM=PRODUCT_SAAS_STAGING_ONLY" \
    --mount "type=bind,src=$RELEASES/$SHA/manifest.json,dst=/runner/release/manifest.json,readonly" \
    "$UAT_IMAGE_PREFIX:$SHA" >"$output" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    failure_tmp="$(mktemp "$STATE_DIR/.last-uat-product-saas-failure.XXXXXX")"
    register_temporary_path "$failure_tmp"
    /usr/bin/node - "$output" "$failure_tmp" "$SHA" "$rc" <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const [output, destination, releaseSha, exitCode] = process.argv.slice(2);
const raw = fs.readFileSync(output, "utf8");
const allowedIds = new Set([
  "SAM-11", "SAM-13", "SAM-25", "SAM-35", "SAM-49", "SAM-61", "SAM-79", "CUSTOMER-EXIT",
]);
let diagnostic = {
  output_kind: "unparseable",
  cleanup: null,
  failed_result_ids: [],
  failure_stage: null,
  failure_code: null,
};
try {
  const body = JSON.parse(raw);
  if (body?.scope === "product-saas-final" && body?.ok === false && body?.results && typeof body.results === "object") {
    const failedResultIds = Object.entries(body.results)
      .filter(([id, result]) => allowedIds.has(id) && result?.status === "fail")
      .map(([id]) => id)
      .sort();
    diagnostic = {
      output_kind: "product_saas_report",
      cleanup: ["verified", "failed", "not-run"].includes(body.cleanup) ? body.cleanup : null,
      failed_result_ids: failedResultIds,
      failure_stage: ["prepare", "cleanup"].includes(body?.failure?.stage) ? body.failure.stage : null,
      failure_code: typeof body?.failure?.code === "string" && /^[a-z0-9_:-]{1,160}$/.test(body.failure.code) ? body.failure.code : null,
    };
  }
} catch {}
const evidence = {
  schema_version: 1,
  scope: "product-saas-final-failure",
  release_sha: releaseSha,
  runner_exit: Number(exitCode),
  ...diagnostic,
  raw_sha256: crypto.createHash("sha256").update(raw).digest("hex"),
};
fs.writeFileSync(destination, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
NODE
    chown root:root "$failure_tmp"
    chmod 0600 "$failure_tmp"
    mv -Tf "$failure_tmp" "$PRODUCT_SAAS_UAT_FAILURE_EVIDENCE"
    fail "Product/SaaS staging UAT failed with status $rc; root-only failure evidence was recorded"
  fi
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const requiredIssues = ["SAM-11", "SAM-13", "SAM-25", "SAM-35", "SAM-49", "SAM-61", "SAM-79", "CUSTOMER-EXIT"];
    const zeroResidue = [
      "auth_users",
      "profiles",
      "organizations",
      "memberships",
      "support_sessions",
      "organization_exit_requests",
      "platform_staff",
      "platform_action_approvals",
      "platform_action_approval_events",
      "leads",
      "audit_logs",
      "activity_logs",
      "activities",
      "user_session_daily",
      "quotations",
      "contracts",
      "payments",
      "projects",
      "installment_plans",
      "contract_approvals",
      "payment_allocations",
      "pipeline_notifications",
      "lead_children",
    ];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const sam25 = body.results?.["SAM-25"]?.evidence;
    const customerExit = body.results?.["CUSTOMER-EXIT"]?.evidence;
    const chain = sam25?.positive_chain;
    const negative = sam25?.negative_matrix;
    const negativeCases = new Map([
      ["hermes_unauthenticated", 401],
      ["draft_conversion", 400],
      ["finance_conversion", 403],
      ["duplicate_conversion", 409],
      ["zero_amount_payment", 400],
      ["operator_confirmation", 403],
    ]);
    if (
      body.ok !== true ||
      body.scope !== "product-saas-final" ||
      !uuid.test(body.run_id ?? "") ||
      body.release?.project !== process.argv[3] ||
      body.release?.release_sha !== process.argv[2] ||
      body.release?.health !== 200 ||
      body.cleanup !== "verified" ||
      requiredIssues.some((id) => body.results?.[id]?.status !== "pass") ||
      !uuid.test(customerExit?.exit_request_id ?? "") ||
      !/^[0-9a-f]{64}$/.test(customerExit?.export_sha256 ?? "") ||
      customerExit?.organization_status !== "closed" ||
      customerExit?.active_memberships !== 0 ||
      customerExit?.support_session_status !== "revoked" ||
      !(customerExit?.retained_leads > 0) ||
      customerExit?.completion_retry !== "idempotent" ||
      customerExit?.data_deleted !== false ||
      !uuid.test(chain?.lead_id ?? "") ||
      !uuid.test(chain?.quotation_id ?? "") ||
      !uuid.test(chain?.contract_id ?? "") ||
      !uuid.test(chain?.payment_id ?? "") ||
      !uuid.test(chain?.project_id ?? "") ||
      !Array.isArray(chain?.installment_plan_ids) ||
      chain.installment_plan_ids.length !== 1 ||
      !uuid.test(chain.installment_plan_ids[0] ?? "") ||
      !Array.isArray(chain?.payment_allocation_ids) ||
      chain.payment_allocation_ids.length !== 1 ||
      !uuid.test(chain.payment_allocation_ids[0] ?? "") ||
      !/^NM-\d{4}-\d{4,}$/.test(chain?.quote_no ?? "") ||
      !/^NEW-\d{8}-\d{3,}$/.test(chain?.contract_no ?? "") ||
      !(chain?.total_aed > 0) ||
      chain?.payment_confirmed !== true ||
      !(chain?.project_paid_amount > 0) ||
      chain?.product_quantity !== 1 ||
      !Number.isInteger(chain?.task_count) ||
      chain.task_count < 0 ||
      !Number.isInteger(chain?.notification_count) ||
      chain.notification_count < 0 ||
      !Array.isArray(negative) ||
      negative.length !== negativeCases.size ||
      new Set(negative.map((item) => item?.name)).size !== negativeCases.size ||
      negative.some((item) => (
        negativeCases.get(item?.name) !== item?.status ||
        item?.writes !== 0
      )) ||
      zeroResidue.some((key) => body.cleanupCounts?.[key] !== 0)
    ) process.exit(1);
  ' "$output" "$SHA" "$STAGING_REF" ||
    fail "Product/SaaS UAT evidence or cleanup verification is incomplete"
  evidence_tmp="$(mktemp "$STATE_DIR/.last-uat-product-saas.XXXXXX")"
  register_temporary_path "$evidence_tmp"
  install -m 0600 -o root -g root "$output" "$evidence_tmp"
  mv -Tf "$evidence_tmp" "$evidence"
  rm -f -- "$output"
  echo "staging control Product/SaaS UAT passed SHA=$SHA cleanup=verified evidence=$evidence"
}

run_uat_sam78() {
  verify_current_release "$SHA"
  command -v docker >/dev/null 2>&1 || fail "docker is required for staging UAT"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  [ "$(
    docker image inspect "$UAT_IMAGE_PREFIX:$SHA" \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
  )" = "$SHA" ] || fail "staging UAT image provenance does not match"
  local output rc evidence evidence_tmp
  evidence="$SAM78_UAT_EVIDENCE"
  rm -f -- "$evidence"
  output="$(mktemp "$STATE_DIR/.uat-sam78.XXXXXX")"
  register_temporary_path "$output"
  rc=0
  docker run \
    --rm \
    --init \
    --ipc=host \
    --network host \
    --add-host staging.newme.ae:127.0.0.1 \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m \
    --tmpfs /runner/home:rw,nosuid,nodev,size=64m \
    --env-file "$ENV_FILE" \
    --env "SAM_UAT_SUITE=sam78" \
    --env "SAM78_EXPECTED_RELEASE_SHA=$SHA" \
    --env "SAM78_BASE_URL=http://127.0.0.1:3101" \
    --env "SAM78_RELEASE_MANIFEST=/runner/release/manifest.json" \
    --env "SAM78_UAT_CONFIRM=SAM78_STAGING_TENANT_CLOSURE_ONLY" \
    --env "PRODUCT_UAT_RELEASE_SHA=$SHA" \
    --env "PRODUCT_UAT_BASE_URL=https://staging.newme.ae" \
    --env "PRODUCT_UAT_RELEASE_MANIFEST=/runner/release/manifest.json" \
    --env "PRODUCT_UAT_CONFIRM=PRODUCT_SAAS_STAGING_ONLY" \
    --mount "type=bind,src=$RELEASES/$SHA/manifest.json,dst=/runner/release/manifest.json,readonly" \
    "$UAT_IMAGE_PREFIX:$SHA" >"$output" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    failure_tmp="$(mktemp "$STATE_DIR/.last-uat-sam78-failure.XXXXXX")"
    register_temporary_path "$failure_tmp"
    /usr/bin/node - "$output" "$failure_tmp" "$SHA" "$rc" <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const [output, destination, releaseSha, exitCode] = process.argv.slice(2);
const raw = fs.readFileSync(output, "utf8");
let runnerFailure = {
  failure_code: "runner_nonzero_without_allowlisted_code",
  failure_kind: "UnknownError",
  runner_origin: null,
};
try {
  const body = JSON.parse(raw);
  const code = body?.failure?.code;
  const kind = body?.failure?.kind;
  const origin = body?.failure?.runner_origin;
  if (
    body?.ok === false &&
    body?.scope === "sam78-staging-tenant-closure" &&
    typeof code === "string" && /^[a-z0-9_:-]{1,160}$/.test(code) &&
    typeof kind === "string" && /^[A-Za-z][A-Za-z0-9]{0,48}$/.test(kind) &&
    (origin === null || (typeof origin === "string" && /^\/runner\/[a-z0-9-]+\.mjs:\d+:\d+$/.test(origin)))
  ) runnerFailure = { failure_code: code, failure_kind: kind, runner_origin: origin };
} catch {}
const evidence = {
  schema_version: 1,
  scope: "sam78-staging-tenant-closure-failure",
  release_sha: releaseSha,
  runner_exit: Number(exitCode),
  ...runnerFailure,
  raw_sha256: crypto.createHash("sha256").update(raw).digest("hex"),
};
fs.writeFileSync(destination, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
NODE
    chown root:root "$failure_tmp"
    chmod 0600 "$failure_tmp"
    mv -Tf "$failure_tmp" "$SAM78_UAT_FAILURE_EVIDENCE"
    fail "SAM-78 staging tenant-closure UAT failed with status $rc; root-only failure evidence was recorded"
  fi
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const requiredChecks = ["selected_org", "search", "direct_id", "organization_row"];
    const zeroResidue = [
      "auth_users", "profiles", "organizations", "memberships", "membership_roles",
      "leads", "audit_events", "audit_logs", "activity_logs", "activities",
    ];
    if (
      body.ok !== true ||
      body.scope !== "sam78-staging-tenant-closure" ||
      body.release?.project_ref !== process.argv[3] ||
      body.release?.manifest_sha !== process.argv[2] ||
      body.release?.health !== 200 ||
      body.product_lifecycle?.status !== "pass" ||
      body.product_lifecycle?.cleanup !== "verified" ||
      body.product_lifecycle?.customer_exit !== "pass" ||
      body.tenant_isolation?.status !== "pass" ||
      body.tenant_isolation?.organizations !== 2 ||
      body.tenant_isolation?.shared_identity_memberships !== 2 ||
      requiredChecks.some((check) => !body.tenant_isolation?.checks?.includes(check)) ||
      zeroResidue.some((key) => body.tenant_isolation?.cleanup_counts?.[key] !== 0) ||
      body.cleanup !== "verified"
    ) process.exit(1);
  ' "$output" "$SHA" "$STAGING_REF" ||
    fail "SAM-78 staging tenant-closure evidence is incomplete"
  evidence_tmp="$(mktemp "$STATE_DIR/.last-uat-sam78.XXXXXX")"
  register_temporary_path "$evidence_tmp"
  install -m 0600 -o root -g root "$output" "$evidence_tmp"
  mv -Tf "$evidence_tmp" "$evidence"
  rm -f -- "$output"
  echo "staging control SAM-78 tenant-closure UAT passed SHA=$SHA cleanup=verified evidence=$evidence"
}

# The V4 acceptance action is intentionally one runner rather than four
# loosely coupled commands.  It keeps the exact release/image provenance,
# marker-only fixture scope and residue verification in one atomic evidence
# record.  The controller never prints the runner output or staging env.
run_uat_v4() {
  verify_current_release "$SHA"
  command -v docker >/dev/null 2>&1 || fail "docker is required for staging UAT"
  [ -r "$ENV_FILE" ] || fail "staging environment is missing"
  [ "$(
    docker image inspect "$UAT_IMAGE_PREFIX:$SHA" \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
  )" = "$SHA" ] || fail "staging UAT image provenance does not match"
  local output rc evidence_tmp
  rm -f -- "$V4_ACCEPTANCE_EVIDENCE"
  output="$(mktemp "$STATE_DIR/.uat-v4.XXXXXX")"
  register_temporary_path "$output"
  rc=0
  docker run \
    --rm \
    --init \
    --network host \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --tmpfs /runner/home:rw,nosuid,nodev,size=64m \
    --env-file "$ENV_FILE" \
    --env "HOME=/runner/home" \
    --env "SAM_UAT_SUITE=v4-acceptance" \
    --env "V4_UAT_RELEASE_SHA=$SHA" \
    --env "V4_UAT_BASE_URL=http://127.0.0.1:3101" \
    --env "V4_UAT_RELEASE_MANIFEST=/runner/release/manifest.json" \
    --env "V4_UAT_CONFIRM=V4_STAGING_ACCEPTANCE_ONLY" \
    --mount "type=bind,src=$RELEASES/$SHA/manifest.json,dst=/runner/release/manifest.json,readonly" \
    "$UAT_IMAGE_PREFIX:$SHA" >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "V4 staging acceptance runner failed with status $rc"
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const scenarios = ["SAM-81", "SAM-83", "SAM-84", "SAM-86"];
    const cleanup = ["organizations", "auth", "memberships", "membershipRoles", "parties", "properties", "listings", "assets", "locations", "skus", "leads", "quotations", "orders", "orderItems", "purchaseOrders", "purchaseItems", "receipts", "receiptItems", "handoffs", "codEvents", "allocations", "reconciliations"];
    if (
      body.ok !== true ||
      body.schema_version !== 1 ||
      body.scope !== "v4-staging-acceptance" ||
      body.release?.project_ref !== process.argv[3] ||
      body.release?.release_sha !== process.argv[2] ||
      body.release?.health !== 200 ||
      scenarios.some((key) => body.scenarios?.[key]?.status !== "pass" || body.scenarios?.[key]?.marker_only !== true) ||
      body.scenarios?.["SAM-81"]?.external_publish_state !== "disabled" ||
      body.scenarios?.["SAM-83"]?.receipt_idempotency !== "verified" ||
      body.scenarios?.["SAM-83"]?.order !== "accepted" ||
      body.scenarios?.["SAM-83"]?.fulfillment !== "completed" ||
      body.scenarios?.["SAM-83"]?.finance !== "reconciled" ||
      body.scenarios?.["SAM-84"]?.adapters !== "disabled" ||
      body.scenarios?.["SAM-86"]?.release_sha !== process.argv[2] ||
      body.cleanup?.status !== "verified" ||
      cleanup.some((key) => body.cleanup?.counts?.[key] !== 0)
    ) process.exit(1);
  ' "$output" "$SHA" "$STAGING_REF" ||
    fail "V4 staging acceptance evidence or cleanup is incomplete"
  evidence_tmp="$(mktemp "$STATE_DIR/.last-uat-v4.XXXXXX")"
  register_temporary_path "$evidence_tmp"
  install -m 0600 -o root -g root "$output" "$evidence_tmp"
  mv -Tf "$evidence_tmp" "$V4_ACCEPTANCE_EVIDENCE"
  rm -f -- "$output"
  echo "staging control V4 acceptance passed SHA=$SHA cleanup=verified evidence=$V4_ACCEPTANCE_EVIDENCE"
}

run_sam78_database_action() {
  production_healthy || fail "production health is not green"
  staging_healthy || fail "staging health is not green"
  [ -x /usr/bin/node ] || fail "node is required for SAM-78 migration execution"
  [ -x /usr/bin/psql ] || fail "psql is required for SAM-78 migration execution"
  [ -x /usr/bin/sha256sum ] || fail "sha256sum is required for SAM-78 provenance"
  [ -f "$SAM78_PGPASS" ] || fail "SAM-78 staging database password file is missing"
  [ ! -L "$SAM78_PGPASS" ] || fail "SAM-78 staging database password file must not be a symlink"
  [ "$(stat -c '%u:%g:%a' "$SAM78_PGPASS")" = "0:0:600" ] ||
    fail "SAM-78 staging database password file must be root:root mode 0600"
  [ -f "$SAM78_CA" ] || fail "SAM-78 Supabase CA is missing"
  [ ! -L "$SAM78_CA" ] || fail "SAM-78 Supabase CA must not be a symlink"
  [ "$(stat -c '%u:%g:%a' "$SAM78_CA")" = "0:0:600" ] ||
    fail "SAM-78 Supabase CA must be root:root mode 0600"

  local database_action
  case "$ACTION" in
    migrate-sam78) database_action="apply" ;;
    rollback-sam78-db) database_action="rollback" ;;
    *) fail "invalid SAM-78 database action" ;;
  esac
  local platform_staff_role_mapping_checksum=""
  if [ "$database_action" = "apply" ]; then
    [ -f "$SAM78_PLATFORM_STAFF_ROLE_MAPPING" ] ||
      fail "SAM-78 platform staff role mapping is missing"
    [ ! -L "$SAM78_PLATFORM_STAFF_ROLE_MAPPING" ] ||
      fail "SAM-78 platform staff role mapping must not be a symlink"
    [ "$(stat -c '%u:%g:%a' "$SAM78_PLATFORM_STAFF_ROLE_MAPPING")" = "0:0:600" ] ||
      fail "SAM-78 platform staff role mapping must be root:root mode 0600"
    platform_staff_role_mapping_checksum="$(
      /usr/bin/sha256sum "$SAM78_PLATFORM_STAFF_ROLE_MAPPING" | awk '{print $1}'
    )"
    [[ "$platform_staff_role_mapping_checksum" =~ ^[0-9a-f]{64}$ ]] ||
      fail "SAM-78 platform staff role mapping checksum is invalid"
  fi

  local artifact="$INCOMING/$SHA.tar.gz"
  local checksum="$artifact.sha256"
  [ -f "$artifact" ] || fail "SAM-78 build artifact is missing"
  [ ! -L "$artifact" ] || fail "SAM-78 build artifact must not be a symlink"
  [ -f "$checksum" ] || fail "SAM-78 build artifact checksum is missing"
  [ ! -L "$checksum" ] || fail "SAM-78 build artifact checksum must not be a symlink"
  local expected_checksum actual_checksum
  expected_checksum="$(tr -d '\r\n' < "$checksum")"
  [[ "$expected_checksum" =~ ^[0-9a-f]{64}$ ]] ||
    fail "SAM-78 build artifact checksum must be lowercase SHA-256"
  actual_checksum="$(/usr/bin/sha256sum "$artifact" | awk '{print $1}')"
  [ "$actual_checksum" = "$expected_checksum" ] ||
    fail "SAM-78 build artifact checksum mismatch"

  local run_dir executor verify history_manifest
  local migration_031000 migration_143000 migration_041530 migration_041657 migration_041853 migration_041930 migration_050000 migration_050100 migration_050200 migration_051200 migration_051300 migration_051900 migration_060000 migration_060100 migration_060200 migration_060300 migration_060400 migration_060500 migration_060600 migration_060700 migration_060800
  local rollback_031000 rollback_143000 rollback_041530 rollback_041657 rollback_041853 rollback_041930 rollback_050000 rollback_050100 rollback_050200 rollback_051200 rollback_051300 rollback_051900 rollback_060000 rollback_060100 rollback_060200 rollback_060300 rollback_060400 rollback_060500 rollback_060600 rollback_060700 rollback_060800
  local output rc evidence_tmp
  local verify_blob history_manifest_blob
  local migration_031000_blob migration_143000_blob migration_041530_blob migration_041657_blob migration_041853_blob migration_041930_blob migration_050000_blob migration_050100_blob migration_050200_blob migration_051200_blob migration_051300_blob migration_051900_blob migration_060000_blob migration_060100_blob migration_060200_blob migration_060300_blob migration_060400_blob migration_060500_blob migration_060600_blob migration_060700_blob migration_060800_blob
  local rollback_031000_blob rollback_143000_blob rollback_041530_blob rollback_041657_blob rollback_041853_blob rollback_041930_blob rollback_050000_blob rollback_050100_blob rollback_050200_blob rollback_051200_blob rollback_051300_blob rollback_051900_blob rollback_060000_blob rollback_060100_blob rollback_060200_blob rollback_060300_blob rollback_060400_blob rollback_060500_blob rollback_060600_blob rollback_060700_blob rollback_060800_blob
  run_dir="$(mktemp -d "/run/newme-staging-sam78-$SHA.XXXXXX")"
  executor="$run_dir/run-staging-sam78-migrations.mjs"
  verify="$run_dir/sam78-staging-migration-verify.sql"
  history_manifest="$run_dir/sam78-canonical-migration-history.txt"
  migration_031000="$run_dir/20260803100000.sql"
  migration_143000="$run_dir/20260803143000.sql"
  migration_041530="$run_dir/20260804153000.sql"
  migration_041657="$run_dir/20260804165734.sql"
  migration_041853="$run_dir/20260804185311.sql"
  migration_041930="$run_dir/20260804193000.sql"
  migration_050000="$run_dir/20260805000000.sql"
  migration_050100="$run_dir/20260805010000.sql"
  migration_050200="$run_dir/20260805020000.sql"
  migration_051200="$run_dir/20260805120000.sql"
  migration_051300="$run_dir/20260805130000.sql"
  migration_051900="$run_dir/20260805190000.sql"
  migration_060000="$run_dir/20260806000000.sql"
  migration_060100="$run_dir/20260806010000.sql"
  migration_060200="$run_dir/20260806020000.sql"
  migration_060300="$run_dir/20260806030000.sql"
  migration_060400="$run_dir/20260806040000.sql"
  migration_060500="$run_dir/20260806050000.sql"
  migration_060600="$run_dir/20260806060000.sql"
  migration_060700="$run_dir/20260806070000.sql"
  migration_060800="$run_dir/20260806080000.sql"
  rollback_031000="$run_dir/20260803100000.rollback.sql"
  rollback_143000="$run_dir/20260803143000.rollback.sql"
  rollback_041530="$run_dir/20260804153000.rollback.sql"
  rollback_041657="$run_dir/20260804165734.rollback.sql"
  rollback_041853="$run_dir/20260804185311.rollback.sql"
  rollback_041930="$run_dir/20260804193000.rollback.sql"
  rollback_050000="$run_dir/20260805000000.rollback.sql"
  rollback_050100="$run_dir/20260805010000.rollback.sql"
  rollback_050200="$run_dir/20260805020000.rollback.sql"
  rollback_051200="$run_dir/20260805120000.rollback.sql"
  rollback_051300="$run_dir/20260805130000.rollback.sql"
  rollback_051900="$run_dir/20260805190000.rollback.sql"
  rollback_060000="$run_dir/20260806000000.rollback.sql"
  rollback_060100="$run_dir/20260806010000.rollback.sql"
  rollback_060200="$run_dir/20260806020000.rollback.sql"
  rollback_060300="$run_dir/20260806030000.rollback.sql"
  rollback_060400="$run_dir/20260806040000.rollback.sql"
  rollback_060500="$run_dir/20260806050000.rollback.sql"
  rollback_060600="$run_dir/20260806060000.rollback.sql"
  rollback_060700="$run_dir/20260806070000.rollback.sql"
  rollback_060800="$run_dir/20260806080000.rollback.sql"
  output="$(mktemp "$STATE_DIR/.sam78-database-action.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"

  copy_commit_blob "$SHA" "$SAM78_EXECUTOR" "$executor"
  copy_commit_blob "$SHA" "$SAM78_VERIFY" "$verify"
  copy_commit_blob "$SHA" "$SAM78_HISTORY_MANIFEST" "$history_manifest"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_031000" "$migration_031000"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_143000" "$migration_143000"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_041530" "$migration_041530"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_041657" "$migration_041657"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_041853" "$migration_041853"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_041930" "$migration_041930"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_050000" "$migration_050000"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_050100" "$migration_050100"
  copy_commit_blob "$SHA" "$SAM81_MIGRATION_050200" "$migration_050200"
  copy_commit_blob "$SHA" "$SAM82_MIGRATION_051200" "$migration_051200"
  copy_commit_blob "$SHA" "$SAM83_MIGRATION_051300" "$migration_051300"
  copy_commit_blob "$SHA" "$SAM79_MIGRATION_051900" "$migration_051900"
  copy_commit_blob "$SHA" "$SAM84_MIGRATION_060000" "$migration_060000"
  copy_commit_blob "$SHA" "$V4_MIGRATION_060100" "$migration_060100"
  copy_commit_blob "$SHA" "$SAM83_MIGRATION_060200" "$migration_060200"
  copy_commit_blob "$SHA" "$SAM83_MIGRATION_060300" "$migration_060300"
  copy_commit_blob "$SHA" "$SAM84_MIGRATION_060400" "$migration_060400"
  copy_commit_blob "$SHA" "$SAM82_MIGRATION_060500" "$migration_060500"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_060600" "$migration_060600"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_060700" "$migration_060700"
  copy_commit_blob "$SHA" "$SAM78_MIGRATION_060800" "$migration_060800"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_031000" "$rollback_031000"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_143000" "$rollback_143000"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_041530" "$rollback_041530"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_041657" "$rollback_041657"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_041853" "$rollback_041853"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_041930" "$rollback_041930"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_050000" "$rollback_050000"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_050100" "$rollback_050100"
  copy_commit_blob "$SHA" "$SAM81_ROLLBACK_050200" "$rollback_050200"
  copy_commit_blob "$SHA" "$SAM82_ROLLBACK_051200" "$rollback_051200"
  copy_commit_blob "$SHA" "$SAM83_ROLLBACK_051300" "$rollback_051300"
  copy_commit_blob "$SHA" "$SAM79_ROLLBACK_051900" "$rollback_051900"
  copy_commit_blob "$SHA" "$SAM84_ROLLBACK_060000" "$rollback_060000"
  copy_commit_blob "$SHA" "$V4_ROLLBACK_060100" "$rollback_060100"
  copy_commit_blob "$SHA" "$SAM83_ROLLBACK_060200" "$rollback_060200"
  copy_commit_blob "$SHA" "$SAM83_ROLLBACK_060300" "$rollback_060300"
  copy_commit_blob "$SHA" "$SAM84_ROLLBACK_060400" "$rollback_060400"
  copy_commit_blob "$SHA" "$SAM82_ROLLBACK_060500" "$rollback_060500"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_060600" "$rollback_060600"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_060700" "$rollback_060700"
  copy_commit_blob "$SHA" "$SAM78_ROLLBACK_060800" "$rollback_060800"
  verify_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_VERIFY")"
  history_manifest_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_HISTORY_MANIFEST")"
  migration_031000_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_031000")"
  migration_143000_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_143000")"
  migration_041530_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_041530")"
  migration_041657_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_041657")"
  migration_041853_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_041853")"
  migration_041930_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_041930")"
  migration_050000_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_050000")"
  migration_050100_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_050100")"
  migration_050200_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM81_MIGRATION_050200")"
  migration_051200_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM82_MIGRATION_051200")"
  migration_051300_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM83_MIGRATION_051300")"
  migration_051900_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM79_MIGRATION_051900")"
  migration_060000_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM84_MIGRATION_060000")"
  migration_060100_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$V4_MIGRATION_060100")"
  migration_060200_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM83_MIGRATION_060200")"
  migration_060300_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM83_MIGRATION_060300")"
  migration_060400_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM84_MIGRATION_060400")"
  migration_060500_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM82_MIGRATION_060500")"
  migration_060600_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_060600")"
  migration_060700_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_060700")"
  migration_060800_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_MIGRATION_060800")"
  rollback_031000_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_031000")"
  rollback_143000_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_143000")"
  rollback_041530_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_041530")"
  rollback_041657_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_041657")"
  rollback_041853_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_041853")"
  rollback_041930_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_041930")"
  rollback_050000_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_050000")"
  rollback_050100_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_050100")"
  rollback_050200_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM81_ROLLBACK_050200")"
  rollback_051200_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM82_ROLLBACK_051200")"
  rollback_051300_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM83_ROLLBACK_051300")"
  rollback_051900_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM79_ROLLBACK_051900")"
  rollback_060000_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM84_ROLLBACK_060000")"
  rollback_060100_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$V4_ROLLBACK_060100")"
  rollback_060200_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM83_ROLLBACK_060200")"
  rollback_060300_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM83_ROLLBACK_060300")"
  rollback_060400_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM84_ROLLBACK_060400")"
  rollback_060500_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM82_ROLLBACK_060500")"
  rollback_060600_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_060600")"
  rollback_060700_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_060700")"
  rollback_060800_blob="$(git --git-dir="$REPOSITORY" rev-parse "$SHA:$SAM78_ROLLBACK_060800")"

  chown root:root "$run_dir" "$executor" "$verify" "$history_manifest" \
    "$migration_031000" "$migration_143000" "$migration_041530" "$migration_041657" "$migration_041853" "$migration_041930" "$migration_050000" "$migration_050100" "$migration_050200" "$migration_051200" "$migration_051300" "$migration_051900" "$migration_060000" "$migration_060100" "$migration_060200" "$migration_060300" "$migration_060400" "$migration_060500" "$migration_060600" "$migration_060700" "$migration_060800" \
    "$rollback_031000" "$rollback_143000" "$rollback_041530" "$rollback_041657" "$rollback_041853" "$rollback_041930" "$rollback_050000" "$rollback_050100" "$rollback_050200" "$rollback_051200" "$rollback_051300" "$rollback_051900" "$rollback_060000" "$rollback_060100" "$rollback_060200" "$rollback_060300" "$rollback_060400" "$rollback_060500" "$rollback_060600" "$rollback_060700" "$rollback_060800"
  chmod 0700 "$run_dir"
  chmod 0500 "$executor"
  chmod 0400 "$verify" "$history_manifest" "$migration_031000" "$migration_143000" \
    "$migration_041530" "$migration_041657" "$migration_041853" "$migration_041930" "$migration_050000" "$migration_050100" "$migration_050200" "$migration_051200" "$migration_051300" "$migration_051900" "$migration_060000" "$migration_060100" "$migration_060200" "$migration_060300" "$migration_060400" "$migration_060500" "$migration_060600" "$migration_060700" "$migration_060800" "$rollback_031000" "$rollback_143000" \
    "$rollback_041530" "$rollback_041657" "$rollback_041853" "$rollback_041930" "$rollback_050000" "$rollback_050100" "$rollback_050200" "$rollback_051200" "$rollback_051300" "$rollback_051900" "$rollback_060000" "$rollback_060100" "$rollback_060200" "$rollback_060300" "$rollback_060400" "$rollback_060500" "$rollback_060600" "$rollback_060700" "$rollback_060800"

  rc=0
  /usr/bin/env -i \
    HOME="/root" \
    PATH="/usr/bin:/bin" \
    SAM78_ACTION="$database_action" \
    SAM78_EXPECTED_RELEASE_SHA="$SHA" \
    SAM78_BUILD_ARTIFACT_SHA256="$expected_checksum" \
    SAM78_PROJECT_REF="$STAGING_REF" \
    SAM78_PGPASS_PATH="$SAM78_PGPASS" \
    SAM78_PLATFORM_STAFF_ROLE_MAPPING_PATH="$SAM78_PLATFORM_STAFF_ROLE_MAPPING" \
    SAM78_PLATFORM_STAFF_ROLE_MAPPING_SHA256="$platform_staff_role_mapping_checksum" \
    SAM78_VERIFY_SQL_PATH="$verify" \
    SAM78_VERIFY_SQL_BLOB="$verify_blob" \
    SAM78_HISTORY_MANIFEST_PATH="$history_manifest" \
    SAM78_HISTORY_MANIFEST_BLOB="$history_manifest_blob" \
    SAM78_MIGRATION_031000_PATH="$migration_031000" \
    SAM78_MIGRATION_031000_BLOB="$migration_031000_blob" \
    SAM78_MIGRATION_143000_PATH="$migration_143000" \
    SAM78_MIGRATION_143000_BLOB="$migration_143000_blob" \
    SAM78_MIGRATION_041530_PATH="$migration_041530" \
    SAM78_MIGRATION_041530_BLOB="$migration_041530_blob" \
    SAM78_MIGRATION_041657_PATH="$migration_041657" \
    SAM78_MIGRATION_041657_BLOB="$migration_041657_blob" \
    SAM78_MIGRATION_041853_PATH="$migration_041853" \
    SAM78_MIGRATION_041853_BLOB="$migration_041853_blob" \
    SAM78_MIGRATION_041930_PATH="$migration_041930" \
    SAM78_MIGRATION_041930_BLOB="$migration_041930_blob" \
    SAM78_MIGRATION_050000_PATH="$migration_050000" \
    SAM78_MIGRATION_050000_BLOB="$migration_050000_blob" \
    SAM78_MIGRATION_050100_PATH="$migration_050100" \
    SAM78_MIGRATION_050100_BLOB="$migration_050100_blob" \
    SAM81_MIGRATION_050200_PATH="$migration_050200" \
    SAM81_MIGRATION_050200_BLOB="$migration_050200_blob" \
    SAM82_MIGRATION_051200_PATH="$migration_051200" \
    SAM82_MIGRATION_051200_BLOB="$migration_051200_blob" \
    SAM83_MIGRATION_051300_PATH="$migration_051300" \
    SAM83_MIGRATION_051300_BLOB="$migration_051300_blob" \
    SAM79_MIGRATION_051900_PATH="$migration_051900" \
    SAM79_MIGRATION_051900_BLOB="$migration_051900_blob" \
    SAM84_MIGRATION_060000_PATH="$migration_060000" \
    SAM84_MIGRATION_060000_BLOB="$migration_060000_blob" \
    V4_MIGRATION_060100_PATH="$migration_060100" \
    V4_MIGRATION_060100_BLOB="$migration_060100_blob" \
    SAM83_MIGRATION_060200_PATH="$migration_060200" \
    SAM83_MIGRATION_060200_BLOB="$migration_060200_blob" \
    SAM83_MIGRATION_060300_PATH="$migration_060300" \
    SAM83_MIGRATION_060300_BLOB="$migration_060300_blob" \
    SAM84_MIGRATION_060400_PATH="$migration_060400" \
    SAM84_MIGRATION_060400_BLOB="$migration_060400_blob" \
    SAM82_MIGRATION_060500_PATH="$migration_060500" \
    SAM82_MIGRATION_060500_BLOB="$migration_060500_blob" \
    SAM78_MIGRATION_060600_PATH="$migration_060600" \
    SAM78_MIGRATION_060600_BLOB="$migration_060600_blob" \
    SAM78_MIGRATION_060700_PATH="$migration_060700" \
    SAM78_MIGRATION_060700_BLOB="$migration_060700_blob" \
    SAM78_MIGRATION_060800_PATH="$migration_060800" \
    SAM78_MIGRATION_060800_BLOB="$migration_060800_blob" \
    SAM78_ROLLBACK_031000_PATH="$rollback_031000" \
    SAM78_ROLLBACK_031000_BLOB="$rollback_031000_blob" \
    SAM78_ROLLBACK_143000_PATH="$rollback_143000" \
    SAM78_ROLLBACK_143000_BLOB="$rollback_143000_blob" \
    SAM78_ROLLBACK_041530_PATH="$rollback_041530" \
    SAM78_ROLLBACK_041530_BLOB="$rollback_041530_blob" \
    SAM78_ROLLBACK_041657_PATH="$rollback_041657" \
    SAM78_ROLLBACK_041657_BLOB="$rollback_041657_blob" \
    SAM78_ROLLBACK_041853_PATH="$rollback_041853" \
    SAM78_ROLLBACK_041853_BLOB="$rollback_041853_blob" \
    SAM78_ROLLBACK_041930_PATH="$rollback_041930" \
    SAM78_ROLLBACK_041930_BLOB="$rollback_041930_blob" \
    SAM78_ROLLBACK_050000_PATH="$rollback_050000" \
    SAM78_ROLLBACK_050000_BLOB="$rollback_050000_blob" \
    SAM78_ROLLBACK_050100_PATH="$rollback_050100" \
    SAM78_ROLLBACK_050100_BLOB="$rollback_050100_blob" \
    SAM81_ROLLBACK_050200_PATH="$rollback_050200" \
    SAM81_ROLLBACK_050200_BLOB="$rollback_050200_blob" \
    SAM82_ROLLBACK_051200_PATH="$rollback_051200" \
    SAM82_ROLLBACK_051200_BLOB="$rollback_051200_blob" \
    SAM83_ROLLBACK_051300_PATH="$rollback_051300" \
    SAM83_ROLLBACK_051300_BLOB="$rollback_051300_blob" \
    SAM79_ROLLBACK_051900_PATH="$rollback_051900" \
    SAM79_ROLLBACK_051900_BLOB="$rollback_051900_blob" \
    SAM84_ROLLBACK_060000_PATH="$rollback_060000" \
    SAM84_ROLLBACK_060000_BLOB="$rollback_060000_blob" \
    V4_ROLLBACK_060100_PATH="$rollback_060100" \
    V4_ROLLBACK_060100_BLOB="$rollback_060100_blob" \
    SAM83_ROLLBACK_060200_PATH="$rollback_060200" \
    SAM83_ROLLBACK_060200_BLOB="$rollback_060200_blob" \
    SAM83_ROLLBACK_060300_PATH="$rollback_060300" \
    SAM83_ROLLBACK_060300_BLOB="$rollback_060300_blob" \
    SAM84_ROLLBACK_060400_PATH="$rollback_060400" \
    SAM84_ROLLBACK_060400_BLOB="$rollback_060400_blob" \
    SAM82_ROLLBACK_060500_PATH="$rollback_060500" \
    SAM82_ROLLBACK_060500_BLOB="$rollback_060500_blob" \
    SAM78_ROLLBACK_060600_PATH="$rollback_060600" \
    SAM78_ROLLBACK_060600_BLOB="$rollback_060600_blob" \
    SAM78_ROLLBACK_060700_PATH="$rollback_060700" \
    SAM78_ROLLBACK_060700_BLOB="$rollback_060700_blob" \
    SAM78_ROLLBACK_060800_PATH="$rollback_060800" \
    SAM78_ROLLBACK_060800_BLOB="$rollback_060800_blob" \
    /usr/bin/node "$executor" >"$output" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] ||
    fail "SAM-78 $database_action failed with status $rc; captured output is redacted"
  /usr/bin/node -e '
    const fs = require("fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").trim().split(/\r?\n/);
    if (lines.length !== 1) process.exit(1);
    const body = JSON.parse(lines[0]);
    const versions = [
      "20260803100000", "20260803143000", "20260804153000",
      "20260804165734", "20260804185311", "20260804193000", "20260805000000",
      "20260805010000", "20260805020000", "20260805120000", "20260805130000", "20260805190000", "20260806000000", "20260806010000", "20260806020000", "20260806030000", "20260806040000", "20260806050000", "20260806060000", "20260806070000", "20260806080000",
    ];
    const applyEvidenceIsValid = process.argv[4] === "apply"
      && Array.isArray(body.alreadyAppliedVersions)
      && Array.isArray(body.appliedVersions)
      && JSON.stringify([...body.alreadyAppliedVersions, ...body.appliedVersions]) === JSON.stringify(versions);
    const rollbackEvidenceIsValid = process.argv[4] === "rollback"
      && JSON.stringify(body.alreadyAppliedVersions) === JSON.stringify(versions)
      && JSON.stringify(body.appliedVersions) === JSON.stringify(versions);
    if (
      body.schemaVersion !== 1 ||
      body.linearId !== "SAM-78" ||
      body.releaseSha !== process.argv[2] ||
      body.projectRef !== process.argv[3] ||
      body.action !== process.argv[4] ||
      body.status !== "passed" ||
      body.history !== "verified" ||
      body.historyManifestBlob !== process.argv[5] ||
      body.buildArtifactSha256 !== process.argv[6] ||
      body.platformStaffRoleMappingSha256 !== (
        process.argv[4] === "apply" ? process.argv[7] : null
      ) ||
      JSON.stringify(body.versions) !== JSON.stringify(versions) ||
      !(applyEvidenceIsValid || rollbackEvidenceIsValid)
    ) process.exit(1);
  ' "$output" "$SHA" "$STAGING_REF" "$database_action" \
    "$history_manifest_blob" "$expected_checksum" \
    "$platform_staff_role_mapping_checksum" ||
    fail "SAM-78 $database_action evidence is incomplete"
  evidence_tmp="$(mktemp "$STATE_DIR/.last-migrate-sam78.XXXXXX")"
  register_temporary_path "$evidence_tmp"
  install -m 0600 -o root -g root "$output" "$evidence_tmp"
  mv -Tf "$evidence_tmp" "$SAM78_EVIDENCE"
  rm -rf -- "$run_dir"
  rm -f -- "$output"
  echo "staging control SAM-78 database action passed SHA=$SHA action=$database_action evidence=$SAM78_EVIDENCE"
}

sam87_evidence_digest() {
  local evidence="$1"
  [ -f "$evidence" ] || return 1
  [ ! -L "$evidence" ] || return 1
  [ "$(stat -c '%u:%g:%a' "$evidence")" = "0:0:600" ] || return 1
  /usr/bin/sha256sum "$evidence" | awk '{print $1}'
}

run_sam87_rehearsal() {
  local previous previous_sha migration_delta artifact checksum artifact_sha256
  local run_dir runner input output evidence_tmp
  local product_digest sam78_digest sam68_digest sam54_digest
  previous="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  [[ "$previous" =~ ^$RELEASES/[0-9a-f]{40}$ ]] ||
    fail "SAM-87 requires a current immutable staging predecessor"
  previous_sha="${previous##*/}"
  [ "$previous_sha" != "$SHA" ] ||
    fail "SAM-87 target must differ from the current staging predecessor"
  verify_current_release "$previous_sha"

  migration_delta="$(
    git --git-dir="$REPOSITORY" diff --name-only "$previous_sha" "$SHA" -- supabase/migrations
  )"
  [ -z "$migration_delta" ] ||
    fail "SAM-87 refuses a migration delta; complete the separately controlled migration compatibility rehearsal first"

  if ! (run_build); then
    fail "SAM-87 stopped before deployment because the SHA-bound build failed"
  fi
  artifact="$INCOMING/$SHA.tar.gz"
  checksum="$artifact.sha256"
  [ -f "$artifact" ] && [ -f "$checksum" ] ||
    fail "SAM-87 immutable artifact evidence is missing after build"
  artifact_sha256="$(tr -d '\r\n' < "$checksum")"
  [[ "$artifact_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    fail "SAM-87 immutable artifact checksum is invalid"
  [ "$(/usr/bin/sha256sum "$artifact" | awk '{print $1}')" = "$artifact_sha256" ] ||
    fail "SAM-87 immutable artifact checksum does not match"

  if ! (run_deploy); then
    fail "SAM-87 stopped before UAT because the isolated candidate or deployment failed"
  fi

  # Each stage runs in a subshell so any fail-closed helper cannot bypass
  # recovery. The controller's single lock keeps this sequence serialized.
  for stage in run_uat_product_saas run_uat_sam78 run_uat_sam68 run_uat_sam54; do
    if ! ("$stage"); then
      if ! (run_rollback); then
        fail "SAM-87 $stage failed and automatic rollback could not be verified"
      fi
      fail "SAM-87 $stage failed; automatic rollback restored $previous_sha"
    fi
  done
  if ! (run_rollback); then
    fail "SAM-87 release rehearsal rollback failed"
  fi

  product_digest="$(sam87_evidence_digest "$STATE_DIR/last-uat-product-saas.json")" ||
    fail "SAM-87 Product/SaaS UAT evidence is missing or unsafe"
  sam78_digest="$(sam87_evidence_digest "$SAM78_UAT_EVIDENCE")" ||
    fail "SAM-87 SAM-78 UAT evidence is missing or unsafe"
  sam68_digest="$(sam87_evidence_digest "$SAM68_EVIDENCE")" ||
    fail "SAM-87 SAM-68 observation evidence is missing or unsafe"
  sam54_digest="$(sam87_evidence_digest "$SAM54_EVIDENCE")" ||
    fail "SAM-87 SAM-54 observation evidence is missing or unsafe"

  run_dir="$(mktemp -d "/run/newme-staging-sam87-$SHA.XXXXXX")"
  runner="$run_dir/verify-staging-sam87-release-rehearsal.mjs"
  input="$run_dir/evidence-input.json"
  output="$(mktemp "$STATE_DIR/.rehearse-sam87.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  copy_commit_blob "$SHA" "$SAM87_RUNNER" "$runner"
  chown root:root "$run_dir" "$runner"
  chmod 0700 "$run_dir"
  chmod 0500 "$runner"
  cat >"$input" <<EOF
{"schemaVersion":1,"linearId":"SAM-87","target":"staging-only","releaseSha":"$SHA","previousReleaseSha":"$previous_sha","artifact":{"immutable":true,"sha256":"$artifact_sha256"},"migration":{"decision":"not_required_no_migration_delta","deltaPaths":[]},"candidate":{"port":3102,"health":200,"readiness":200},"uat":{"productSaasSha256":"$product_digest","sam78Sha256":"$sam78_digest","sam68Sha256":"$sam68_digest","sam54Sha256":"$sam54_digest"},"phases":[{"name":"frozen_sha","status":"passed"},{"name":"immutable_artifact","status":"passed"},{"name":"migration_compatibility","status":"passed"},{"name":"isolated_candidate","status":"passed"},{"name":"smoke_readiness","status":"passed"},{"name":"uat_product_saas","status":"passed"},{"name":"uat_sam78","status":"passed"},{"name":"observe_sam68","status":"passed"},{"name":"observe_sam54","status":"passed"},{"name":"rollback","status":"passed"}]}
EOF
  chown root:root "$input"
  chmod 0400 "$input"
  /usr/bin/env -i HOME="/root" PATH="/usr/bin:/bin" \
    /usr/bin/node "$runner" "$input" >"$output" 2>&1 ||
    fail "SAM-87 rehearsal evidence is incomplete"
  /usr/bin/node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (
      body?.linearId !== "SAM-87" ||
      body?.releaseSha !== process.argv[2] ||
      body?.previousReleaseSha !== process.argv[3] ||
      body?.target !== "staging-only" ||
      body?.rollback?.status !== "passed" ||
      body?.rollback?.restoredReleaseSha !== process.argv[3] ||
      body?.safety?.productionTouched !== false ||
      body?.safety?.databaseRollbackAttempted !== false ||
      body?.safety?.automaticStopAndRollback !== true
    ) process.exit(1);
  ' "$output" "$SHA" "$previous_sha" ||
    fail "SAM-87 rehearsal evidence failed verification"
  evidence_tmp="$(mktemp "$STATE_DIR/.last-rehearse-sam87.XXXXXX")"
  register_temporary_path "$evidence_tmp"
  install -m 0600 -o root -g root "$output" "$evidence_tmp"
  mv -Tf "$evidence_tmp" "$SAM87_EVIDENCE"
  rm -f -- "$output"
  echo "staging control SAM-87 rehearsal passed SHA=$SHA restored=$previous_sha evidence=$SAM87_EVIDENCE"
}

run_sam88_pilot_readiness() {
  verify_current_release "$SHA"
  [ -f "$SAM88_MANIFEST" ] && [ ! -L "$SAM88_MANIFEST" ] ||
    fail "SAM-88 approved pilot manifest is missing or unsafe"
  [ "$(stat -c '%u:%g:%a' "$SAM88_MANIFEST")" = "0:0:600" ] ||
    fail "SAM-88 approved pilot manifest must be root:root mode 0600"
  local run_dir runner output evidence_tmp
  run_dir="$(mktemp -d "/run/newme-staging-sam88-$SHA.XXXXXX")"
  runner="$run_dir/verify-staging-sam88-design-partner-pilot.mjs"
  output="$(mktemp "$STATE_DIR/.validate-sam88-pilot.XXXXXX")"
  register_temporary_path "$run_dir"
  register_temporary_path "$output"
  copy_commit_blob "$SHA" "$SAM88_RUNNER" "$runner"
  chown root:root "$run_dir" "$runner"
  chmod 0700 "$run_dir"
  chmod 0500 "$runner"
  /usr/bin/node "$runner" --manifest "$SAM88_MANIFEST" --expected-release "$SHA" >"$output" 2>&1 ||
    fail "SAM-88 approved pilot manifest failed validation"
  /usr/bin/node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const phases = ["provisioning", "paid_seat_entitlement", "vertical_e2e", "tenant_isolation", "bounded_support_audit", "billing_lifecycle_export", "backup_restore_exit"];
    if (
      body?.linearId !== "SAM-88" ||
      body?.target !== "staging-only" ||
      body?.releaseSha !== process.argv[2] ||
      body?.execution?.status !== "not-executed" ||
      body?.execution?.redaction !== "references-and-digests-only" ||
      body?.readiness !== "authorized_cohort_evidence_submitted" ||
      !Array.isArray(body?.cohort) || body.cohort.length !== 2 ||
      new Set(body.cohort.map((partner) => partner?.vertical)).size !== 2 ||
      !body.cohort.some((partner) => partner?.vertical === "real_estate") ||
      !body.cohort.some((partner) => partner?.vertical === "retail") ||
      body.cohort.some((partner) => !Array.isArray(partner?.evidence) || partner.evidence.length !== phases.length)
    ) process.exit(1);
  ' "$output" "$SHA" || fail "SAM-88 pilot evidence failed verification"
  evidence_tmp="$(mktemp "$STATE_DIR/.last-validate-sam88-pilot.XXXXXX")"
  register_temporary_path "$evidence_tmp"
  install -m 0600 -o root -g root "$output" "$evidence_tmp"
  mv -Tf "$evidence_tmp" "$SAM88_EVIDENCE"
  rm -f -- "$output"
  echo "staging control SAM-88 pilot readiness passed SHA=$SHA execution=not-executed evidence=$SAM88_EVIDENCE"
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
  cold-recover-sam87) run_sam87_cold_recovery ;;
  uat) run_uat ;;
  uat-sam20) run_uat_sam20 ;;
  reconcile-sam21) run_reconcile_sam21 ;;
  uat-sam21) run_uat_sam21 ;;
  uat-sam22) run_uat_sam22 ;;
  uat-sam23) run_uat_sam23 ;;
  uat-sam27) run_uat_sam27 ;;
  uat-sam52) run_uat_sam52 ;;
  uat-sam54) run_uat_sam54 ;;
  uat-sam68) run_uat_sam68 ;;
  uat-sam70) run_uat_sam70 ;;
  uat-product-saas) run_uat_product_saas ;;
  uat-sam78) run_uat_sam78 ;;
  uat-v4) run_uat_v4 ;;
  migrate-sam78|rollback-sam78-db) run_sam78_database_action ;;
  rehearse-sam87) run_sam87_rehearsal ;;
  validate-sam88-pilot) run_sam88_pilot_readiness ;;
  rollback) run_rollback ;;
esac
