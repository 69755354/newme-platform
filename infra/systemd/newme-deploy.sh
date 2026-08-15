#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "newme-deploy must run as root" >&2
  exit 77
fi
exec 9>/run/lock/newme-production-release.lock
flock -n 9 || {
  echo "another production release operation is active" >&2
  exit 69
}
STATE_ROOT=/var/lib/newme/deploy-state
PENDING_ASSET_RECORD="$STATE_ROOT/systemd-assets.pending"
CREDENTIAL_ASSET_PENDING="$STATE_ROOT/credential-assets.pending"
CREDENTIAL_GATE_CONSUMED="$STATE_ROOT/credential-remediation-gate.consumed"
CREDENTIAL_TRANSITION_PENDING="$STATE_ROOT/credential-transition.pending.json"
readonly TRANSITION_BACKUP_RECORD="$STATE_ROOT/credential-transition.previous.env"
readonly TRANSITION_LAST_RECORD="$STATE_ROOT/credential-transition.last.json"
readonly PROTECTION_MARKER_RECORD="$STATE_ROOT/credential-remediation.protected.json"
readonly CREDENTIAL_LIVE_HELPER=/usr/local/libexec/newme/newme-credential-live-attestation.mjs
readonly CREDENTIAL_LIVE_POLICY=/usr/local/share/newme/credential-live-attestation-policy-v1.json
readonly CREDENTIAL_TRANSITION_HELPER=/usr/local/libexec/newme/newme-credential-transition.mjs
readonly CREDENTIAL_LIVE_NODE=/usr/bin/node
readonly CREDENTIAL_INBOX=/run/newme-credential-inbox/supabase-service-key.env
PRODUCTION_ROLLBACK_PENDING="$STATE_ROOT/production-rollback.pending"
readonly MIGRATION_DB_URL_FILE=/etc/newme/migration-db.url
readonly POSTDEPLOY_RECEIPT_PUBLIC_KEY=/etc/newme/postdeploy-acceptance-receipt.pub
readonly POSTDEPLOY_INTAKE_ROOT=/var/lib/newme/postdeploy-intake-v1
readonly CANONICAL_RELEASE_MIRROR=/opt/newme/repository.git
readonly CANONICAL_RELEASE_ORIGIN_HTTPS=https://github.com/69755354/newme-platform.git
readonly CANONICAL_RELEASE_ORIGIN_SSH=git@github.com:69755354/newme-platform.git
readonly CANONICAL_CI_WORKFLOW_ID=310914082
readonly POSTDEPLOY_BROWSER_IMAGE='mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948'
readonly POSTDEPLOY_BROWSER_REPO_DIGEST='mcr.microsoft.com/playwright@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948'

# Defined above every coordinator mode: deployment and database transitions gate
# production migration history, while finalization gates completion on the strict
# database phase (Round-4 C8). The URL itself is read by the
# node gate from the file descriptor, never passed as an argument and never echoed —
# a connection string is a credential — so what this checks is the file: not a
# symlink, root-owned, and unreadable by anyone else.
validate_migration_db_url_file() {
  [ -f "$MIGRATION_DB_URL_FILE" ] && [ ! -L "$MIGRATION_DB_URL_FILE" ] || {
    echo "root-owned migration database URL file is missing" >&2
    return 1
  }
  [ "$(stat -c '%U:%G' "$MIGRATION_DB_URL_FILE")" = root:root ] || {
    echo "migration database URL file ownership is invalid" >&2
    return 1
  }
  case "$(stat -c '%a' "$MIGRATION_DB_URL_FILE")" in
    400|600) ;;
    *) echo "migration database URL file mode must be 0400 or 0600" >&2; return 1 ;;
  esac
}

require_node() {
  NODE_BIN="$CREDENTIAL_LIVE_NODE"
  [ -f "$NODE_BIN" ] && [ ! -L "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
    echo "node is required to gate this deployment and was not found" >&2
    return 1
  }
  [ "$(stat -c '%U:%G' "$NODE_BIN")" = root:root ] || return 1
  [ $((8#$(stat -c '%a' "$NODE_BIN") & 8#22)) -eq 0 ] || return 1
  [ "$(env -i HOME=/root PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 "$NODE_BIN" --version)" = v24.18.0 ] || return 1
}

hardened_node_exec() {
  local helper=$1
  shift
  require_node || return 65
  env -i HOME=/root PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    /usr/bin/python3 -I -S - "$NODE_BIN" "$helper" "$@" <<'PY'
import ctypes
import os
import resource
import sys

node, helper, *arguments = sys.argv[1:]
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(4, 0, 0, 0, 0) != 0:
    raise SystemExit(65)
environment = {
    "HOME": "/root",
    "PATH": "/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
}
os.execve(node, [node, helper, *arguments], environment)
PY
}

credential_live_exec() {
  [ -f "$CREDENTIAL_LIVE_HELPER" ] && [ ! -L "$CREDENTIAL_LIVE_HELPER" ] || return 65
  [ "$(stat -c '%U:%G' "$CREDENTIAL_LIVE_HELPER")" = root:root ] &&
    [ "$(stat -c '%a' "$CREDENTIAL_LIVE_HELPER")" = 755 ] || return 65
  hardened_node_exec "$CREDENTIAL_LIVE_HELPER" "$@"
}

credential_transition_exec() {
  [ -f "$CREDENTIAL_TRANSITION_HELPER" ] && [ ! -L "$CREDENTIAL_TRANSITION_HELPER" ] &&
    [ -x "$CREDENTIAL_TRANSITION_HELPER" ] || return 65
  [ "$(stat -c '%U:%G' "$CREDENTIAL_TRANSITION_HELPER")" = root:root ] &&
    [ "$(stat -c '%a' "$CREDENTIAL_TRANSITION_HELPER")" = 755 ] || return 65
  hardened_node_exec "$CREDENTIAL_TRANSITION_HELPER" "$@"
}

prepare_postdeploy_browser_image() {
  local repo_digests
  [ -x /usr/bin/docker ] && [ ! -L /usr/bin/docker ] || return 65
  [ "$(stat -c '%U:%G' /usr/bin/docker)" = root:root ] || return 65
  [ $((8#$(stat -c '%a' /usr/bin/docker) & 8#22)) -eq 0 ] || return 65
  repo_digests="$(env -i PATH=/usr/bin:/bin HOME=/root LANG=C.UTF-8 \
    /usr/bin/docker image inspect --format '{{json .RepoDigests}}' "$POSTDEPLOY_BROWSER_IMAGE" 2>/dev/null || true)"
  if ! python3 - "$POSTDEPLOY_BROWSER_REPO_DIGEST" "$repo_digests" <<'PY'
import json
import sys
expected, raw = sys.argv[1:]
try:
    values = json.loads(raw)
except json.JSONDecodeError:
    raise SystemExit(1)
raise SystemExit(0 if isinstance(values, list) and expected in values else 1)
PY
  then
    env -i PATH=/usr/bin:/bin HOME=/root LANG=C.UTF-8 \
      /usr/bin/docker pull "$POSTDEPLOY_BROWSER_IMAGE" >/dev/null || return 65
    repo_digests="$(env -i PATH=/usr/bin:/bin HOME=/root LANG=C.UTF-8 \
      /usr/bin/docker image inspect --format '{{json .RepoDigests}}' "$POSTDEPLOY_BROWSER_IMAGE")" || return 65
    python3 - "$POSTDEPLOY_BROWSER_REPO_DIGEST" "$repo_digests" <<'PY' || return 65
import json
import sys
expected, raw = sys.argv[1:]
try:
    values = json.loads(raw)
except json.JSONDecodeError:
    raise SystemExit(65)
raise SystemExit(0 if isinstance(values, list) and expected in values else 65)
PY
  fi
}

require_canonical_main_sha() {
  local expected_sha=${1:-} actual_sha
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || return 65
  [ -d "$CANONICAL_RELEASE_MIRROR" ] && [ ! -L "$CANONICAL_RELEASE_MIRROR" ] || return 65
  [ "$(stat -c '%U:%G' "$CANONICAL_RELEASE_MIRROR")" = root:root ] || return 65
  case "$(git --git-dir="$CANONICAL_RELEASE_MIRROR" remote get-url origin)" in
    "$CANONICAL_RELEASE_ORIGIN_HTTPS"|"$CANONICAL_RELEASE_ORIGIN_SSH") ;;
    *) return 65 ;;
  esac
  git --git-dir="$CANONICAL_RELEASE_MIRROR" fetch --quiet --prune origin \
    '+refs/heads/main:refs/remotes/origin/main' || return 65
  actual_sha="$(git --git-dir="$CANONICAL_RELEASE_MIRROR" rev-parse refs/remotes/origin/main)" || return 65
  [ "$actual_sha" = "$expected_sha" ] || {
    echo "canonical main moved away from the protected operation SHA" >&2
    return 65
  }
}

require_immutable_release_asset() {
  local release_sha=${1:-} relative_path=${2:-} installed_path=${3:-} expected_mode=${4:-}
  local release_root cursor expected_hash actual_hash
  [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || return 65
  [[ "$relative_path" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$relative_path" != /* ]] && [[ "$relative_path" != *".."* ]] || return 65
  case "$expected_mode" in 440|550) ;; *) return 65 ;; esac
  [ -d "$CANONICAL_RELEASE_MIRROR" ] && [ ! -L "$CANONICAL_RELEASE_MIRROR" ] || return 65
  [ "$(stat -c '%U:%G' "$CANONICAL_RELEASE_MIRROR")" = root:root ] || return 65
  case "$(git --git-dir="$CANONICAL_RELEASE_MIRROR" remote get-url origin)" in
    "$CANONICAL_RELEASE_ORIGIN_HTTPS"|"$CANONICAL_RELEASE_ORIGIN_SSH") ;;
    *) return 65 ;;
  esac
  release_root="/opt/newme/releases/$release_sha"
  [ "$(readlink -f "$installed_path" 2>/dev/null || true)" = "$release_root/$relative_path" ] || return 65
  [ -f "$installed_path" ] && [ ! -L "$installed_path" ] || return 65
  [ "$(stat -c '%U:%G' "$installed_path")" = root:ubuntu ] || return 65
  [ "$(stat -c '%a' "$installed_path")" = "$expected_mode" ] || return 65
  cursor="$(dirname "$installed_path")"
  while :; do
    [ -d "$cursor" ] && [ ! -L "$cursor" ] || return 65
    [ "$(stat -c '%U:%G' "$cursor")" = root:ubuntu ] || return 65
    [ "$(stat -c '%a' "$cursor")" = 550 ] || return 65
    [ "$cursor" = "$release_root" ] && break
    [ "$cursor" != / ] || return 65
    cursor="$(dirname "$cursor")"
  done
  expected_hash="$(git --git-dir="$CANONICAL_RELEASE_MIRROR" show "$release_sha:$relative_path" | sha256sum | cut -d' ' -f1)" || return 65
  actual_hash="$(sha256sum "$installed_path" | cut -d' ' -f1)" || return 65
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] && [ "$actual_hash" = "$expected_hash" ] || return 65
}

require_postdeploy_operations_clear() {
  local current_release=${1:-} current_sha runner
  local journal_root=/var/lib/newme/postdeploy-acceptance-state-v1
  [ ! -e "$journal_root" ] && [ ! -L "$journal_root" ] && return 0
  [ -d "$journal_root" ] && [ ! -L "$journal_root" ] || return 65
  [ "$(stat -c '%U:%G' "$journal_root")" = root:root ] && [ "$(stat -c '%a' "$journal_root")" = 700 ] || return 65
  [ -z "$(find "$journal_root" -mindepth 1 -maxdepth 1 -print -quit)" ] && return 0
  case "$current_release" in /opt/newme/releases/[0-9a-f][0-9a-f]*) ;; *) return 65 ;; esac
  current_sha="$(basename "$current_release")"
  [[ "$current_sha" =~ ^[0-9a-f]{40}$ ]] || return 65
  runner="$current_release/scripts/run-postdeploy-acceptance.mjs"
  require_node || return 65
  require_immutable_release_asset "$current_sha" \
    scripts/run-postdeploy-acceptance.mjs "$runner" 440 || return 65
  require_immutable_release_asset "$current_sha" \
    scripts/postdeploy-receipt.mjs "$current_release/scripts/postdeploy-receipt.mjs" 440 || return 65
  require_immutable_release_asset "$current_sha" \
    scripts/canonical-browser-uat.mjs "$current_release/scripts/canonical-browser-uat.mjs" 440 || return 65
  "$NODE_BIN" "$runner" --assert-operations-clear >/dev/null || {
    echo "postdeploy fixture recovery is required before a production operation" >&2
    return 75
  }
}

require_ci_gate_still_fresh() {
  python3 - "${CI_RUN_COMPLETED_AT:-}" "${CI_GATE_AUDITED_AT:-}" "${CI_MAX_RUN_AGE_SECONDS:-}" \
    "${CI_GATE_AUDIT_BASE64:-}" "${CI_GATE_AUDIT_SHA256:-}" <<'PY'
import base64
import hashlib
import json
import re
import sys
from datetime import datetime, timezone

completed_raw, audited_raw, maximum_raw, encoded, expected_digest = sys.argv[1:]
pattern = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$")
if pattern.fullmatch(completed_raw) is None or pattern.fullmatch(audited_raw) is None:
    raise SystemExit(65)
if not maximum_raw.isdigit() or not 1 <= int(maximum_raw) <= 86400:
    raise SystemExit(65)
completed = datetime.fromisoformat(completed_raw.replace("Z", "+00:00"))
audited = datetime.fromisoformat(audited_raw.replace("Z", "+00:00"))
try:
    audit_bytes = base64.b64decode(encoded, validate=True)
    audit = json.loads(audit_bytes)
except (ValueError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(65)
if hashlib.sha256(audit_bytes).hexdigest() != expected_digest:
    raise SystemExit(65)
if (
    audit.get("run_completed_at") != completed_raw
    or audit.get("validated_at") != audited_raw
    or audit.get("max_run_age_seconds") != int(maximum_raw)
):
    raise SystemExit(65)
required_completed = audit.get("required_job_completed_at") if isinstance(audit, dict) else None
if not isinstance(required_completed, dict) or not required_completed:
    raise SystemExit(65)
completion_values = [completed]
for value in required_completed.values():
    if pattern.fullmatch(value or "") is None:
        raise SystemExit(65)
    completion_values.append(datetime.fromisoformat(value.replace("Z", "+00:00")))
oldest_completion = min(completion_values)
now = datetime.now(timezone.utc)
if any(value > audited or value > now for value in completion_values) or audited > now:
    raise SystemExit(65)
if (now - oldest_completion).total_seconds() > int(maximum_raw):
    raise SystemExit(65)
PY
}

materialize_ci_gate_audit_record() {
  local temporary
  CI_GATE_AUDIT_RECORD="$STATE_ROOT/ci-gate-audit.pending"
  if [ -e "$CI_GATE_AUDIT_RECORD" ] || [ -L "$CI_GATE_AUDIT_RECORD" ]; then
    [ -f "$CI_GATE_AUDIT_RECORD" ] && [ ! -L "$CI_GATE_AUDIT_RECORD" ] &&
      [ "$(stat -c '%U:%G' "$CI_GATE_AUDIT_RECORD")" = root:root ] &&
      [ "$(stat -c '%a' "$CI_GATE_AUDIT_RECORD")" = 600 ] || return 65
  fi
  temporary="$(mktemp "$STATE_ROOT/ci-gate-audit.XXXXXX")" || return 65
  chmod 0600 "$temporary" || { rm -f -- "$temporary"; return 65; }
  python3 - "$temporary" "$CI_GATE_AUDIT_BASE64" "$CI_GATE_AUDIT_SHA256" "$SHA" "$RUN_ID" <<'PY' || {
import base64
import hashlib
import json
import os
import stat
import sys

path, encoded, expected_digest, expected_sha, expected_run = sys.argv[1:]
try:
    payload = base64.b64decode(encoded, validate=True)
    document = json.loads(payload)
except (ValueError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(65)
if not payload.endswith(b"\n") or len(payload) > 65536:
    raise SystemExit(65)
if hashlib.sha256(payload).hexdigest() != expected_digest:
    raise SystemExit(65)
if (
    not isinstance(document, dict)
    or document.get("version") != "newme-ci-gate-audit/v1"
    or document.get("release_sha") != expected_sha
    or str(document.get("run_id")) != expected_run
):
    raise SystemExit(65)
descriptor = os.open(path, os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0))
try:
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise SystemExit(65)
    written = 0
    while written < len(payload):
        written += os.write(descriptor, payload[written:])
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
    rm -f -- "$temporary"
    return 65
  }
  mv -Tf "$temporary" "$CI_GATE_AUDIT_RECORD" || { rm -f -- "$temporary"; return 65; }
  sync -f "$STATE_ROOT" || return 65
  [ "$(sha256sum "$CI_GATE_AUDIT_RECORD" | cut -d' ' -f1)" = "$CI_GATE_AUDIT_SHA256" ] || return 65
  unset CI_GATE_AUDIT_BASE64
}

validate_deploy_state_root() {
  install -d -o root -g root -m 0700 "$STATE_ROOT" || return 65
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || return 65
  [ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] || return 65
  [ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || return 65
}

verify_credential_ci_live() (
  set -euo pipefail
  local release_sha="$1" run_id="$2" release_root="$3"
  local token_file=/etc/newme/github-actions-read.token
  local curl_config="" run_file="" jobs_file="" workflow_file="" github_token="" run_attempt=""
  cleanup_credential_ci() {
    local file
    for file in "$curl_config" "$run_file" "$jobs_file" "$workflow_file"; do
      [ -z "$file" ] || rm -f -- "$file" || true
    done
  }
  trap cleanup_credential_ci EXIT
  [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] && [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || return 64
  [ -f "$token_file" ] && [ ! -L "$token_file" ] || return 65
  [ "$(stat -c '%U:%G' "$token_file")" = root:root ] || return 65
  case "$(stat -c '%a' "$token_file")" in 400|600) ;; *) return 65 ;; esac
  [ -f "$release_root/infra/release/credential-remediation-required-jobs.json" ] &&
    [ ! -L "$release_root/infra/release/credential-remediation-required-jobs.json" ] || return 65
  [ -f "$release_root/scripts/verify-credential-remediation-ci.mjs" ] &&
    [ ! -L "$release_root/scripts/verify-credential-remediation-ci.mjs" ] || return 65
  require_node || return 65
  curl_config="$(mktemp /run/newme-credential-github-config.XXXXXX)"
  run_file="$(mktemp /run/newme-credential-run.XXXXXX)"
  jobs_file="$(mktemp /run/newme-credential-jobs.XXXXXX)"
  workflow_file="$(mktemp /run/newme-credential-workflow.XXXXXX)"
  chmod 0600 "$curl_config" "$run_file" "$jobs_file" "$workflow_file"
  github_token="$(<"$token_file")"
  [ -n "$github_token" ] && [[ "$github_token" != *$'\n'* ]] && [[ "$github_token" != *$'\r'* ]] || return 65
  printf 'header = "Authorization: Bearer %s"\n' "$github_token" > "$curl_config"
  unset github_token
  curl --fail --silent --show-error --max-time 15 --config "$curl_config" \
    -H 'Accept: application/vnd.github+json' \
    -o "$run_file" \
    "https://api.github.com/repos/69755354/newme-platform/actions/runs/$run_id"
  run_attempt="$(python3 - "$run_file" "$run_id" "$release_sha" <<'PY'
import json
import sys

path, expected_run, expected_sha = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    run = json.load(handle)
attempt = run.get("run_attempt")
if (
    str(run.get("id")) != expected_run
    or run.get("head_sha") != expected_sha
    or not isinstance(attempt, int)
    or isinstance(attempt, bool)
    or attempt < 1
):
    raise SystemExit(65)
print(attempt)
PY
  )" || return 65
  [[ "$run_attempt" =~ ^[1-9][0-9]*$ ]] || return 65
  curl --fail --silent --show-error --max-time 20 --config "$curl_config" \
    -H 'Accept: application/vnd.github+json' \
    -o "$jobs_file" \
    "https://api.github.com/repos/69755354/newme-platform/actions/runs/$run_id/attempts/$run_attempt/jobs?per_page=100&page=1"
  curl --fail --silent --show-error --max-time 15 --config "$curl_config" \
    -H 'Accept: application/vnd.github+json' \
    -o "$workflow_file" \
    "https://api.github.com/repos/69755354/newme-platform/actions/workflows/$CANONICAL_CI_WORKFLOW_ID"
  "$NODE_BIN" "$release_root/scripts/verify-credential-remediation-ci.mjs" \
    --manifest "$release_root/infra/release/credential-remediation-required-jobs.json" \
    --run-json "$run_file" \
    --jobs-json "$jobs_file" \
    --workflow-json "$workflow_file" \
    --expect-sha "$release_sha" \
    --expect-run "$run_id" \
    --expect-attempt "$run_attempt" >/dev/null
  printf '%s\n' "$run_attempt"
)

credential_worktree_add() {
  local sha="$1"
  install -d -o root -g root -m 0700 /var/lib/newme/deploy-worktrees || return 65
  CREDENTIAL_WORKTREE="$(mktemp -d "/var/lib/newme/deploy-worktrees/credential-${sha}.XXXXXX")" || return 65
  rmdir "$CREDENTIAL_WORKTREE" || return 65
  git --git-dir="$CANONICAL_RELEASE_MIRROR" worktree add --detach "$CREDENTIAL_WORKTREE" "$sha" >/dev/null || return 65
  chown -R root:root "$CREDENTIAL_WORKTREE" || return 65
  [ "$(git -C "$CREDENTIAL_WORKTREE" rev-parse HEAD)" = "$sha" ] || return 65
}

require_installed_credential_attestor_for_sha() {
  local sha="$1" expected="" actual=""
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 64
  [ -f "$CREDENTIAL_LIVE_HELPER" ] && [ ! -L "$CREDENTIAL_LIVE_HELPER" ] || return 65
  [ "$(stat -c '%U:%G' "$CREDENTIAL_LIVE_HELPER")" = root:root ] &&
    [ "$(stat -c '%a' "$CREDENTIAL_LIVE_HELPER")" = 755 ] || return 65
  [ -f "$CREDENTIAL_LIVE_POLICY" ] && [ ! -L "$CREDENTIAL_LIVE_POLICY" ] || return 65
  [ "$(stat -c '%U:%G' "$CREDENTIAL_LIVE_POLICY")" = root:root ] &&
    [ "$(stat -c '%a' "$CREDENTIAL_LIVE_POLICY")" = 644 ] || return 65
  [ -f "$PROTECTION_MARKER_RECORD" ] && [ ! -L "$PROTECTION_MARKER_RECORD" ] || return 65
  [ "$(stat -c '%U:%G' "$PROTECTION_MARKER_RECORD")" = root:root ] &&
    [ "$(stat -c '%a' "$PROTECTION_MARKER_RECORD")" = 600 ] || return 65
  python3 - "$PROTECTION_MARKER_RECORD" "$sha" <<'PY' || return 65
import json
import re
import sys

path, expected_sha = sys.argv[1:]
expected_assets = {
    "/etc/systemd/system/newme-platform.service",
    "/etc/tmpfiles.d/newme-credential-inbox.conf",
    "/etc/cron.d/newme-observability",
    "/usr/local/sbin/newme-deploy",
    "/usr/local/sbin/newme-production-rollback",
    "/usr/local/libexec/newme/newme-install-systemd-assets",
    "/usr/local/libexec/newme/newme-rollback-systemd-assets",
    "/usr/local/libexec/newme/newme-validate-production-config.py",
    "/usr/local/libexec/newme/newme-credential-transition.mjs",
    "/usr/local/libexec/newme/newme-credential-live-attestation.mjs",
    "/usr/local/share/newme/credential-live-attestation-policy-v1.json",
    "/usr/local/libexec/newme/newme-readiness.sh",
    "/opt/hermes-scripts/observability/dependency-probe.sh",
}
with open(path, encoding="utf-8") as handle:
    record = json.load(handle)
if (
    set(record) != {"version", "candidate_sha", "activated_at", "assets"}
    or record.get("version") != 2
    or record.get("candidate_sha") != expected_sha
    or not isinstance(record.get("assets"), dict)
    or set(record["assets"]) != expected_assets
    or any(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None for value in record["assets"].values())
):
    raise SystemExit(65)
PY
  expected="$(git --git-dir="$CANONICAL_RELEASE_MIRROR" show "$sha:scripts/credential-live-attestation.mjs" | sha256sum | awk '{print $1}')" || return 65
  actual="$(sha256sum "$CREDENTIAL_LIVE_HELPER" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || return 65
  expected="$(git --git-dir="$CANONICAL_RELEASE_MIRROR" show "$sha:infra/release/credential-live-attestation-policy-v1.json" | sha256sum | awk '{print $1}')" || return 65
  actual="$(sha256sum "$CREDENTIAL_LIVE_POLICY" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || return 65
}

verify_credential_precheck_live() {
  local sha="$1" run_id="$2" run_attempt="$3" invocation_id="$4" output=""
  require_installed_credential_attestor_for_sha "$sha" || return 65
  output="$(credential_live_exec verify-precheck "$sha" "$run_id" "$run_attempt" "$invocation_id")" || return 65
  [ "$(printf '%s\n' "$output" | wc -l)" -eq 6 ] || return 65
  CREDENTIAL_TRANSACTION_ID="$(printf '%s\n' "$output" | sed -n 's/^transaction_id=//p')"
  CREDENTIAL_PRECHECK_SHA256="$(printf '%s\n' "$output" | sed -n 's/^precheck_sha256=//p')"
  CREDENTIAL_PRECHECK_ATTEMPT="$(printf '%s\n' "$output" | sed -n 's/^ci_run_attempt=//p')"
  CREDENTIAL_PRECHECK_ASSETS_SHA256="$(printf '%s\n' "$output" | sed -n 's/^protected_assets_sha256=//p')"
  CREDENTIAL_TRANSITION_BEFORE_SHA256="$(printf '%s\n' "$output" | sed -n 's/^transition_before_sha256=//p')"
  CREDENTIAL_TRANSITION_AFTER_SHA256="$(printf '%s\n' "$output" | sed -n 's/^transition_after_sha256=//p')"
  [[ "$CREDENTIAL_TRANSACTION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 65
  [[ "$CREDENTIAL_PRECHECK_SHA256" =~ ^[0-9a-f]{64}$ ]] || return 65
  [[ "$CREDENTIAL_PRECHECK_ASSETS_SHA256" =~ ^[0-9a-f]{64}$ ]] || return 65
  [[ "$CREDENTIAL_TRANSITION_BEFORE_SHA256" =~ ^[0-9a-f]{64}$ ]] || return 65
  [[ "$CREDENTIAL_TRANSITION_AFTER_SHA256" =~ ^[0-9a-f]{64}$ ]] || return 65
  [ "$CREDENTIAL_TRANSITION_AFTER_SHA256" != "$CREDENTIAL_TRANSITION_BEFORE_SHA256" ] || return 65
  [ "$CREDENTIAL_PRECHECK_ATTEMPT" = "$run_attempt" ] || return 65
}

validate_credential_awaiting_state() {
  local sha="$1" run_id="$2" run_attempt="$3" transaction_id="$4" precheck_sha="$5"
  for protected in "$CREDENTIAL_INBOX" "$CREDENTIAL_TRANSITION_PENDING" "$TRANSITION_BACKUP_RECORD" "$TRANSITION_LAST_RECORD" "$PROTECTION_MARKER_RECORD"; do
    [ -f "$protected" ] && [ ! -L "$protected" ] || return 66
    [ "$(stat -c '%U:%G' "$protected")" = root:root ] && [ "$(stat -c '%a' "$protected")" = 600 ] || return 66
  done
  python3 - "$CREDENTIAL_TRANSITION_PENDING" "$TRANSITION_LAST_RECORD" "$PROTECTION_MARKER_RECORD" \
    "$sha" "$run_id" "$run_attempt" "$transaction_id" "$precheck_sha" <<'PY' || return 66
import json
import re
import sys

pending_path, last_path, protection_path, sha, run_id, attempt, transaction_id, precheck = sys.argv[1:]
expected_assets = {
    "/etc/systemd/system/newme-platform.service",
    "/etc/tmpfiles.d/newme-credential-inbox.conf",
    "/etc/cron.d/newme-observability",
    "/usr/local/sbin/newme-deploy",
    "/usr/local/sbin/newme-production-rollback",
    "/usr/local/libexec/newme/newme-install-systemd-assets",
    "/usr/local/libexec/newme/newme-rollback-systemd-assets",
    "/usr/local/libexec/newme/newme-validate-production-config.py",
    "/usr/local/libexec/newme/newme-credential-transition.mjs",
    "/usr/local/libexec/newme/newme-credential-live-attestation.mjs",
    "/usr/local/share/newme/credential-live-attestation-policy-v1.json",
    "/usr/local/libexec/newme/newme-readiness.sh",
    "/opt/hermes-scripts/observability/dependency-probe.sh",
}
with open(pending_path, encoding="utf-8") as handle:
    pending = json.load(handle)
with open(last_path, encoding="utf-8") as handle:
    last = json.load(handle)
with open(protection_path, encoding="utf-8") as handle:
    protection = json.load(handle)
pending_keys = {"version", "phase", "protection_before", "transaction_id", "precheck_sha256", "candidate_sha", "ci_run_id", "ci_run_attempt", "started_at", "before_sha256", "after_sha256"}
last_keys = {"version", "status", "transaction_id", "precheck_sha256", "candidate_sha", "ci_run_id", "ci_run_attempt", "finished_at", "before_sha256", "after_sha256"}
common = (
    pending.get("version") == 1
    and pending.get("phase") == "awaiting_provider_revocation"
    and set(pending) == pending_keys
    and last.get("version") == 1
    and last.get("status") == "awaiting_provider_revocation"
    and set(last) == last_keys
    and pending.get("candidate_sha") == last.get("candidate_sha") == sha
    and str(pending.get("ci_run_id")) == str(last.get("ci_run_id")) == run_id
    and str(pending.get("ci_run_attempt")) == str(last.get("ci_run_attempt")) == attempt
    and pending.get("transaction_id") == last.get("transaction_id") == transaction_id
    and pending.get("precheck_sha256") == last.get("precheck_sha256") == precheck
    and pending.get("before_sha256") == last.get("before_sha256")
    and pending.get("after_sha256") == last.get("after_sha256")
    and pending.get("before_sha256") != pending.get("after_sha256")
    and all(re.fullmatch(r"[0-9a-f]{64}", str(item)) for item in (precheck, pending.get("before_sha256"), pending.get("after_sha256")))
)
if not common:
    raise SystemExit(66)
if (
    set(protection) != {"version", "candidate_sha", "activated_at", "assets"}
    or protection.get("version") != 2
    or protection.get("candidate_sha") != sha
    or not isinstance(protection.get("assets"), dict)
    or set(protection["assets"]) != expected_assets
    or any(re.fullmatch(r"[0-9a-f]{64}", str(value)) is None for value in protection["assets"].values())
):
    raise SystemExit(66)
PY
}

case "${1:-}" in
credential-expire-prepared)
  [ "$#" -eq 4 ] || {
    echo "usage: newme-deploy credential-expire-prepared <remediation-sha> <credential-remediation-run-id> <run-attempt>" >&2
    exit 64
  }
  CREDENTIAL_SHA=$2
  CREDENTIAL_RUN_ID=$3
  CREDENTIAL_RUN_ATTEMPT=$4
  [[ "$CREDENTIAL_SHA" =~ ^[0-9a-f]{40}$ ]] && [[ "$CREDENTIAL_RUN_ID" =~ ^[1-9][0-9]*$ ]] &&
    [[ "$CREDENTIAL_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || exit 64
  validate_deploy_state_root || exit 65
  for blocker in "$PENDING_ASSET_RECORD" "$CREDENTIAL_ASSET_PENDING" "$CREDENTIAL_GATE_CONSUMED" \
    "$CREDENTIAL_TRANSITION_PENDING" "$TRANSITION_BACKUP_RECORD" "$PRODUCTION_ROLLBACK_PENDING"; do
    [ ! -e "$blocker" ] && [ ! -L "$blocker" ] || exit 75
  done
  require_installed_credential_attestor_for_sha "$CREDENTIAL_SHA" || exit 65
  CREDENTIAL_SERVICE_INVOCATION="$(systemctl show newme-platform.service -p InvocationID --value)"
  [[ "$CREDENTIAL_SERVICE_INVOCATION" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$ ]] || exit 65
  CREDENTIAL_LIVE_OUTPUT="$(credential_live_exec expire-prepared \
    "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT" "$CREDENTIAL_SERVICE_INVOCATION")" || exit 65
  [ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | wc -l)" -eq 2 ] || exit 65
  [ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | sed -n 's/^credential_live_state=//p')" = EXPIRED ] || exit 65
  [[ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | sed -n 's/^transaction_id=//p')" =~ ^[0-9a-f-]{36}$ ]] || exit 65
  [ "$(systemctl show newme-platform.service -p InvocationID --value)" = "$CREDENTIAL_SERVICE_INVOCATION" ] || exit 66
  printf 'credential_live_state=EXPIRED release=%s run=%s run_attempt=%s\n' \
    "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT"
  exit 0
  ;;
credential-prove-revocation|credential-complete)
  [ "$#" -eq 3 ] || {
    echo "usage: newme-deploy ${1:-credential-live-phase} <canonical-main-remediation-sha> <successful-credential-remediation-run-id>" >&2
    exit 64
  }
  CREDENTIAL_LIVE_ACTION=$1
  CREDENTIAL_SHA=$2
  CREDENTIAL_RUN_ID=$3
  [[ "$CREDENTIAL_SHA" =~ ^[0-9a-f]{40}$ ]] && [[ "$CREDENTIAL_RUN_ID" =~ ^[1-9][0-9]*$ ]] || exit 64
  validate_deploy_state_root || exit 65
  for blocker in "$PENDING_ASSET_RECORD" "$CREDENTIAL_ASSET_PENDING" "$CREDENTIAL_GATE_CONSUMED" "$PRODUCTION_ROLLBACK_PENDING"; do
    [ ! -e "$blocker" ] && [ ! -L "$blocker" ] || exit 75
  done
  [ -f "$CREDENTIAL_TRANSITION_PENDING" ] && [ ! -L "$CREDENTIAL_TRANSITION_PENDING" ] || exit 75
  [ -f "$TRANSITION_BACKUP_RECORD" ] && [ ! -L "$TRANSITION_BACKUP_RECORD" ] || exit 75
  CREDENTIAL_LIVE_RELEASE="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  case "$CREDENTIAL_LIVE_RELEASE" in /opt/newme/releases/[0-9a-f][0-9a-f]*) ;; *) exit 65 ;; esac
  require_postdeploy_operations_clear "$CREDENTIAL_LIVE_RELEASE" || exit $?
  CREDENTIAL_WORKTREE=""
  credential_live_phase_cleanup() {
    rc=$?
    trap - EXIT HUP INT TERM
    if [ -n "$CREDENTIAL_WORKTREE" ]; then
      git --git-dir="$CANONICAL_RELEASE_MIRROR" worktree remove --force "$CREDENTIAL_WORKTREE" 2>/dev/null || true
    fi
    exit "$rc"
  }
  trap credential_live_phase_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  require_canonical_main_sha "$CREDENTIAL_SHA" || exit 65
  credential_worktree_add "$CREDENTIAL_SHA" || exit 65
  require_node || exit 65
  (cd "$CREDENTIAL_WORKTREE" && "$NODE_BIN" scripts/check-taskboard.mjs --require-credential-remediation >/dev/null) || exit 65
  CREDENTIAL_RUN_ATTEMPT="$(verify_credential_ci_live "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_WORKTREE")" || exit 65
  require_installed_credential_attestor_for_sha "$CREDENTIAL_SHA" || exit 65
  CREDENTIAL_SERVICE_INVOCATION="$(systemctl show newme-platform.service -p InvocationID --value)"
  [[ "$CREDENTIAL_SERVICE_INVOCATION" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$ ]] || exit 65
  if [ "$CREDENTIAL_LIVE_ACTION" = credential-prove-revocation ]; then
    CREDENTIAL_LIVE_MODE=prove-revocation
    CREDENTIAL_EXPECTED_STATE=CUTOVER_INFLIGHT
    CREDENTIAL_EXPECTED_DIGEST=revocation_proof_sha256
  else
    CREDENTIAL_LIVE_MODE=complete
    CREDENTIAL_EXPECTED_STATE=COMPLETE
    CREDENTIAL_EXPECTED_DIGEST=completion_sha256
  fi
  CREDENTIAL_LIVE_OUTPUT="$(credential_live_exec "$CREDENTIAL_LIVE_MODE" \
    "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT" "$CREDENTIAL_SERVICE_INVOCATION")" || exit 65
  [ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | wc -l)" -eq 3 ] || exit 65
  [ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | sed -n 's/^credential_live_state=//p')" = "$CREDENTIAL_EXPECTED_STATE" ] || exit 65
  [[ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | sed -n 's/^transaction_id=//p')" =~ ^[0-9a-f-]{36}$ ]] || exit 65
  [[ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | sed -n "s/^$CREDENTIAL_EXPECTED_DIGEST=//p")" =~ ^[0-9a-f]{64}$ ]] || exit 65
  require_canonical_main_sha "$CREDENTIAL_SHA" || exit 65
  CREDENTIAL_RUN_ATTEMPT_FINAL="$(verify_credential_ci_live "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_WORKTREE")" || exit 65
  [ "$CREDENTIAL_RUN_ATTEMPT_FINAL" = "$CREDENTIAL_RUN_ATTEMPT" ] || exit 65
  [ "$(systemctl show newme-platform.service -p InvocationID --value)" = "$CREDENTIAL_SERVICE_INVOCATION" ] || exit 66
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" = "$CREDENTIAL_LIVE_RELEASE" ] || exit 66
  printf '%s release=%s run=%s run_attempt=%s\n' \
    "credential_live_state=$CREDENTIAL_EXPECTED_STATE" "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT"
  exit 0
  ;;
credential-live-readback|credential-live-consume)
  [ "$#" -eq 4 ] || {
    echo "usage: newme-deploy ${1:-credential-live-readback} <remediation-sha> <canonical-main-closure-sha> <successful-credential-remediation-run-id>" >&2
    exit 64
  }
  CREDENTIAL_LIVE_ACTION=$1
  CREDENTIAL_REMEDIATION_SHA=$2
  CREDENTIAL_RELEASE_SHA=$3
  CREDENTIAL_RUN_ID=$4
  [[ "$CREDENTIAL_REMEDIATION_SHA" =~ ^[0-9a-f]{40}$ ]] && [[ "$CREDENTIAL_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] &&
    [[ "$CREDENTIAL_RUN_ID" =~ ^[1-9][0-9]*$ ]] || exit 64
  validate_deploy_state_root || exit 65
  for blocker in "$PENDING_ASSET_RECORD" "$CREDENTIAL_ASSET_PENDING" "$CREDENTIAL_GATE_CONSUMED" "$PRODUCTION_ROLLBACK_PENDING"; do
    [ ! -e "$blocker" ] && [ ! -L "$blocker" ] || exit 75
  done
  CREDENTIAL_LIVE_RELEASE="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  case "$CREDENTIAL_LIVE_RELEASE" in /opt/newme/releases/[0-9a-f][0-9a-f]*) ;; *) exit 65 ;; esac
  require_postdeploy_operations_clear "$CREDENTIAL_LIVE_RELEASE" || exit $?
  CREDENTIAL_WORKTREE=""
  credential_live_release_cleanup() {
    rc=$?
    trap - EXIT HUP INT TERM
    if [ -n "$CREDENTIAL_WORKTREE" ]; then
      git --git-dir="$CANONICAL_RELEASE_MIRROR" worktree remove --force "$CREDENTIAL_WORKTREE" 2>/dev/null || true
    fi
    exit "$rc"
  }
  trap credential_live_release_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  require_canonical_main_sha "$CREDENTIAL_RELEASE_SHA" || exit 65
  credential_worktree_add "$CREDENTIAL_RELEASE_SHA" || exit 65
  require_node || exit 65
  CREDENTIAL_RUN_ATTEMPT="$(verify_credential_ci_live "$CREDENTIAL_RELEASE_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_WORKTREE")" || exit 65
  require_installed_credential_attestor_for_sha "$CREDENTIAL_REMEDIATION_SHA" || exit 65
  CREDENTIAL_SERVICE_INVOCATION="$(systemctl show newme-platform.service -p InvocationID --value)"
  [[ "$CREDENTIAL_SERVICE_INVOCATION" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$ ]] || exit 65
  if [ "$CREDENTIAL_LIVE_ACTION" = credential-live-readback ]; then
    CREDENTIAL_LIVE_MODE=readback
    CREDENTIAL_EXPECTED_DIGEST=readback_sha256
    CREDENTIAL_EXPECTED_STATE=COMPLETE
  else
    CREDENTIAL_LIVE_MODE=consume
    CREDENTIAL_EXPECTED_DIGEST=tombstone_sha256
    CREDENTIAL_EXPECTED_STATE=CONSUMED
  fi
  CREDENTIAL_LIVE_OUTPUT="$(credential_live_exec "$CREDENTIAL_LIVE_MODE" \
    "$CREDENTIAL_REMEDIATION_SHA" "$CREDENTIAL_RELEASE_SHA" "$CREDENTIAL_RUN_ID" \
    "$CREDENTIAL_RUN_ATTEMPT" "$CREDENTIAL_SERVICE_INVOCATION")" || exit 65
  [ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | wc -l)" -eq 3 ] || exit 65
  [ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | sed -n 's/^credential_live_state=//p')" = "$CREDENTIAL_EXPECTED_STATE" ] || exit 65
  [[ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | sed -n 's/^transaction_id=//p')" =~ ^[0-9a-f-]{36}$ ]] || exit 65
  [[ "$(printf '%s\n' "$CREDENTIAL_LIVE_OUTPUT" | sed -n "s/^$CREDENTIAL_EXPECTED_DIGEST=//p")" =~ ^[0-9a-f]{64}$ ]] || exit 65
  require_canonical_main_sha "$CREDENTIAL_RELEASE_SHA" || exit 65
  CREDENTIAL_RUN_ATTEMPT_FINAL="$(verify_credential_ci_live "$CREDENTIAL_RELEASE_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_WORKTREE")" || exit 65
  [ "$CREDENTIAL_RUN_ATTEMPT_FINAL" = "$CREDENTIAL_RUN_ATTEMPT" ] || exit 65
  [ "$(systemctl show newme-platform.service -p InvocationID --value)" = "$CREDENTIAL_SERVICE_INVOCATION" ] || exit 66
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" = "$CREDENTIAL_LIVE_RELEASE" ] || exit 66
  printf '%s remediation=%s release=%s run=%s run_attempt=%s\n' \
    "credential_live_state=$CREDENTIAL_EXPECTED_STATE" "$CREDENTIAL_REMEDIATION_SHA" "$CREDENTIAL_RELEASE_SHA" \
    "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT"
  exit 0
  ;;
credential-trust-bootstrap)
  [ "$#" -eq 3 ] || {
    echo "usage: newme-deploy credential-trust-bootstrap <canonical-main-sha> <successful-credential-remediation-run-id>" >&2
    exit 64
  }
  CREDENTIAL_SHA=${2:-}
  CREDENTIAL_RUN_ID=${3:-}
  [[ "$CREDENTIAL_SHA" =~ ^[0-9a-f]{40}$ ]] && [[ "$CREDENTIAL_RUN_ID" =~ ^[1-9][0-9]*$ ]] || {
    echo "credential-trust-bootstrap arguments are invalid" >&2
    exit 64
  }
  validate_deploy_state_root || exit 65
  for blocker in "$PENDING_ASSET_RECORD" "$CREDENTIAL_ASSET_PENDING" "$CREDENTIAL_GATE_CONSUMED" "$CREDENTIAL_TRANSITION_PENDING" "$PRODUCTION_ROLLBACK_PENDING"; do
    if [ -e "$blocker" ] || [ -L "$blocker" ]; then
      echo "an unresolved production transaction must be recovered before credential transition" >&2
      exit 75
    fi
  done
  CREDENTIAL_LIVE_RELEASE="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  case "$CREDENTIAL_LIVE_RELEASE" in /opt/newme/releases/[0-9a-f][0-9a-f]*) ;; *) echo "current immutable release is invalid" >&2; exit 65 ;; esac
  require_postdeploy_operations_clear "$CREDENTIAL_LIVE_RELEASE" || exit $?
  CREDENTIAL_WORKTREE=""
  CREDENTIAL_GATE_RECORD=""
  CREDENTIAL_ASSET_OPEN=0
  credential_coordinator_cleanup() {
    rc=$?
    trap - EXIT HUP INT TERM
    if [ "$rc" -ne 0 ] && [ "$CREDENTIAL_ASSET_OPEN" -eq 1 ] && [ -n "$CREDENTIAL_WORKTREE" ]; then
      if bash "$CREDENTIAL_WORKTREE/scripts/install-systemd-assets.sh" credential-recover; then
        CREDENTIAL_ASSET_OPEN=0
      else
        echo "CRITICAL: credential-only asset transaction requires explicit credential-recover" >&2
        rc=2
      fi
    fi
    if [ -n "$CREDENTIAL_GATE_RECORD" ]; then
      case "$CREDENTIAL_GATE_RECORD" in "$STATE_ROOT"/credential-remediation-gates.*) rm -f -- "$CREDENTIAL_GATE_RECORD" ;; esac
    fi
    if [ -n "$CREDENTIAL_WORKTREE" ]; then
      git --git-dir="$CANONICAL_RELEASE_MIRROR" worktree remove --force "$CREDENTIAL_WORKTREE" 2>/dev/null || true
    fi
    sync -f "$STATE_ROOT" || true
    exit "$rc"
  }
  trap credential_coordinator_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  require_canonical_main_sha "$CREDENTIAL_SHA" || { echo "credential remediation SHA is not canonical main" >&2; exit 65; }
  credential_worktree_add "$CREDENTIAL_SHA" || exit 65
  require_node || exit 65
  (cd "$CREDENTIAL_WORKTREE" && "$NODE_BIN" scripts/check-taskboard.mjs --require-credential-remediation >/dev/null) || {
    echo "credential-remediation taskboard mode was refused" >&2
    exit 65
  }
  CREDENTIAL_RUN_ATTEMPT="$(verify_credential_ci_live "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_WORKTREE")" || {
    echo "dedicated credential-remediation CI evidence was refused" >&2
    exit 65
  }
  require_canonical_main_sha "$CREDENTIAL_SHA" || { echo "canonical main moved before credential-only asset installation" >&2; exit 65; }
  CREDENTIAL_GATE_RECORD="$(mktemp "$STATE_ROOT/credential-remediation-gates.XXXXXX")"
  chmod 0600 "$CREDENTIAL_GATE_RECORD"
  cat > "$CREDENTIAL_GATE_RECORD" <<EOF
sha=$CREDENTIAL_SHA
event=workflow_dispatch
run=$CREDENTIAL_RUN_ID
run_attempt=$CREDENTIAL_RUN_ATTEMPT
mode=credential_remediation
gate=canonical-main-verified
gate=github-credential-remediation-jobs-green
gate=taskboard-credential-remediation-ready
gate=credential-assets-only
EOF
  sync -f "$STATE_ROOT"
  CREDENTIAL_ASSET_OPEN=1
  NEWME_CREDENTIAL_GATE_RECORD="$CREDENTIAL_GATE_RECORD" NEWME_NODE_BIN="$NODE_BIN" \
    bash "$CREDENTIAL_WORKTREE/scripts/install-systemd-assets.sh" credential-install
  rm -f -- "$CREDENTIAL_GATE_RECORD"
  CREDENTIAL_GATE_RECORD=""
  sync -f "$STATE_ROOT"
  cmp -s "$CREDENTIAL_WORKTREE/infra/systemd/newme-deploy.sh" /usr/local/sbin/newme-deploy || {
    echo "installed credential coordinator differs from the exact remediation SHA" >&2
    exit 65
  }
  bash "$CREDENTIAL_WORKTREE/scripts/install-systemd-assets.sh" credential-finalize
  CREDENTIAL_ASSET_OPEN=0
  [ ! -e "$CREDENTIAL_ASSET_PENDING" ] && [ ! -L "$CREDENTIAL_ASSET_PENDING" ] || exit 66
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" = "$CREDENTIAL_LIVE_RELEASE" ] || {
    echo "credential-only asset installation changed the application release pointer" >&2
    exit 66
  }
  require_canonical_main_sha "$CREDENTIAL_SHA" || { echo "canonical main moved before credential trust bootstrap finalization" >&2; exit 65; }
  CREDENTIAL_RUN_ATTEMPT_FINAL="$(verify_credential_ci_live "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_WORKTREE")" || {
    echo "credential-remediation CI expired or changed before credential trust bootstrap finalization" >&2
    exit 65
  }
  [ "$CREDENTIAL_RUN_ATTEMPT_FINAL" = "$CREDENTIAL_RUN_ATTEMPT" ] || exit 65
  credential_transition_exec refresh-protection "$CREDENTIAL_SHA" >/dev/null || exit 66
  require_installed_credential_attestor_for_sha "$CREDENTIAL_SHA" || exit 66
  systemctl is-active --quiet newme-platform.service || exit 66
  /usr/local/libexec/newme/newme-readiness.sh >/dev/null || exit 66
  /usr/local/libexec/newme/newme-validate-production-config.py \
    --release-env /opt/newme/current/.env.local \
    --runtime-env /etc/newme/newme-runtime.env \
    --require-runtime-service-key --network >/dev/null || exit 66
  /opt/hermes-scripts/observability/dependency-probe.sh >/dev/null || exit 66
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" = "$CREDENTIAL_LIVE_RELEASE" ] || exit 66
  require_canonical_main_sha "$CREDENTIAL_SHA" || { echo "canonical main moved during credential cutover" >&2; exit 66; }
  echo "credential_trust_bootstrap=complete release=$CREDENTIAL_SHA run=$CREDENTIAL_RUN_ID run_attempt=$CREDENTIAL_RUN_ATTEMPT credential_asset_transaction=none"
  exit 0
  ;;
credential-transition)
  [ "$#" -eq 3 ] || {
    echo "usage: newme-deploy credential-transition <canonical-main-sha> <successful-credential-remediation-run-id>" >&2
    exit 64
  }
  CREDENTIAL_SHA=${2:-}
  CREDENTIAL_RUN_ID=${3:-}
  [[ "$CREDENTIAL_SHA" =~ ^[0-9a-f]{40}$ ]] && [[ "$CREDENTIAL_RUN_ID" =~ ^[1-9][0-9]*$ ]] || {
    echo "credential-transition arguments are invalid" >&2
    exit 64
  }
  validate_deploy_state_root || exit 65
  for blocker in \
    "$PENDING_ASSET_RECORD" "$CREDENTIAL_ASSET_PENDING" "$CREDENTIAL_GATE_CONSUMED" \
    "$CREDENTIAL_TRANSITION_PENDING" "$TRANSITION_BACKUP_RECORD" \
    "$STATE_ROOT/credential-transition.pending.next" "$STATE_ROOT/credential-transition.previous.env.preparing" \
    /etc/newme/newme-runtime.env.credential-transition.next "$PRODUCTION_ROLLBACK_PENDING"; do
    if [ -e "$blocker" ] || [ -L "$blocker" ]; then
      echo "an unresolved production or credential transaction must be recovered before credential transition" >&2
      exit 75
    fi
  done
  CREDENTIAL_LIVE_RELEASE="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  case "$CREDENTIAL_LIVE_RELEASE" in /opt/newme/releases/[0-9a-f][0-9a-f]*) ;; *) echo "current immutable release is invalid" >&2; exit 65 ;; esac
  require_postdeploy_operations_clear "$CREDENTIAL_LIVE_RELEASE" || exit $?
  CREDENTIAL_WORKTREE=""
  credential_transition_cleanup() {
    rc=$?
    trap - EXIT HUP INT TERM
    if [ -n "$CREDENTIAL_WORKTREE" ]; then
      git --git-dir="$CANONICAL_RELEASE_MIRROR" worktree remove --force "$CREDENTIAL_WORKTREE" 2>/dev/null || true
    fi
    exit "$rc"
  }
  trap credential_transition_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  require_canonical_main_sha "$CREDENTIAL_SHA" || { echo "credential remediation SHA is not canonical main" >&2; exit 65; }
  credential_worktree_add "$CREDENTIAL_SHA" || exit 65
  require_node || exit 65
  (cd "$CREDENTIAL_WORKTREE" && "$NODE_BIN" scripts/check-taskboard.mjs --require-credential-remediation >/dev/null) || {
    echo "credential-remediation taskboard mode was refused" >&2
    exit 65
  }
  CREDENTIAL_RUN_ATTEMPT="$(verify_credential_ci_live "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_WORKTREE")" || {
    echo "dedicated credential-remediation CI evidence was refused" >&2
    exit 65
  }
  CREDENTIAL_SERVICE_INVOCATION="$(systemctl show newme-platform.service -p InvocationID --value)"
  [[ "$CREDENTIAL_SERVICE_INVOCATION" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$ ]] || {
    echo "the live service invocation identity is invalid" >&2
    exit 65
  }
  CREDENTIAL_PROVIDER_OUTPUT="$(credential_live_exec materialize-provider \
    "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT" "$CREDENTIAL_SERVICE_INVOCATION")" || {
    echo "provider-bound credential materialization was refused" >&2
    exit 65
  }
  [ "$(printf '%s\n' "$CREDENTIAL_PROVIDER_OUTPUT" | wc -l)" -eq 3 ] || exit 65
  [ "$(printf '%s\n' "$CREDENTIAL_PROVIDER_OUTPUT" | sed -n 's/^credential_provider_materialization=//p')" = complete ] || exit 65
  [[ "$(printf '%s\n' "$CREDENTIAL_PROVIDER_OUTPUT" | sed -n 's/^transaction_id=//p')" =~ ^[0-9a-f-]{36}$ ]] || exit 65
  [[ "$(printf '%s\n' "$CREDENTIAL_PROVIDER_OUTPUT" | sed -n 's/^provider_identity_receipt_sha256=//p')" =~ ^[0-9a-f]{64}$ ]] || exit 65
  [ "$(systemctl show newme-platform.service -p InvocationID --value)" = "$CREDENTIAL_SERVICE_INVOCATION" ] || exit 65
  CREDENTIAL_PREPARE_OUTPUT="$(credential_live_exec prepare \
    "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT" "$CREDENTIAL_SERVICE_INVOCATION")" || {
    echo "signed credential precheck production was refused" >&2
    exit 65
  }
  [ "$(printf '%s\n' "$CREDENTIAL_PREPARE_OUTPUT" | wc -l)" -eq 4 ] || exit 65
  [ "$(printf '%s\n' "$CREDENTIAL_PREPARE_OUTPUT" | sed -n 's/^credential_live_state=//p')" = PREPARED ] || exit 65
  [[ "$(printf '%s\n' "$CREDENTIAL_PREPARE_OUTPUT" | sed -n 's/^transaction_id=//p')" =~ ^[0-9a-f-]{36}$ ]] || exit 65
  [[ "$(printf '%s\n' "$CREDENTIAL_PREPARE_OUTPUT" | sed -n 's/^precheck_sha256=//p')" =~ ^[0-9a-f]{64}$ ]] || exit 65
  [ "$(printf '%s\n' "$CREDENTIAL_PREPARE_OUTPUT" | sed -n 's/^ci_run_attempt=//p')" = "$CREDENTIAL_RUN_ATTEMPT" ] || exit 65
  verify_credential_precheck_live "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT" "$CREDENTIAL_SERVICE_INVOCATION" || {
    echo "signed credential precheck was refused" >&2
    exit 65
  }
  CREDENTIAL_TRANSACTION_ID_FIRST="$CREDENTIAL_TRANSACTION_ID"
  CREDENTIAL_PRECHECK_SHA256_FIRST="$CREDENTIAL_PRECHECK_SHA256"
  CREDENTIAL_PRECHECK_ASSETS_FIRST="$CREDENTIAL_PRECHECK_ASSETS_SHA256"
  CREDENTIAL_TRANSITION_BEFORE_FIRST="$CREDENTIAL_TRANSITION_BEFORE_SHA256"
  CREDENTIAL_TRANSITION_AFTER_FIRST="$CREDENTIAL_TRANSITION_AFTER_SHA256"
  require_canonical_main_sha "$CREDENTIAL_SHA" || { echo "canonical main moved before credential cutover" >&2; exit 65; }
  CREDENTIAL_RUN_ATTEMPT_FINAL="$(verify_credential_ci_live "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_WORKTREE")" || {
    echo "credential-remediation CI expired or changed before credential cutover" >&2
    exit 65
  }
  [ "$CREDENTIAL_RUN_ATTEMPT_FINAL" = "$CREDENTIAL_RUN_ATTEMPT" ] || exit 65
  CREDENTIAL_SERVICE_INVOCATION_FINAL="$(systemctl show newme-platform.service -p InvocationID --value)"
  [ "$CREDENTIAL_SERVICE_INVOCATION_FINAL" = "$CREDENTIAL_SERVICE_INVOCATION" ] || exit 65
  verify_credential_precheck_live "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT" "$CREDENTIAL_SERVICE_INVOCATION" || exit 65
  [ "$CREDENTIAL_TRANSACTION_ID" = "$CREDENTIAL_TRANSACTION_ID_FIRST" ] &&
    [ "$CREDENTIAL_PRECHECK_SHA256" = "$CREDENTIAL_PRECHECK_SHA256_FIRST" ] &&
    [ "$CREDENTIAL_PRECHECK_ASSETS_SHA256" = "$CREDENTIAL_PRECHECK_ASSETS_FIRST" ] &&
    [ "$CREDENTIAL_TRANSITION_BEFORE_SHA256" = "$CREDENTIAL_TRANSITION_BEFORE_FIRST" ] &&
    [ "$CREDENTIAL_TRANSITION_AFTER_SHA256" = "$CREDENTIAL_TRANSITION_AFTER_FIRST" ] || exit 65
  CREDENTIAL_TRANSITION_RESULT="$(credential_transition_exec apply \
    "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT" "$CREDENTIAL_TRANSACTION_ID" \
    "$CREDENTIAL_PRECHECK_SHA256" "$CREDENTIAL_TRANSITION_BEFORE_SHA256" \
    "$CREDENTIAL_TRANSITION_AFTER_SHA256")" || exit 65
  [ "$CREDENTIAL_TRANSITION_RESULT" = credential_transition=awaiting_provider_revocation ] || exit 66
  validate_credential_awaiting_state "$CREDENTIAL_SHA" "$CREDENTIAL_RUN_ID" "$CREDENTIAL_RUN_ATTEMPT" \
    "$CREDENTIAL_TRANSACTION_ID" "$CREDENTIAL_PRECHECK_SHA256" || exit 66
  systemctl is-active --quiet newme-platform.service || exit 66
  /usr/local/libexec/newme/newme-readiness.sh >/dev/null || exit 66
  /usr/local/libexec/newme/newme-validate-production-config.py \
    --release-env /opt/newme/current/.env.local \
    --runtime-env /etc/newme/newme-runtime.env \
    --require-runtime-service-key --network >/dev/null || exit 66
  /opt/hermes-scripts/observability/dependency-probe.sh >/dev/null || exit 66
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" = "$CREDENTIAL_LIVE_RELEASE" ] || exit 66
  require_canonical_main_sha "$CREDENTIAL_SHA" || { echo "canonical main moved during credential cutover" >&2; exit 66; }
  echo "credential_transition=awaiting_provider_revocation release=$CREDENTIAL_SHA run=$CREDENTIAL_RUN_ID run_attempt=$CREDENTIAL_RUN_ATTEMPT transaction_id=$CREDENTIAL_TRANSACTION_ID"
  exit 0
  ;;
credential-recover)
  [ "$#" -eq 1 ] || { echo "usage: newme-deploy credential-recover" >&2; exit 64; }
  validate_deploy_state_root || exit 65
  CREDENTIAL_WORKTREE=""
  credential_recovery_cleanup() {
    rc=$?
    trap - EXIT HUP INT TERM
    if [ -n "$CREDENTIAL_WORKTREE" ]; then
      git --git-dir="$CANONICAL_RELEASE_MIRROR" worktree remove --force "$CREDENTIAL_WORKTREE" 2>/dev/null || true
    fi
    exit "$rc"
  }
  trap credential_recovery_cleanup EXIT
  if [ -e "$CREDENTIAL_ASSET_PENDING" ] || [ -L "$CREDENTIAL_ASSET_PENDING" ] ||
    [ -e "$CREDENTIAL_GATE_CONSUMED" ] || [ -L "$CREDENTIAL_GATE_CONSUMED" ]; then
    CREDENTIAL_RECOVERY_SHA=""
    CREDENTIAL_RECOVERY_RUN=""
    CREDENTIAL_RECOVERY_ATTEMPT=""
    if [ -e "$CREDENTIAL_ASSET_PENDING" ] || [ -L "$CREDENTIAL_ASSET_PENDING" ]; then
      [ -f "$CREDENTIAL_ASSET_PENDING" ] && [ ! -L "$CREDENTIAL_ASSET_PENDING" ] || exit 65
      [ "$(stat -c '%U:%G' "$CREDENTIAL_ASSET_PENDING")" = root:root ] &&
        [ "$(stat -c '%a' "$CREDENTIAL_ASSET_PENDING")" = 600 ] || exit 65
      [ "$(wc -l < "$CREDENTIAL_ASSET_PENDING")" -eq 8 ] || exit 65
      [ "$(grep -Ec '^version=1$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^sha=[0-9a-f]{40}$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^run=[1-9][0-9]*$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^run_attempt=[1-9][0-9]*$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^gate_sha256=[0-9a-f]{64}$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^phase=prepared$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^mode=credential_remediation$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || exit 65
      CREDENTIAL_RECOVERY_SHA="$(sed -n 's/^sha=\([0-9a-f]\{40\}\)$/\1/p' "$CREDENTIAL_ASSET_PENDING")"
      CREDENTIAL_RECOVERY_RUN="$(sed -n 's/^run=\([1-9][0-9]*\)$/\1/p' "$CREDENTIAL_ASSET_PENDING")"
      CREDENTIAL_RECOVERY_ATTEMPT="$(sed -n 's/^run_attempt=\([1-9][0-9]*\)$/\1/p' "$CREDENTIAL_ASSET_PENDING")"
    else
      [ -f "$CREDENTIAL_GATE_CONSUMED" ] && [ ! -L "$CREDENTIAL_GATE_CONSUMED" ] || exit 65
      [ "$(stat -c '%U:%G' "$CREDENTIAL_GATE_CONSUMED")" = root:root ] &&
        [ "$(stat -c '%a' "$CREDENTIAL_GATE_CONSUMED")" = 600 ] || exit 65
      [ "$(wc -l < "$CREDENTIAL_GATE_CONSUMED")" -eq 9 ] || exit 65
      [ "$(grep -Ec '^sha=[0-9a-f]{40}$' "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^run=[1-9][0-9]*$' "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^run_attempt=[1-9][0-9]*$' "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^event=workflow_dispatch$' "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || exit 65
      [ "$(grep -Ec '^mode=credential_remediation$' "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || exit 65
      for gate in canonical-main-verified github-credential-remediation-jobs-green taskboard-credential-remediation-ready credential-assets-only; do
        [ "$(grep -Ec "^gate=$gate$" "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || exit 65
      done
      CREDENTIAL_RECOVERY_SHA="$(sed -n 's/^sha=\([0-9a-f]\{40\}\)$/\1/p' "$CREDENTIAL_GATE_CONSUMED")"
      CREDENTIAL_RECOVERY_RUN="$(sed -n 's/^run=\([1-9][0-9]*\)$/\1/p' "$CREDENTIAL_GATE_CONSUMED")"
      CREDENTIAL_RECOVERY_ATTEMPT="$(sed -n 's/^run_attempt=\([1-9][0-9]*\)$/\1/p' "$CREDENTIAL_GATE_CONSUMED")"
    fi
    [[ "$CREDENTIAL_RECOVERY_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 65
    [[ "$CREDENTIAL_RECOVERY_RUN" =~ ^[1-9][0-9]*$ ]] || exit 65
    [[ "$CREDENTIAL_RECOVERY_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || exit 65
    [ -d "$CANONICAL_RELEASE_MIRROR" ] && [ ! -L "$CANONICAL_RELEASE_MIRROR" ] || exit 65
    credential_worktree_add "$CREDENTIAL_RECOVERY_SHA" || exit 65
    bash "$CREDENTIAL_WORKTREE/scripts/install-systemd-assets.sh" credential-recover || exit 66
  fi
  CREDENTIAL_RECOVERY_RESULT=none
  if [ -e "$CREDENTIAL_TRANSITION_PENDING" ] || [ -L "$CREDENTIAL_TRANSITION_PENDING" ] ||
    [ -e "$TRANSITION_BACKUP_RECORD" ] || [ -L "$TRANSITION_BACKUP_RECORD" ] ||
    [ -e "$STATE_ROOT/credential-transition.pending.next" ] || [ -L "$STATE_ROOT/credential-transition.pending.next" ] ||
    [ -e "$STATE_ROOT/credential-transition.previous.env.preparing" ] || [ -L "$STATE_ROOT/credential-transition.previous.env.preparing" ] ||
    [ -e /etc/newme/newme-runtime.env.credential-transition.next ] || [ -L /etc/newme/newme-runtime.env.credential-transition.next ]; then
    [ -x "$CREDENTIAL_TRANSITION_HELPER" ] || {
      echo "credential transition recovery helper is unavailable" >&2
      exit 66
    }
    CREDENTIAL_RECOVERY_OUTPUT="$(credential_transition_exec recover)" || exit 66
    case "$CREDENTIAL_RECOVERY_OUTPUT" in
      credential_transition=awaiting_provider_revocation)
        CREDENTIAL_RECOVERY_RESULT=awaiting_provider_revocation
        IFS=$'\t' read -r CREDENTIAL_RECOVERY_SHA CREDENTIAL_RECOVERY_RUN CREDENTIAL_RECOVERY_ATTEMPT CREDENTIAL_RECOVERY_TX CREDENTIAL_RECOVERY_PRECHECK < <(
          python3 - "$CREDENTIAL_TRANSITION_PENDING" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    record = json.load(handle)
print("\t".join(str(record.get(key, "")) for key in (
    "candidate_sha", "ci_run_id", "ci_run_attempt", "transaction_id", "precheck_sha256"
)))
PY
        )
        validate_credential_awaiting_state "$CREDENTIAL_RECOVERY_SHA" "$CREDENTIAL_RECOVERY_RUN" \
          "$CREDENTIAL_RECOVERY_ATTEMPT" "$CREDENTIAL_RECOVERY_TX" "$CREDENTIAL_RECOVERY_PRECHECK" || exit 66
        ;;
      credential_transition=rolled_back|credential_transition=interrupted_before_switch)
        CREDENTIAL_RECOVERY_RESULT="${CREDENTIAL_RECOVERY_OUTPUT#credential_transition=}"
        for cleared in "$CREDENTIAL_TRANSITION_PENDING" "$TRANSITION_BACKUP_RECORD" \
          "$STATE_ROOT/credential-transition.pending.next" "$STATE_ROOT/credential-transition.previous.env.preparing" \
          /etc/newme/newme-runtime.env.credential-transition.next; do
          [ ! -e "$cleared" ] && [ ! -L "$cleared" ] || exit 66
        done
        ;;
      *) exit 66 ;;
    esac
  fi
  for cleared in "$CREDENTIAL_ASSET_PENDING" "$PENDING_ASSET_RECORD" "$CREDENTIAL_GATE_CONSUMED"; do
    [ ! -e "$cleared" ] && [ ! -L "$cleared" ] || exit 66
  done
  systemctl is-active --quiet newme-platform.service || exit 66
  if [ -x /usr/local/libexec/newme/newme-readiness.sh ]; then
    /usr/local/libexec/newme/newme-readiness.sh >/dev/null || exit 66
  fi
  echo "credential_recovery=$CREDENTIAL_RECOVERY_RESULT credential_asset_transaction=none systemd_asset_transaction=none credential_gate_consumed=none credential_transition_pending=$CREDENTIAL_RECOVERY_RESULT"
  exit 0
  ;;
esac

# Completion is a two-commit claim. The immutable application release stays at
# FINALIZE_RELEASE_SHA; a later canonical-main commit at FINALIZE_CLOSURE_SHA may
# close postdeploy TASKBOARD rows, but it may change nothing else. This function
# re-measures that relationship from the root-owned mirror and then requires the
# release-final GitHub job to have succeeded at the closure SHA. It runs in a
# subshell so token/config cleanup cannot be bypassed by an early return.
verify_release_closure_and_final_ci() (
  set -Eeuo pipefail
  local mirror=/opt/newme/repository.git
  local origin_https=https://github.com/69755354/newme-platform.git
  local origin_ssh=git@github.com:69755354/newme-platform.git
  local token_file=/etc/newme/github-actions-read.token
  local checker="$FINALIZE_TARGET/scripts/check-release-closure.mjs"
  local main_sha github_token
  local curl_config="" run_file="" jobs_file="" workflow_file="" manifest_file=""

  cleanup_finalize_ci_files() {
    local file
    for file in "$curl_config" "$run_file" "$jobs_file" "$workflow_file" "$manifest_file"; do
      [ -z "$file" ] || rm -f -- "$file" || true
    done
  }
  trap cleanup_finalize_ci_files EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  [ -d "$mirror" ] || { echo "root-owned release mirror is missing" >&2; return 65; }
  [ "$(stat -c '%U:%G' "$mirror")" = root:root ] || { echo "release mirror ownership is invalid" >&2; return 65; }
  case "$(git --git-dir="$mirror" remote get-url origin)" in
    "$origin_https"|"$origin_ssh") ;;
    *) echo "release mirror origin is invalid" >&2; return 65 ;;
  esac

  git --git-dir="$mirror" fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main' || return 65
  main_sha="$(git --git-dir="$mirror" rev-parse refs/remotes/origin/main)" || return 65
  [ "$FINALIZE_CLOSURE_SHA" = "$main_sha" ] || {
    echo "closure SHA must equal canonical main" >&2
    return 65
  }
  [ -f "$checker" ] && [ ! -L "$checker" ] || {
    echo "the deployed release carries no release-closure checker" >&2
    return 65
  }
  require_immutable_release_asset "$FINALIZE_RELEASE_SHA" \
    scripts/check-release-closure.mjs "$checker" 440 || {
      echo "release-closure checker ownership, mode, or exact-SHA bytes are invalid" >&2
      return 65
    }
  "$NODE_BIN" "$checker" \
    --release-sha "$FINALIZE_RELEASE_SHA" \
    --closure-sha "$FINALIZE_CLOSURE_SHA" \
    --acceptance-digest "$FINALIZE_ACCEPTANCE_DIGEST" \
    --repo "$mirror" || return 65

  [ -f "$token_file" ] && [ ! -L "$token_file" ] || {
    echo "root-owned GitHub Actions read token is missing" >&2
    return 65
  }
  [ "$(stat -c '%U:%G' "$token_file")" = root:root ] || {
    echo "GitHub Actions read token ownership is invalid" >&2
    return 65
  }
  case "$(stat -c '%a' "$token_file")" in
    400|600) ;;
    *) echo "GitHub Actions read token mode must be 0400 or 0600" >&2; return 65 ;;
  esac
  IFS= read -r github_token < "$token_file" || true
  [[ "$github_token" =~ ^[A-Za-z0-9_]{20,512}$ ]] || {
    echo "GitHub Actions read token format is invalid" >&2
    return 65
  }

  curl_config="$(mktemp /run/newme-finalize-github-config.XXXXXX)" || return 65
  run_file="$(mktemp /run/newme-finalize-run.XXXXXX)" || return 65
  jobs_file="$(mktemp /run/newme-finalize-jobs.XXXXXX)" || return 65
  workflow_file="$(mktemp /run/newme-finalize-workflow.XXXXXX)" || return 65
  manifest_file="$(mktemp /run/newme-finalize-jobs-manifest.XXXXXX)" || return 65
  chmod 0600 "$curl_config" "$run_file" "$jobs_file" "$workflow_file" "$manifest_file" || return 65
  printf 'header = "Authorization: Bearer %s"\n' "$github_token" > "$curl_config" || return 65
  unset github_token

  curl --fail --silent --show-error --max-time 15 \
    --config "$curl_config" \
    -H 'Accept: application/vnd.github+json' \
    -o "$run_file" \
    "https://api.github.com/repos/69755354/newme-platform/actions/runs/$FINALIZE_RUN_ID" || return 65
  curl --fail --silent --show-error --max-time 20 \
    --config "$curl_config" \
    -H 'Accept: application/vnd.github+json' \
    -o "$jobs_file" \
    "https://api.github.com/repos/69755354/newme-platform/actions/runs/$FINALIZE_RUN_ID/jobs?per_page=100&filter=latest" || return 65
  curl --fail --silent --show-error --max-time 15 \
    --config "$curl_config" \
    -H 'Accept: application/vnd.github+json' \
    -o "$workflow_file" \
    "https://api.github.com/repos/69755354/newme-platform/actions/workflows/$CANONICAL_CI_WORKFLOW_ID" || return 65
  git --git-dir="$mirror" show \
    "$FINALIZE_CLOSURE_SHA:infra/release/final-required-jobs.json" > "$manifest_file" || {
    echo "closure SHA carries no final-required-jobs manifest" >&2
    return 65
  }

  "$NODE_BIN" "$checker" \
    --release-sha "$FINALIZE_RELEASE_SHA" \
    --closure-sha "$FINALIZE_CLOSURE_SHA" \
    --acceptance-digest "$FINALIZE_ACCEPTANCE_DIGEST" \
    --repo "$mirror" \
    --run-id "$FINALIZE_RUN_ID" \
    --run-json-file "$run_file" \
    --jobs-json-file "$jobs_file" \
    --workflow-json-file "$workflow_file" \
    --required-jobs-file "$manifest_file"
)

case "${1:-}" in
accept|accept-recover|accept-abort)
  [ "$#" -eq 2 ] || {
    echo "usage: newme-deploy <accept|accept-recover|accept-abort> <release-sha>" >&2
    exit 64
  }
  ACCEPT_ACTION=${1:-}
  ACCEPT_RELEASE_SHA=${2:-}
  [[ "$ACCEPT_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "acceptance release SHA is invalid" >&2; exit 64; }
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || { echo "persistent deploy-state directory is invalid" >&2; exit 65; }
  [ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] && [ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || {
    echo "persistent deploy-state directory permissions are invalid" >&2
    exit 65
  }
  if [ -e "$PENDING_ASSET_RECORD" ] || [ -L "$PENDING_ASSET_RECORD" ] ||
    [ -e "$CREDENTIAL_ASSET_PENDING" ] || [ -L "$CREDENTIAL_ASSET_PENDING" ] ||
    [ -e "$CREDENTIAL_GATE_CONSUMED" ] || [ -L "$CREDENTIAL_GATE_CONSUMED" ] ||
    [ -e "$CREDENTIAL_TRANSITION_PENDING" ] || [ -L "$CREDENTIAL_TRANSITION_PENDING" ] ||
    [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; then
    echo "unresolved deployment or rollback state must be recovered before acceptance" >&2
    exit 75
  fi
  ACCEPT_TARGET="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  [ "$ACCEPT_TARGET" = "/opt/newme/releases/$ACCEPT_RELEASE_SHA" ] || {
    echo "acceptance SHA must equal the current immutable release" >&2
    exit 65
  }
  require_node || exit 65
  ACCEPT_RUNNER="$ACCEPT_TARGET/scripts/run-postdeploy-acceptance.mjs"
  [ -f "$ACCEPT_RUNNER" ] && [ ! -L "$ACCEPT_RUNNER" ] || {
    echo "current release lacks the canonical postdeploy acceptance runner" >&2
    exit 65
  }
  require_immutable_release_asset "$ACCEPT_RELEASE_SHA" \
    scripts/run-postdeploy-acceptance.mjs "$ACCEPT_RUNNER" 440 || {
      echo "postdeploy acceptance runner ownership, mode, or exact-SHA bytes are invalid" >&2
      exit 65
    }
  require_immutable_release_asset "$ACCEPT_RELEASE_SHA" \
    scripts/postdeploy-receipt.mjs "$ACCEPT_TARGET/scripts/postdeploy-receipt.mjs" 440 || {
      echo "postdeploy receipt module ownership, mode, or exact-SHA bytes are invalid" >&2
      exit 65
    }
  require_immutable_release_asset "$ACCEPT_RELEASE_SHA" \
    scripts/canonical-browser-uat.mjs "$ACCEPT_TARGET/scripts/canonical-browser-uat.mjs" 440 &&
    require_immutable_release_asset "$ACCEPT_RELEASE_SHA" \
      scripts/run-postdeploy-browser-uat.mjs "$ACCEPT_TARGET/scripts/run-postdeploy-browser-uat.mjs" 440 || {
        echo "postdeploy browser runner ownership, mode, or exact-SHA bytes are invalid" >&2
        exit 65
      }
  mapfile -t ACCEPT_EVIDENCE_FILES < <(find "$ACCEPT_TARGET/.audit" -maxdepth 1 -type f -name 'deploy-*.json' -print)
  [ "${#ACCEPT_EVIDENCE_FILES[@]}" -eq 1 ] || { echo "current release must contain exactly one deployment evidence file" >&2; exit 65; }
  python3 - "${ACCEPT_EVIDENCE_FILES[0]}" "$ACCEPT_RELEASE_SHA" <<'PY' || exit 65
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    evidence = json.load(handle)
if evidence.get("git_sha") != sys.argv[2] or evidence.get("release_status") != "awaiting_uat":
    raise SystemExit(65)
PY
  case "$ACCEPT_ACTION" in
    accept)
      "$NODE_BIN" "$ACCEPT_RUNNER" --release-sha "$ACCEPT_RELEASE_SHA" || exit 65
      "$NODE_BIN" "$ACCEPT_RUNNER" --assert-ready --release-sha "$ACCEPT_RELEASE_SHA" >/dev/null || exit 65
      ;;
    accept-recover)
      "$NODE_BIN" "$ACCEPT_RUNNER" --recover --release-sha "$ACCEPT_RELEASE_SHA" || exit 65
      "$NODE_BIN" "$ACCEPT_RUNNER" --assert-operations-clear >/dev/null || exit 65
      ;;
    accept-abort)
      "$NODE_BIN" "$ACCEPT_RUNNER" --abort --release-sha "$ACCEPT_RELEASE_SHA" || exit 65
      "$NODE_BIN" "$ACCEPT_RUNNER" --assert-operations-clear >/dev/null || exit 65
      ;;
  esac
  sync -f /var/lib/newme
  echo "postdeploy acceptance action=$ACCEPT_ACTION release=$ACCEPT_RELEASE_SHA completed"
  exit 0
  ;;
esac

case "${1:-}" in
attest|attest-recover|attest-abort)
  [ "$#" -eq 2 ] || {
    echo "usage: newme-deploy <attest|attest-recover|attest-abort> <release-sha>" >&2
    exit 64
  }
  ATTEST_ACTION=${1:-}
  ATTEST_RELEASE_SHA=${2:-}
  ATTEST_BUNDLE="$POSTDEPLOY_INTAKE_ROOT/$ATTEST_RELEASE_SHA/bundle.json"
  [[ "$ATTEST_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "attest release SHA is invalid" >&2; exit 64; }
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || { echo "persistent deploy-state directory is invalid" >&2; exit 65; }
  [ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] && [ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || {
    echo "persistent deploy-state directory permissions are invalid" >&2
    exit 65
  }
  if [ -e "$PENDING_ASSET_RECORD" ] || [ -L "$PENDING_ASSET_RECORD" ] ||
    [ -e "$CREDENTIAL_ASSET_PENDING" ] || [ -L "$CREDENTIAL_ASSET_PENDING" ] ||
    [ -e "$CREDENTIAL_GATE_CONSUMED" ] || [ -L "$CREDENTIAL_GATE_CONSUMED" ] ||
    [ -e "$CREDENTIAL_TRANSITION_PENDING" ] || [ -L "$CREDENTIAL_TRANSITION_PENDING" ] ||
    [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; then
    echo "unresolved deployment or rollback state must be recovered before attestation" >&2
    exit 75
  fi
  ATTEST_TARGET="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  [ "$ATTEST_TARGET" = "/opt/newme/releases/$ATTEST_RELEASE_SHA" ] || {
    echo "attest SHA must equal the current immutable release" >&2
    exit 65
  }
  require_node || exit 65
  ATTEST_PRODUCER="$ATTEST_TARGET/scripts/run-postdeploy-acceptance.mjs"
  [ -f "$ATTEST_PRODUCER" ] && [ ! -L "$ATTEST_PRODUCER" ] || { echo "release lacks the canonical acceptance producer" >&2; exit 65; }
  require_immutable_release_asset "$ATTEST_RELEASE_SHA" \
    scripts/run-postdeploy-acceptance.mjs "$ATTEST_PRODUCER" 440 &&
    require_immutable_release_asset "$ATTEST_RELEASE_SHA" \
      scripts/postdeploy-receipt.mjs "$ATTEST_TARGET/scripts/postdeploy-receipt.mjs" 440 &&
    require_immutable_release_asset "$ATTEST_RELEASE_SHA" \
      scripts/canonical-browser-uat.mjs "$ATTEST_TARGET/scripts/canonical-browser-uat.mjs" 440 || {
        echo "postdeploy acceptance producer ownership, mode, or exact-SHA bytes are invalid" >&2
        exit 65
      }
  if [ "$ATTEST_ACTION" != attest-abort ]; then
    "$NODE_BIN" "$ATTEST_PRODUCER" --assert-ready --release-sha "$ATTEST_RELEASE_SHA" >/dev/null || {
      echo "attestation requires the canonical ready journal and exact fixed-input bundle" >&2
      exit 65
    }
  fi
  if [ "$ATTEST_ACTION" != attest-abort ]; then
    [ -f "$ATTEST_BUNDLE" ] && [ ! -L "$ATTEST_BUNDLE" ] || { echo "postdeploy bundle is missing or is a symlink" >&2; exit 65; }
    ATTEST_BUNDLE="$(readlink -f "$ATTEST_BUNDLE")"
  fi
  if [ "$ATTEST_ACTION" != attest-abort ]; then
  python3 - "$ATTEST_BUNDLE" <<'PY' || { echo "postdeploy bundle ancestor trust is invalid" >&2; exit 65; }
import os
import stat
import sys

cursor = os.path.dirname(os.path.abspath(sys.argv[1]))
while True:
    metadata = os.lstat(cursor)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) & 0o022
    ):
        raise SystemExit(65)
    parent = os.path.dirname(cursor)
    if parent == cursor:
        break
    cursor = parent
PY
  fi
  if [ "$ATTEST_ACTION" != attest-abort ]; then
  [ "$(stat -c '%U:%G' "$ATTEST_BUNDLE")" = root:root ] || { echo "postdeploy bundle ownership is invalid" >&2; exit 65; }
  case "$(stat -c '%a' "$ATTEST_BUNDLE")" in 400|600) ;; *) echo "postdeploy bundle mode must be 0400 or 0600" >&2; exit 65 ;; esac
  ATTEST_ARTIFACT_ROOT="$(dirname "$ATTEST_BUNDLE")"
  [ ! -L "$ATTEST_ARTIFACT_ROOT" ] && [ "$(stat -c '%U:%G' "$ATTEST_ARTIFACT_ROOT")" = root:root ] || {
    echo "postdeploy artifact root ownership is invalid" >&2
    exit 65
  }
  case "$(stat -c '%a' "$ATTEST_ARTIFACT_ROOT")" in 700) ;; *) echo "postdeploy artifact root mode must be 0700" >&2; exit 65 ;; esac
  fi
  mapfile -t ATTEST_EVIDENCE_FILES < <(find "$ATTEST_TARGET/.audit" -maxdepth 1 -type f -name 'deploy-*.json' -print)
  [ "${#ATTEST_EVIDENCE_FILES[@]}" -eq 1 ] || { echo "current release must contain exactly one deployment evidence file" >&2; exit 65; }
  ATTEST_EVIDENCE_FILE=${ATTEST_EVIDENCE_FILES[0]}
  IFS=$'\t' read -r ATTEST_BUILD_ID ATTEST_RUN_ID ATTEST_DEPLOYED_AT ATTEST_EVIDENCE_STATUS < <(python3 - "$ATTEST_EVIDENCE_FILE" "$ATTEST_RELEASE_SHA" <<'PY'
import json
import re
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    evidence = json.load(handle)
if evidence.get("git_sha") != sys.argv[2] or evidence.get("release_status") not in {"awaiting_uat", "acceptance_verified"}:
    raise SystemExit(65)
build = evidence.get("build_id", "")
run = str(evidence.get("ci", {}).get("run_id", ""))
created = evidence.get("created_at", "")
if not re.fullmatch(r"[^\s]{1,128}", build) or not re.fullmatch(r"[1-9][0-9]*", run) or not re.fullmatch(r"[0-9T:\-]+Z", created):
    raise SystemExit(65)
print(build, run, created, evidence.get("release_status"), sep="\t")
PY
  ) || exit 65
  ATTEST_VERIFIER="$ATTEST_TARGET/scripts/verify-postdeploy-acceptance.mjs"
  ATTEST_RECORDER="$ATTEST_TARGET/scripts/record-deploy-acceptance.mjs"
  ATTEST_POLICY="$ATTEST_TARGET/infra/release/postdeploy-acceptance-policy-v1.json"
  ATTEST_SCHEMA="$ATTEST_TARGET/infra/release/postdeploy-evidence-v1.schema.json"
  for required_file in "$ATTEST_VERIFIER" "$ATTEST_RECORDER" "$ATTEST_POLICY" "$ATTEST_SCHEMA"; do
    [ -f "$required_file" ] && [ ! -L "$required_file" ] || { echo "release lacks a required postdeploy acceptance file" >&2; exit 65; }
  done
  require_immutable_release_asset "$ATTEST_RELEASE_SHA" \
    scripts/verify-postdeploy-acceptance.mjs "$ATTEST_VERIFIER" 440 &&
    require_immutable_release_asset "$ATTEST_RELEASE_SHA" \
      scripts/record-deploy-acceptance.mjs "$ATTEST_RECORDER" 440 &&
    require_immutable_release_asset "$ATTEST_RELEASE_SHA" \
      infra/release/postdeploy-acceptance-policy-v1.json "$ATTEST_POLICY" 440 &&
    require_immutable_release_asset "$ATTEST_RELEASE_SHA" \
      infra/release/postdeploy-evidence-v1.schema.json "$ATTEST_SCHEMA" 440 || {
        echo "postdeploy acceptance code, policy, or schema ownership/mode/exact-SHA bytes are invalid" >&2
        exit 65
      }
  ATTEST_SEAL_DIR="$ATTEST_TARGET/.audit/postdeploy-acceptance-v1"
  if [ "$ATTEST_ACTION" = attest-abort ]; then
    [ "$ATTEST_EVIDENCE_STATUS" = awaiting_uat ] || {
      echo "a seal transaction can only be aborted before acceptance is verified" >&2
      exit 65
    }
    "$NODE_BIN" "$ATTEST_VERIFIER" \
      --abort-seal-dir "$ATTEST_SEAL_DIR" \
      --require-root-owned >/dev/null || {
      echo "postdeploy acceptance seal abort was refused" >&2
      exit 65
    }
    sync -f "$ATTEST_TARGET/.audit"
    echo "attestation seal transaction aborted release=$ATTEST_RELEASE_SHA"
    exit 0
  fi
  ATTEST_RECOVERY_ARGS=()
  if [ "$ATTEST_ACTION" = attest-recover ]; then
    ATTEST_RECOVERY_ARGS=(--recover-seal)
  fi
  "$NODE_BIN" "$ATTEST_VERIFIER" \
    --bundle "$ATTEST_BUNDLE" \
    --policy "$ATTEST_POLICY" \
    --schema "$ATTEST_SCHEMA" \
    --receipt-public-key "$POSTDEPLOY_RECEIPT_PUBLIC_KEY" \
    --artifact-root "$ATTEST_ARTIFACT_ROOT" \
    --expected-release-sha "$ATTEST_RELEASE_SHA" \
    --expected-build-id "$ATTEST_BUILD_ID" \
    --expected-deploy-run-id "$ATTEST_RUN_ID" \
    --expected-deployed-at "$ATTEST_DEPLOYED_AT" \
    --seal-dir "$ATTEST_SEAL_DIR" \
    "${ATTEST_RECOVERY_ARGS[@]}" \
    --require-root-owned >/dev/null || { echo "postdeploy acceptance evidence was refused" >&2; exit 65; }
  ATTEST_RESULT="$("$NODE_BIN" "$ATTEST_RECORDER" \
    --evidence "$ATTEST_EVIDENCE_FILE" \
    --attestation "$ATTEST_SEAL_DIR/attestation.json" \
    --bundle "$ATTEST_SEAL_DIR/bundle.json")" || exit 65
  sync -f "$ATTEST_EVIDENCE_FILE"
  sync -f "$ATTEST_SEAL_DIR"
  echo "attested release=$ATTEST_RELEASE_SHA $ATTEST_RESULT status=acceptance_verified"
  exit 0
  ;;
esac

if [ "${1:-}" = "finalize" ]; then
  [ "$#" -eq 5 ] || {
    echo "usage: newme-deploy finalize <release-sha> <acceptance-sha256> <closure-sha> <successful-final-run-id>" >&2
    exit 64
  }
  FINALIZE_RELEASE_SHA=${2:-}
  FINALIZE_ACCEPTANCE_DIGEST=${3:-}
  FINALIZE_CLOSURE_SHA=${4:-}
  FINALIZE_RUN_ID=${5:-}
  if ! [[ "$FINALIZE_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$FINALIZE_ACCEPTANCE_DIGEST" =~ ^[0-9a-f]{64}$ ]] ||
    ! [[ "$FINALIZE_CLOSURE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$FINALIZE_RUN_ID" =~ ^[1-9][0-9]*$ ]]; then
    echo "finalize arguments are invalid" >&2
    exit 64
  fi
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || { echo "persistent deploy-state directory is invalid" >&2; exit 65; }
  [ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] && [ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || {
    echo "persistent deploy-state directory permissions are invalid" >&2
    exit 65
  }
  if [ -e "$PENDING_ASSET_RECORD" ] || [ -L "$PENDING_ASSET_RECORD" ] ||
    [ -e "$CREDENTIAL_ASSET_PENDING" ] || [ -L "$CREDENTIAL_ASSET_PENDING" ] ||
    [ -e "$CREDENTIAL_GATE_CONSUMED" ] || [ -L "$CREDENTIAL_GATE_CONSUMED" ] ||
    [ -e "$CREDENTIAL_TRANSITION_PENDING" ] || [ -L "$CREDENTIAL_TRANSITION_PENDING" ] ||
    [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; then
    echo "unresolved deployment or rollback state must be recovered before finalization" >&2
    exit 75
  fi
  FINALIZE_TARGET="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  [ "$FINALIZE_TARGET" = "/opt/newme/releases/$FINALIZE_RELEASE_SHA" ] || {
    echo "finalize SHA must equal the current immutable release" >&2
    exit 65
  }
  FINALIZE_ROLLBACK_TARGET="$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)"
  case "$FINALIZE_ROLLBACK_TARGET" in /opt/newme/releases/*) ;; *) exit 65 ;; esac
  [[ "$(basename "$FINALIZE_ROLLBACK_TARGET")" =~ ^[0-9a-f]{40}$ ]] || exit 65
  [ -d "$FINALIZE_ROLLBACK_TARGET" ] && [ ! -L "$FINALIZE_ROLLBACK_TARGET" ] &&
    [ -f "$FINALIZE_ROLLBACK_TARGET/.newme-protect" ] &&
    [ -f "$FINALIZE_ROLLBACK_TARGET/.next/BUILD_ID" ] || exit 65
  mapfile -t EVIDENCE_FILES < <(find "$FINALIZE_TARGET/.audit" -maxdepth 1 -type f -name 'deploy-*.json' -print)
  [ "${#EVIDENCE_FILES[@]}" -eq 1 ] || { echo "current release must contain exactly one deployment evidence file" >&2; exit 65; }
  EVIDENCE_FILE=${EVIDENCE_FILES[0]}
  python3 - "$EVIDENCE_FILE" "$FINALIZE_RELEASE_SHA" "$FINALIZE_ACCEPTANCE_DIGEST" "$FINALIZE_ROLLBACK_TARGET" <<'PY'
import json
import os
import re
import stat
import sys
path, expected_sha, expected_digest, rollback_target = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    evidence = json.load(handle)
release_status = evidence.get("release_status")
acceptance = evidence.get("acceptance", {})
if (
    evidence.get("git_sha") != expected_sha
    or release_status not in {"acceptance_verified", "complete"}
    or acceptance.get("status") != "verified"
    or acceptance.get("bundle_sha256") != expected_digest
):
    raise SystemExit(65)
rollback = evidence.get("rollback", {})
asset_backup = rollback.get("asset_backup", "")
previous_rollback = rollback.get("previous_rollback", {})
if (
    evidence.get("candidate_preexisting") is not False
    or rollback.get("git_sha") != rollback_target.rsplit("/", 1)[-1]
    or rollback.get("backup_dir") != rollback_target
    or not re.fullmatch(r"/var/backups/newme-systemd-assets/[^\s]+", asset_backup)
    or os.path.realpath(asset_backup) != asset_backup
    or not os.path.isdir(asset_backup)
    or os.path.islink(asset_backup)
    or not isinstance(previous_rollback, dict)
):
    raise SystemExit(65)
previous_rollback_sha = previous_rollback.get("git_sha", "")
previous_rollback_dir = previous_rollback.get("backup_dir", "")
if previous_rollback_dir:
    if (
        not re.fullmatch(r"/opt/newme/releases/[0-9a-f]{40}", previous_rollback_dir)
        or previous_rollback_sha != previous_rollback_dir.rsplit("/", 1)[-1]
    ):
        raise SystemExit(65)
    if release_status != "complete" and (
        os.path.realpath(previous_rollback_dir) != previous_rollback_dir
        or not os.path.isdir(previous_rollback_dir)
        or os.path.islink(previous_rollback_dir)
        or not os.path.isfile(os.path.join(previous_rollback_dir, ".newme-protect"))
        or not os.path.isfile(os.path.join(previous_rollback_dir, ".next", "BUILD_ID"))
    ):
        raise SystemExit(65)
elif previous_rollback_sha:
    raise SystemExit(65)
metadata = os.stat(asset_backup)
if metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != 0o700:
    raise SystemExit(65)
if not os.path.isdir(os.path.join(asset_backup, "rootfs")):
    raise SystemExit(65)
for required in ("managed.list", "present.list", "manifest.sha256", "symlink.sha256"):
    required_path = os.path.join(asset_backup, required)
    if not os.path.isfile(required_path) or os.path.islink(required_path):
        raise SystemExit(65)
PY
  require_node || exit 65
  verify_release_closure_and_final_ci || {
    echo "release closure, acceptance digest, or final GitHub Actions evidence is not verified" >&2
    exit 65
  }
  validate_migration_db_url_file || exit 65
  FINALIZE_PHASE_GATE="$FINALIZE_TARGET/scripts/check-release-phase.mjs"
  [ -f "$FINALIZE_PHASE_GATE" ] && [ ! -L "$FINALIZE_PHASE_GATE" ] || {
    echo "the current release carries no scripts/check-release-phase.mjs; completion cannot be gated on the database phase" >&2
    exit 70
  }
  require_immutable_release_asset "$FINALIZE_RELEASE_SHA" \
    scripts/check-release-phase.mjs "$FINALIZE_PHASE_GATE" 440 &&
    require_immutable_release_asset "$FINALIZE_RELEASE_SHA" \
      scripts/finalize-deploy-evidence.sh "$FINALIZE_TARGET/scripts/finalize-deploy-evidence.sh" 440 || {
        echo "release finalizer code ownership, mode, or exact-SHA bytes are invalid" >&2
        exit 65
      }
  "$NODE_BIN" "$FINALIZE_PHASE_GATE" --for-completion \
    --url-file "$MIGRATION_DB_URL_FILE" \
    --modules-dir "$FINALIZE_TARGET/node_modules" >/dev/null || {
    echo "the database phase does not allow this release to be completed" >&2
      exit 70
  }
  verify_release_closure_and_final_ci || {
    echo "release closure or final CI expired/changed before final release evidence could be written" >&2
    exit 65
  }
  bash "$FINALIZE_TARGET/scripts/finalize-deploy-evidence.sh" \
    "$EVIDENCE_FILE" "$FINALIZE_ACCEPTANCE_DIGEST" "$FINALIZE_CLOSURE_SHA" "$FINALIZE_RUN_ID"
  sync -f "$EVIDENCE_FILE"
  sync -f "$FINALIZE_TARGET/.audit"
  echo "finalized release=$FINALIZE_RELEASE_SHA acceptance=$FINALIZE_ACCEPTANCE_DIGEST closure=$FINALIZE_CLOSURE_SHA final_run=$FINALIZE_RUN_ID evidence=$EVIDENCE_FILE status=complete"
  exit 0
fi

BOOTSTRAP_ONLY=0
DB_TRANSITION_ONLY=0
DB_TRANSITION_OPERATION=""
case "${1:-}" in
  bootstrap)
    BOOTSTRAP_ONLY=1
    shift
    ;;
  db-transition)
    DB_TRANSITION_ONLY=1
    shift
    ;;
esac

SHA=${1:-}
RUN_ID=${2:-}
MIGRATION_STATUS=""
MIGRATION_IDS=""
ROLLBACK_SHA=""
if [ "$DB_TRANSITION_ONLY" -eq 1 ]; then
  DB_TRANSITION_OPERATION=${3:-}
  if [ "$#" -ne 3 ] || ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: newme-deploy db-transition <main-sha> <successful-run-id> <expand-plan|expand-apply|contract-apply|contract-verify|contract-rollback|contract-reenter>" >&2
    exit 64
  fi
  case "$DB_TRANSITION_OPERATION" in
    expand-plan|expand-apply|contract-apply|contract-verify|contract-rollback|contract-reenter) ;;
    *) exit 64 ;;
  esac
else
  MIGRATION_STATUS=${3:-}
  MIGRATION_IDS=${4:-}
  ROLLBACK_SHA=${5:-}
  if [ "$#" -ne 5 ] || ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || ! [[ "$ROLLBACK_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: newme-deploy <main-sha> <successful-run-id> <not_required|applied_verified> <migration-ids> <rollback-sha>" >&2
    echo "   or: newme-deploy bootstrap <main-sha> <successful-run-id> <not_required|applied_verified> <migration-ids> <rollback-sha>" >&2
    exit 64
  fi
  case "$MIGRATION_STATUS" in
    not_required) [ -z "$MIGRATION_IDS" ] || exit 64 ;;
    applied_verified) [[ "$MIGRATION_IDS" =~ ^[0-9A-Za-z_.-]+(,[0-9A-Za-z_.-]+)*$ ]] || exit 64 ;;
    *) exit 64 ;;
  esac
fi
if [ "$RUN_ID" = "manual" ]; then
  echo "manual production deployment is disabled; an exact successful GitHub Actions run is required" >&2
  exit 65
fi
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || exit 64

readonly ORIGIN_HTTPS="https://github.com/69755354/newme-platform.git"
readonly ORIGIN_SSH="git@github.com:69755354/newme-platform.git"
readonly MIRROR="/opt/newme/repository.git"
readonly WORKTREE_ROOT="/var/lib/newme/deploy-worktrees"
readonly LEGACY_EVIDENCELESS_BASELINE="945d1b5e0615c963c19e116483fcc8c4253d03ea"
ASSET_BACKUP_RECORD=""
ASSET_BACKUP=""
GATE_RECORD=""
CI_GATE_AUDIT_RECORD=""
DEPLOY_STATE_RECORD=""
DEPLOY_STATE=""
DEPLOY_SUCCEEDED=0
RESTART_AFTER_ASSET_ROLLBACK=0
PRESERVE_DEPLOY_STATE_RECORD=0
PRESERVE_ASSET_BACKUP_RECORD=0
PENDING_PREVIOUS=""
PENDING_PREVIOUS_ROLLBACK=""
[ -d "$MIRROR" ] || { echo "root-owned release mirror is missing" >&2; exit 65; }
[ "$(stat -c '%U:%G' "$MIRROR")" = "root:root" ] || { echo "release mirror ownership is invalid" >&2; exit 65; }
case "$(git --git-dir="$MIRROR" remote get-url origin)" in
  "$ORIGIN_HTTPS"|"$ORIGIN_SSH") ;;
  *) echo "release mirror origin is invalid" >&2; exit 65 ;;
esac

git --git-dir="$MIRROR" fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main'
MAIN_SHA="$(git --git-dir="$MIRROR" rev-parse refs/remotes/origin/main)"
[ "$SHA" = "$MAIN_SHA" ] || { echo "release SHA must equal canonical main" >&2; exit 65; }
LIVE_RELEASE="$(readlink -f /opt/newme/current 2>/dev/null || true)"
if [ -e "$CREDENTIAL_ASSET_PENDING" ] || [ -L "$CREDENTIAL_ASSET_PENDING" ] ||
  [ -e "$CREDENTIAL_GATE_CONSUMED" ] || [ -L "$CREDENTIAL_GATE_CONSUMED" ] ||
  [ -e "$CREDENTIAL_TRANSITION_PENDING" ] || [ -L "$CREDENTIAL_TRANSITION_PENDING" ]; then
  echo "credential remediation recovery is required before an ordinary release operation" >&2
  exit 75
fi
require_postdeploy_operations_clear "$LIVE_RELEASE" || exit $?
if [ "$DB_TRANSITION_ONLY" -eq 1 ]; then
  case "$LIVE_RELEASE" in /opt/newme/releases/[0-9a-f][0-9a-f]*) ;; *) echo "current immutable production release is invalid" >&2; exit 65 ;; esac
  ROLLBACK_SHA="$(basename "$LIVE_RELEASE")"
  [[ "$ROLLBACK_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "current immutable production release SHA is invalid" >&2; exit 65; }
else
  [ "$LIVE_RELEASE" = "/opt/newme/releases/$ROLLBACK_SHA" ] || {
    echo "rollback SHA must equal the current immutable production release" >&2
    exit 65
  }
fi
if [ "$ROLLBACK_SHA" != "$LEGACY_EVIDENCELESS_BASELINE" ]; then
  [ -d "$LIVE_RELEASE/.audit" ] && [ ! -L "$LIVE_RELEASE/.audit" ] || {
    echo "current release lacks protected deployment evidence" >&2
    exit 65
  }
  mapfile -t CURRENT_EVIDENCE_FILES < <(find "$LIVE_RELEASE/.audit" -maxdepth 1 -type f -name 'deploy-*.json' -print)
  [ "${#CURRENT_EVIDENCE_FILES[@]}" -eq 1 ] || {
    echo "current release must have exactly one finalized deployment evidence file before another deployment" >&2
    exit 65
  }
  python3 - "${CURRENT_EVIDENCE_FILES[0]}" "$ROLLBACK_SHA" <<'PY'
import json
import sys

path, expected_sha = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    evidence = json.load(handle)
if evidence.get("git_sha") != expected_sha or evidence.get("release_status") != "complete":
    raise SystemExit(65)
PY
fi

service_control_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/systemd/newme-service-control.sh" 2>/dev/null || true)
rollback_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/systemd/newme-production-rollback.sh" 2>/dev/null || true)
sudoers_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/sudoers/newme-platform" 2>/dev/null || true)
immutable_deploy_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:scripts/deploy-immutable.sh" 2>/dev/null || true)
[[ "$service_control_source" == *"only newme-platform.service can be controlled"* ]] || {
  echo "main lacks the production service-control unit-token guard" >&2
  exit 65
}
[[ "$rollback_source" == *"/opt/newme/current.rollback"* ]] || {
  echo "main lacks the protected production rollback controller" >&2
  exit 65
}
[[ "$sudoers_source" == *"/usr/local/sbin/newme-production-rollback"* ]] || {
  echo "main lacks the restricted production rollback sudo policy" >&2
  exit 65
}
[[ "$immutable_deploy_source" == *'ROLLBACK="${NEWME_ROLLBACK_LINK:-/opt/newme/current.rollback}"'* ]] &&
  [[ "$immutable_deploy_source" == *"protected_release=true"* ]] || {
  echo "main lacks rollback-preserving immutable deployment" >&2
  exit 65
}

readonly GITHUB_API_TOKEN_FILE=/etc/newme/github-actions-read.token
[ -f "$GITHUB_API_TOKEN_FILE" ] && [ ! -L "$GITHUB_API_TOKEN_FILE" ] || {
  echo "root-owned GitHub Actions read token is missing" >&2
  exit 65
}
[ "$(stat -c '%U:%G' "$GITHUB_API_TOKEN_FILE")" = root:root ] || {
  echo "GitHub Actions read token ownership is invalid" >&2
  exit 65
}
case "$(stat -c '%a' "$GITHUB_API_TOKEN_FILE")" in
  400|600) ;;
  *) echo "GitHub Actions read token mode must be 0400 or 0600" >&2; exit 65 ;;
esac
IFS= read -r github_token < "$GITHUB_API_TOKEN_FILE" || true
[[ "$github_token" =~ ^[A-Za-z0-9_]{20,512}$ ]] || {
  echo "GitHub Actions read token format is invalid" >&2
  exit 65
}
GITHUB_CURL_CONFIG="$(mktemp /run/newme-github-api.XXXXXX)"
cleanup_github_config() {
  rm -f -- "$GITHUB_CURL_CONFIG"
}
trap cleanup_github_config EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0600 "$GITHUB_CURL_CONFIG"
printf 'header = "Authorization: Bearer %s"\n' "$github_token" > "$GITHUB_CURL_CONFIG"
unset github_token
RUN_JSON="$(curl --fail --silent --show-error --max-time 15 \
  --config "$GITHUB_CURL_CONFIG" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/69755354/newme-platform/actions/runs/$RUN_ID")"
# The run object says nothing about which jobs ran. A run is green when nothing
# that ran failed, and a job skipped by its `if:` condition does not make it
# anything else — so the required set has to be read off the jobs endpoint.
JOBS_JSON="$(curl --fail --silent --show-error --max-time 20 \
  --config "$GITHUB_CURL_CONFIG" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/69755354/newme-platform/actions/runs/$RUN_ID/jobs?per_page=100&filter=latest")"
WORKFLOW_JSON="$(curl --fail --silent --show-error --max-time 15 \
  --config "$GITHUB_CURL_CONFIG" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/69755354/newme-platform/actions/workflows/$CANONICAL_CI_WORKFLOW_ID")"
cleanup_github_config
trap - EXIT HUP INT TERM

# The required set travels with the release: read from the root-owned mirror at
# the canonical main SHA, never from a host-local copy.
REQUIRED_JOBS_JSON="$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/release/required-jobs.json" 2>/dev/null || true)"
[ -n "$REQUIRED_JOBS_JSON" ] || {
  echo "main does not carry infra/release/required-jobs.json" >&2
  exit 65
}

CI_GATE_AUDIT_RESULT="$(python3 -c '
import base64, hashlib, json, re, sys
from datetime import datetime, timezone
expected_sha, expected_run, run_payload, jobs_payload, workflow_payload, required_payload = sys.argv[1:]


def refuse(reason):
    sys.stderr.write("release evidence refused: %s\n" % reason)
    raise SystemExit(65)


try:
    run = json.loads(run_payload)
    jobs_response = json.loads(jobs_payload)
    workflow = json.loads(workflow_payload)
    manifest = json.loads(required_payload)
except ValueError as exc:
    refuse("a GitHub API or manifest payload was not JSON (%s)" % exc)

required = manifest.get("required_jobs")
tolerated = manifest.get("tolerated_conclusions")
if not isinstance(required, list) or not required:
    refuse("the required-jobs manifest lists no jobs")
if tolerated != ["success"]:
    refuse("the required-jobs manifest tolerates conclusions other than success")
if manifest.get("workflow_path") != ".github/workflows/ci.yml":
    refuse("the required-jobs manifest does not pin the canonical workflow path")
if manifest.get("workflow_id") != 310914082:
    refuse("the required-jobs manifest does not pin workflow_id 310914082")
max_run_age = manifest.get("max_run_age_seconds")
if not isinstance(max_run_age, int) or isinstance(max_run_age, bool) or not 1 <= max_run_age <= 86400:
    refuse("the required-jobs manifest freshness SLO must be between 1 and 86400 seconds")
required_names = []
for entry in required:
    name = entry.get("name") if isinstance(entry, dict) else None
    if not isinstance(name, str) or not name:
        refuse("the required-jobs manifest has an entry without a job name")
    required_names.append(name)
if len(set(required_names)) != len(required_names):
    refuse("the required-jobs manifest lists a job twice")

if not isinstance(workflow, dict):
    refuse("the canonical workflow endpoint did not return an object")
if workflow.get("id") != manifest.get("workflow_id"):
    refuse("the canonical workflow endpoint returned a different workflow_id")
if workflow.get("path") != manifest.get("workflow_path"):
    refuse("the canonical workflow endpoint returned a different path")
if workflow.get("name") != manifest.get("workflow"):
    refuse("the canonical workflow endpoint returned a different name")
if workflow.get("state") != "active":
    refuse("the canonical workflow endpoint is not active")

timestamp_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$")
def timestamp(value, label):
    if not isinstance(value, str) or timestamp_pattern.fullmatch(value) is None:
        refuse("%s is not a valid UTC timestamp" % label)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        refuse("%s is not a valid UTC timestamp" % label)

now = datetime.now(timezone.utc)

# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------
# The release candidate is measured on a manual main dispatch so the required
# predeploy job set is explicit. Release-final is a later, separate dispatch:
# postdeploy rows cannot be made a precondition of the deployment that produces
# their evidence.
if str(run.get("id")) != expected_run:
    refuse("the run is not the one named in the claim")
if run.get("head_sha") != expected_sha:
    refuse("the run head_sha is not the release SHA")
if run.get("name") != manifest.get("workflow"):
    refuse("a different workflow is a different gate set")
if run.get("path") != manifest.get("workflow_path"):
    refuse("the run came from a different workflow path")
if run.get("workflow_id") != manifest.get("workflow_id"):
    refuse("the run came from a different workflow_id")
if run.get("status") != "completed":
    refuse("the run has not completed")
if run.get("conclusion") != "success":
    refuse("the run did not conclude success")
if run.get("event") != manifest.get("event"):
    refuse("the run event %r is not %r" % (run.get("event"), manifest.get("event")))
if run.get("head_branch") != manifest.get("head_branch"):
    refuse("the run is not from %r" % manifest.get("head_branch"))
created_at = timestamp(run.get("created_at"), "run.created_at")
run_started_at = timestamp(run.get("run_started_at"), "run.run_started_at")
updated_at = timestamp(run.get("updated_at"), "run.updated_at")
if not created_at <= run_started_at <= updated_at:
    refuse("run timestamps are not ordered created_at <= run_started_at <= updated_at")
if updated_at > now or (now - updated_at).total_seconds() > max_run_age:
    refuse("the run completion is outside the manifest freshness SLO")

# ---------------------------------------------------------------------------
# The jobs
# ---------------------------------------------------------------------------
jobs = jobs_response.get("jobs")
total = jobs_response.get("total_count")
if not isinstance(jobs, list) or not jobs:
    refuse("the run reported no jobs")
if total != len(jobs):
    # Fail closed rather than silently gating on the first page: a run large
    # enough to paginate would otherwise be judged on a subset of its jobs.
    refuse("the job list is paginated (%s of %s returned); this gate reads one page" % (len(jobs), total))

seen = {}
completed_jobs = {}
for job in jobs:
    name = job.get("name")
    if not isinstance(name, str):
        refuse("a job in the run has no name")
    if job.get("head_sha") not in (None, expected_sha):
        refuse("job %r ran against a different commit" % name)
    conclusion = job.get("conclusion")
    if name in required_names:
        if name in seen:
            refuse("required job %r appears twice in the job list" % name)
        if job.get("status") != "completed":
            refuse("required job %r has not completed" % name)
        if conclusion not in tolerated:
            refuse("required job %r concluded %r" % (name, conclusion))
        started_at = timestamp(job.get("started_at"), "required job %r started_at" % name)
        completed_at = timestamp(job.get("completed_at"), "required job %r completed_at" % name)
        if started_at > completed_at or completed_at > updated_at:
            refuse("required job %r has unordered timestamps" % name)
        if completed_at > now or (now - completed_at).total_seconds() > max_run_age:
            refuse("required job %r completion is outside the manifest freshness SLO" % name)
        seen[name] = conclusion
        completed_jobs[name] = job.get("completed_at")
    elif conclusion not in ("success", "skipped", None):
        # A non-required job that failed still means this commit is not green.
        refuse("job %r concluded %r" % (name, conclusion))

missing = [name for name in required_names if name not in seen]
if missing:
    refuse("required job(s) absent from the run: %s" % ", ".join(missing))

audit = {
    "version": "newme-ci-gate-audit/v1",
    "release_sha": expected_sha,
    "run_id": expected_run,
    "workflow_id": manifest.get("workflow_id"),
    "workflow_path": manifest.get("workflow_path"),
    "workflow_name": manifest.get("workflow"),
    "workflow_state": workflow.get("state"),
    "event": run.get("event"),
    "head_branch": run.get("head_branch"),
    "run_status": run.get("status"),
    "run_conclusion": run.get("conclusion"),
    "max_run_age_seconds": max_run_age,
    "run_created_at": run.get("created_at"),
    "run_started_at": run.get("run_started_at"),
    "run_completed_at": run.get("updated_at"),
    "required_job_completed_at": {name: completed_jobs[name] for name in sorted(completed_jobs)},
    "manifest_sha256": hashlib.sha256(json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
}
audited_at = now.isoformat(timespec="seconds").replace("+00:00", "Z")
audit["validated_at"] = audited_at
audit_bytes = (json.dumps(audit, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
audit_sha256 = hashlib.sha256(audit_bytes).hexdigest()
print(audit_sha256, audited_at, run.get("updated_at"), manifest.get("workflow_id"), manifest.get("workflow_path"), max_run_age, base64.b64encode(audit_bytes).decode("ascii"), sep="\t")
' "$SHA" "$RUN_ID" "$RUN_JSON" "$JOBS_JSON" "$WORKFLOW_JSON" "$REQUIRED_JOBS_JSON")" || {
  echo "GitHub Actions evidence is not a main release-candidate dispatch of ci with every predeploy job green" >&2
  exit 65
}
IFS=$'\t' read -r CI_GATE_AUDIT_SHA256 CI_GATE_AUDITED_AT CI_RUN_COMPLETED_AT CI_WORKFLOW_ID CI_WORKFLOW_PATH CI_MAX_RUN_AGE_SECONDS CI_GATE_AUDIT_BASE64 <<< "$CI_GATE_AUDIT_RESULT"
unset CI_GATE_AUDIT_RESULT
[[ "$CI_GATE_AUDIT_SHA256" =~ ^[0-9a-f]{64}$ ]] &&
  [[ "$CI_GATE_AUDITED_AT" =~ ^[0-9T:\.-]+Z$ ]] &&
  [[ "$CI_RUN_COMPLETED_AT" =~ ^[0-9T:\.-]+Z$ ]] &&
  [ "$CI_WORKFLOW_ID" = "$CANONICAL_CI_WORKFLOW_ID" ] &&
  [ "$CI_WORKFLOW_PATH" = .github/workflows/ci.yml ] &&
  [[ "$CI_MAX_RUN_AGE_SECONDS" =~ ^[0-9]+$ ]] && [ "$CI_MAX_RUN_AGE_SECONDS" -ge 1 ] && [ "$CI_MAX_RUN_AGE_SECONDS" -le 86400 ] &&
  [[ "$CI_GATE_AUDIT_BASE64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || {
    echo "GitHub Actions gate audit summary is malformed" >&2
    exit 65
  }
CI_RUN_URL="https://github.com/69755354/newme-platform/actions/runs/$RUN_ID"
CI_CONCLUSION=success
# Recorded and re-validated downstream by deploy-immutable.sh, which cannot see
# the API response.
CI_EVENT=workflow_dispatch

# Gates shared by application deployment and every production database transition.
# The worktree is always a root-owned detached checkout of canonical main at the
# exact SHA whose successful run was verified above. Keeping these checks in one
# function prevents the database-only path from becoming a weaker shadow deploy.
verify_exact_tree_release_gates() {
  require_node || return 65
  "$NODE_BIN" "$WORKTREE/scripts/check-taskboard.mjs" --require-scope=predeploy_ready || {
    echo "TASKBOARD.md at canonical main is not predeploy-ready; production operation is blocked" >&2
    return 65
  }
  (cd "$WORKTREE" && "$NODE_BIN" scripts/check-release-manifest.mjs) || {
    echo "the release manifest does not describe the exact canonical-main tree" >&2
    return 65
  }
  (cd "$WORKTREE" && "$NODE_BIN" scripts/check-release-manifest.mjs --verify-companions) || {
    echo "the hand-run rollback/recontract companions do not match the release manifest at this SHA" >&2
    return 65
  }
}

mkdir -p -m 0700 "$WORKTREE_ROOT"

if [ "$DB_TRANSITION_ONLY" -eq 1 ]; then
  WORKTREE="$(mktemp -d "$WORKTREE_ROOT/db-transition.XXXXXX")"
  cleanup_db_transition_worktree() {
    trap - EXIT HUP INT TERM
    git --git-dir="$MIRROR" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  }
  trap cleanup_db_transition_worktree EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  rmdir "$WORKTREE"
  git --git-dir="$MIRROR" worktree add --detach "$WORKTREE" "$MAIN_SHA" >/dev/null
  chown -R root:root "$WORKTREE"

  verify_exact_tree_release_gates || exit 65
  validate_migration_db_url_file || exit 65
  require_canonical_main_sha "$SHA" || {
    echo "canonical main changed before the database transition" >&2
    exit 65
  }
  require_ci_gate_still_fresh || {
    echo "GitHub Actions evidence expired before the database transition" >&2
    exit 65
  }
  case "$DB_TRANSITION_OPERATION" in
    expand-plan)
      "$NODE_BIN" "$WORKTREE/scripts/db-phase-push.mjs" \
        --phase required_for_app --plan \
        --url-file "$MIGRATION_DB_URL_FILE" \
        --modules-dir "$LIVE_RELEASE/node_modules"
      ;;
    expand-apply)
      "$NODE_BIN" "$WORKTREE/scripts/db-phase-push.mjs" \
        --phase required_for_app --apply \
        --url-file "$MIGRATION_DB_URL_FILE" \
        --modules-dir "$LIVE_RELEASE/node_modules"
      ;;
    contract-apply)
      "$NODE_BIN" "$WORKTREE/scripts/db-phase-push.mjs" \
        --phase deferred_contract --apply \
        --url-file "$MIGRATION_DB_URL_FILE" \
        --modules-dir "$LIVE_RELEASE/node_modules"
      ;;
    contract-verify)
      "$NODE_BIN" "$WORKTREE/scripts/db-phase-push.mjs" \
        --phase deferred_contract --verify-only \
        --url-file "$MIGRATION_DB_URL_FILE" \
        --modules-dir "$LIVE_RELEASE/node_modules"
      ;;
    contract-rollback|contract-reenter)
      "$NODE_BIN" "$WORKTREE/scripts/db-companion-run.mjs" \
        --operation "$DB_TRANSITION_OPERATION" \
        --url-file "$MIGRATION_DB_URL_FILE" \
        --modules-dir "$LIVE_RELEASE/node_modules"
      ;;
  esac
  echo "database transition complete release=$SHA run=$RUN_ID operation=$DB_TRANSITION_OPERATION"
  exit 0
fi

install -d -o root -g root -m 0700 "$STATE_ROOT"
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || { echo "persistent deploy-state directory is invalid" >&2; exit 65; }
[ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] || { echo "persistent deploy-state directory ownership is invalid" >&2; exit 65; }
[ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || { echo "persistent deploy-state directory mode is invalid" >&2; exit 65; }
if [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; then
  echo "an unresolved production rollback must be recovered before deployment" >&2
  exit 75
fi
WORKTREE="$(mktemp -d "$WORKTREE_ROOT/release.XXXXXX")"
load_asset_backup_from_record() {
  local candidate=""
  [ -n "$ASSET_BACKUP_RECORD" ] && [ -f "$ASSET_BACKUP_RECORD" ] && [ ! -L "$ASSET_BACKUP_RECORD" ] || return 1
  [ "$(stat -c '%U:%G' "$ASSET_BACKUP_RECORD")" = root:root ] || return 1
  [ "$(stat -c '%a' "$ASSET_BACKUP_RECORD")" = 600 ] || return 1
  IFS= read -r candidate < "$ASSET_BACKUP_RECORD" || return 1
  case "$candidate" in
    /var/backups/newme-systemd-assets/*) ;;
    *) return 1 ;;
  esac
  [ -d "$candidate/rootfs" ] && [ -f "$candidate/managed.list" ] || return 1
  ASSET_BACKUP="$candidate"
}
load_deploy_state() {
  local state=""
  [ -n "$DEPLOY_STATE_RECORD" ] && [ -f "$DEPLOY_STATE_RECORD" ] && [ ! -L "$DEPLOY_STATE_RECORD" ] || return 1
  [ "$(stat -c '%U:%G' "$DEPLOY_STATE_RECORD")" = root:root ] || return 1
  [ "$(stat -c '%a' "$DEPLOY_STATE_RECORD")" = 600 ] || return 1
  IFS= read -r state < "$DEPLOY_STATE_RECORD" || return 1
  case "$state" in
    prepared|switch_pending|switched|app_rollback_pending|app_rolled_back|assets_rolled_back|complete="$SHA") ;;
    *) return 1 ;;
  esac
  DEPLOY_STATE="$state"
}
load_matching_pending_asset_record() {
  local pending_sha="" pending_backup="" pending_lines=""
  [ -f "$PENDING_ASSET_RECORD" ] && [ ! -L "$PENDING_ASSET_RECORD" ] || return 1
  [ "$(stat -c '%U:%G' "$PENDING_ASSET_RECORD")" = root:root ] || return 1
  [ "$(stat -c '%a' "$PENDING_ASSET_RECORD")" = 600 ] || return 1
  pending_lines="$(wc -l < "$PENDING_ASSET_RECORD")"
  case "$pending_lines" in
    5) ;;
    8)
      [ "$(grep -Ec '^version=2$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
      [ "$(grep -Ec '^protected_before_candidate_sha=[0-9a-f]{40}$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
      [ "$(grep -Ec '^protected_before_marker_sha256=[0-9a-f]{64}$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
      ;;
    *) return 1 ;;
  esac
  [ "$(grep -Ec '^sha=[0-9a-f]{40}$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous=/opt/newme/releases/[0-9a-f]{40}$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous_rollback=(/opt/newme/releases/[0-9a-f]{40})?$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^candidate_preexisting=0$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  pending_sha="$(sed -n 's/^sha=//p' "$PENDING_ASSET_RECORD")"
  pending_backup="$(sed -n 's/^backup=//p' "$PENDING_ASSET_RECORD")"
  PENDING_PREVIOUS="$(sed -n 's/^previous=//p' "$PENDING_ASSET_RECORD")"
  PENDING_PREVIOUS_ROLLBACK="$(sed -n 's/^previous_rollback=//p' "$PENDING_ASSET_RECORD")"
  [ "$pending_sha" = "$SHA" ] &&
    [ "$pending_backup" = "$ASSET_BACKUP" ] &&
    [ "$PENDING_PREVIOUS" = "/opt/newme/releases/$ROLLBACK_SHA" ] || return 1
}
restore_pending_rollback_link() {
  local rollback_next="/opt/newme/current.rollback.recovery-$$"
  load_matching_pending_asset_record || return 1
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" = "$PENDING_PREVIOUS" ] || return 1
  rm -f -- "$rollback_next" || return 1
  if [ -n "$PENDING_PREVIOUS_ROLLBACK" ]; then
    ln -s "$PENDING_PREVIOUS_ROLLBACK" "$rollback_next" || return 1
    mv -Tf "$rollback_next" /opt/newme/current.rollback || return 1
  else
    rm -f -- /opt/newme/current.rollback || return 1
  fi
  sync -f /opt/newme || return 1
}
remove_interrupted_candidate_release() {
  local candidate="/opt/newme/releases/$SHA"
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
    sync -f /opt/newme/releases || return 1
    return 0
  fi
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" != "$candidate" ] || return 1
  [ "$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)" != "$candidate" ] || return 1
  rm -rf --one-file-system -- "$candidate" || return 1
  [ ! -e "$candidate" ] && [ ! -L "$candidate" ] || return 1
  sync -f /opt/newme/releases || return 1
}
clear_matching_pending_asset_record() {
  local disposition="${1:-recovery}"
  if [ ! -e "$PENDING_ASSET_RECORD" ] && [ ! -L "$PENDING_ASSET_RECORD" ]; then
    return 0
  fi
  load_matching_pending_asset_record || return 1
  case "$disposition" in
    complete) ;;
    recovery) remove_interrupted_candidate_release || return 1 ;;
    *) return 1 ;;
  esac
  rm -f -- "$PENDING_ASSET_RECORD"
}
# The gate record is evidence about one installer invocation, not a durable fact.
# It is removed as soon as the installer returns and on every exit path, so it can
# never be found later by an installer this wrapper did not gate.
remove_gate_record() {
  [ -n "$GATE_RECORD" ] || return 0
  case "$GATE_RECORD" in
    "$STATE_ROOT"/deploy-gates.*) rm -f -- "$GATE_RECORD" ;;
  esac
  GATE_RECORD=""
}
cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  remove_gate_record
  load_deploy_state || DEPLOY_STATE="unknown"
  if [ "$DEPLOY_STATE" = "complete=$SHA" ]; then
    DEPLOY_SUCCEEDED=1
    [ "$rc" -eq 0 ] || echo "canonical wrapper was interrupted after durable deployment completion; release retained" >&2
    if ! clear_matching_pending_asset_record complete; then
      echo "CRITICAL: completed deployment pending asset pointer could not be cleared" >&2
      PRESERVE_DEPLOY_STATE_RECORD=1
      PRESERVE_ASSET_BACKUP_RECORD=1
      rc=2
    fi
  fi
  if [ "$rc" -ne 0 ] && [ "$DEPLOY_SUCCEEDED" -eq 0 ]; then
    current_release="$(readlink -f /opt/newme/current 2>/dev/null || true)"
    if { [ "$DEPLOY_STATE" = switched ] || [ "$DEPLOY_STATE" = switch_pending ] || [ "$DEPLOY_STATE" = app_rollback_pending ] || [ "$DEPLOY_STATE" = unknown ]; } &&
      [ "$current_release" = "/opt/newme/releases/$SHA" ]; then
      echo "CRITICAL: failed canonical child left the candidate release active; versioned assets retained for consistency" >&2
      PRESERVE_DEPLOY_STATE_RECORD=1
      PRESERVE_ASSET_BACKUP_RECORD=1
    elif [ "$DEPLOY_STATE" = assets_rolled_back ]; then
      echo "immutable deploy already restored versioned assets" >&2
      if ! clear_matching_pending_asset_record recovery; then
        echo "CRITICAL: matching pending asset pointer could not be cleared after child rollback" >&2
        PRESERVE_DEPLOY_STATE_RECORD=1
        PRESERVE_ASSET_BACKUP_RECORD=1
      fi
    elif [ -n "$ASSET_BACKUP" ] || load_asset_backup_from_record; then
      if [ "$DEPLOY_STATE" = app_rollback_pending ] || [ "$DEPLOY_STATE" = app_rolled_back ] ||
        { { [ "$DEPLOY_STATE" = switch_pending ] || [ "$DEPLOY_STATE" = switched ] || [ "$DEPLOY_STATE" = unknown ]; } &&
          [ "$current_release" = "/opt/newme/releases/$ROLLBACK_SHA" ]; }; then
        RESTART_AFTER_ASSET_ROLLBACK=1
      fi
      echo "canonical deploy failed; restoring versioned assets from $ASSET_BACKUP" >&2
      if NEWME_VERSIONED_ASSET_RECOVERY=1 bash "$WORKTREE/scripts/rollback-systemd-assets.sh" "$ASSET_BACKUP"; then
        ASSET_ROLLBACK_VERIFIED=1
        if ! restore_pending_rollback_link; then
          echo "CRITICAL: prior rollback release pointer could not be restored" >&2
          PRESERVE_DEPLOY_STATE_RECORD=1
          PRESERVE_ASSET_BACKUP_RECORD=1
          ASSET_ROLLBACK_VERIFIED=0
        fi
        if [ "$ASSET_ROLLBACK_VERIFIED" -eq 1 ] && [ "$RESTART_AFTER_ASSET_ROLLBACK" -eq 1 ]; then
          /usr/local/sbin/newme-service-control reset-failed "deploy:asset-rollback:reset-before-restart" || true
          if ! /usr/local/sbin/newme-service-control restart "deploy:asset-rollback:canonical-failure" ||
            ! curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null; then
            echo "CRITICAL: application verification failed after asset rollback" >&2
            PRESERVE_DEPLOY_STATE_RECORD=1
            PRESERVE_ASSET_BACKUP_RECORD=1
            ASSET_ROLLBACK_VERIFIED=0
          fi
        fi
        if [ "$ASSET_ROLLBACK_VERIFIED" -eq 1 ] && ! clear_matching_pending_asset_record recovery; then
          echo "CRITICAL: matching pending asset pointer could not be cleared after rollback" >&2
          PRESERVE_DEPLOY_STATE_RECORD=1
          PRESERVE_ASSET_BACKUP_RECORD=1
        fi
      else
        echo "CRITICAL: canonical deploy asset rollback failed for $ASSET_BACKUP" >&2
        PRESERVE_DEPLOY_STATE_RECORD=1
        PRESERVE_ASSET_BACKUP_RECORD=1
      fi
    elif [ -s "$ASSET_BACKUP_RECORD" ]; then
      echo "CRITICAL: canonical deploy could not validate its asset backup record" >&2
      PRESERVE_DEPLOY_STATE_RECORD=1
      PRESERVE_ASSET_BACKUP_RECORD=1
    fi
  fi
  if [ -n "$ASSET_BACKUP_RECORD" ] && [ "$PRESERVE_ASSET_BACKUP_RECORD" -eq 0 ]; then rm -f -- "$ASSET_BACKUP_RECORD"; fi
  if [ -n "$DEPLOY_STATE_RECORD" ] && [ "$PRESERVE_DEPLOY_STATE_RECORD" -eq 0 ]; then rm -f -- "$DEPLOY_STATE_RECORD"; fi
  if [ "$CI_GATE_AUDIT_RECORD" = "$STATE_ROOT/ci-gate-audit.pending" ]; then rm -f -- "$CI_GATE_AUDIT_RECORD"; fi
  sync -f "$STATE_ROOT" || true
  git --git-dir="$MIRROR" worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf -- "$WORKTREE"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

git --git-dir="$MIRROR" branch -f main "$MAIN_SHA"
rmdir "$WORKTREE"
git --git-dir="$MIRROR" worktree add --force "$WORKTREE" main >/dev/null
chown -R root:root "$WORKTREE"

# ---------------------------------------------------------------------------
# Two host-side gates that CI structurally cannot provide
# ---------------------------------------------------------------------------
# Both run against the root-owned worktree at the canonical main SHA, before any
# asset is installed and before the release is staged, and both abort the
# deployment. Neither can be satisfied by a claim on the command line.
verify_exact_tree_release_gates || exit 65

# TASKBOARD predeploy readiness. The required GitHub job proves this same
# milestone for the dispatched SHA; this proves it again for the tree
# that is actually about to be deployed, using the checker committed to that same
# tree. AGENTS.md makes an unfinished board a deploy blocker, and until this
# revision nothing in the canonical path enforced that — scripts/deploy.sh Step 0
# did, and scripts/deploy.sh is not the canonical path.
#
# Round-4 C4-4 · why the scope and not --require-complete. Most rows on that board
# close only when production has run the change; they say 待部署. Requiring every
# row here meant requiring the outcome of the deployment as a precondition of the
# deployment, so this gate could never be green — and an unsatisfiable gate is one
# an operator learns to route around, which is exactly how the reviewed wrapper
# came to record a gate it had not really checked. The board now declares each
# unfinished row into predeploy_ready / postdeploy_acceptance and this call
# requires the first. Nothing is loosened: an undeclared unfinished row is a FAIL
# in the checker and lands in predeploy_ready anyway. A later TASKBOARD-only
# closure SHA is verified independently before release finalization.
# Remote migration history. The replay job proves the migrations in this tree run
# and do what they claim; it cannot prove that production's recorded history is
# the same history. A renamed or rewritten applied migration — the defect that
# rejected the reviewed revision of this branch — is invisible to every other
# gate here.
#
# The gate reads version, name, a statement count and a server-computed
# fingerprint, and compares them against the captured baseline in
# supabase/migration-history-reconciliation.json. Content that cannot be measured,
# a row recorded with no statements, and any difference the baseline's `accepted`
# list does not explicitly account for are all refusals — including on the first
# deploy, where the baseline is uncaptured and therefore explains nothing. That is
# deliberate: see supabase/preflight/migration-history-reconciliation.md.

# The migration set is DERIVED, not accepted (round-4 C4-1). Until this revision
# `$MIGRATION_IDS` — an operator's comma-separated list — was passed verbatim to
# --require-applied, and that gate re-measures every id it is handed. It cannot
# re-measure the ones it was not handed, so the claim was also the scope: measured
# against this release's manifest with the history gate's own judgement,
# `applied_verified 20260806000000` produced ZERO findings with sixteen of the
# seventeen required migrations unapplied, and a history that had additionally
# applied the deferred contract phase before the switch produced zero findings too.
#
# So the sets come out of $WORKTREE/infra/release/release-manifest.json — the
# manifest of the SHA being deployed, checked against that SHA's own
# supabase/migrations/ first, because a derived set is only as good as the manifest
# it is derived from — and the operator's list has to equal the required one exactly.
# What is printed is two id lists and a count; there is no database in this gate.
RELEASE_CLAIM="$(cd "$WORKTREE" && "$NODE_BIN" scripts/check-release-manifest.mjs \
  --verify-claim --status "$MIGRATION_STATUS" --ids "$MIGRATION_IDS")" || {
  printf '%s\n' "$RELEASE_CLAIM"
  echo "the migration claim on the command line is not the set this release's manifest requires" >&2
  exit 65
}
printf '%s\n' "$RELEASE_CLAIM"
REQUIRED_IDS="$(printf '%s\n' "$RELEASE_CLAIM" | sed -n 's/^required_for_app=//p')"
DEFERRED_IDS="$(printf '%s\n' "$RELEASE_CLAIM" | sed -n 's/^deferred_contract=//p')"

validate_migration_db_url_file || exit 65
MIGRATION_HISTORY_ARGS=(
  "$WORKTREE/scripts/verify-remote-migration-history.mjs"
  --url-file "$MIGRATION_DB_URL_FILE"
  --migrations-dir "$WORKTREE/supabase/migrations"
  --modules-dir "$LIVE_RELEASE/node_modules"
  --history-fixture "$WORKTREE/supabase/migration-history-reconciliation.json"
)
case "$MIGRATION_STATUS" in
  applied_verified)
    # The derived list, never $MIGRATION_IDS: the two are equal by the gate above,
    # and using the derived one means a future change to that gate cannot leave this
    # line quietly enforcing the operator's scope again.
    [[ "$REQUIRED_IDS" =~ ^[0-9]{14}(,[0-9]{14})*$ ]] || {
      echo "the release manifest yielded no required migration set to verify" >&2
      exit 65
    }
    MIGRATION_HISTORY_ARGS+=(--require-applied "$REQUIRED_IDS")
    # The other half of the phase split, as a fact about production rather than an
    # ordering rule inside the manifest: the contract phase must not be applied yet.
    if [ -n "$DEFERRED_IDS" ]; then
      [[ "$DEFERRED_IDS" =~ ^[0-9]{14}(,[0-9]{14})*$ ]] || {
        echo "the release manifest's deferred contract set is not a list of migration versions" >&2
        exit 65
      }
      MIGRATION_HISTORY_ARGS+=(--require-unapplied "$DEFERRED_IDS")
    fi
    ;;
  not_required)     MIGRATION_HISTORY_ARGS+=(--require-no-pending) ;;
esac
"$NODE_BIN" "${MIGRATION_HISTORY_ARGS[@]}" || {
  echo "production migration history does not match the release being deployed" >&2
  exit 65
}

# Hand-run companions (round-4 review C4-5). The gate above covers what production
# recorded; rollback_*.sql and recontract_*.sql are never recorded, because they
# are never applied by the CLI and never reach supabase_migrations.schema_migrations
# — so no gate above this line says anything about the scripts the operator will
# execute against production if this release has to be taken back out. Two of the
# five are executed by no CI job either, because they cover no migration new on
# this branch; measured on PG 17.10, a privilege escalation appended to the one CI
# does execute left the replay harness at rc=0 with every post-rollback assertion
# passing.
#
# Both sides of this check come from $WORKTREE — the root-owned worktree at the
# canonical main SHA — so what it proves is "the companions at this SHA are the
# companions this SHA declares", the same binding as the artifacts above.
# Systemd, sudo and observability assets are part of the immutable release
# boundary. Refresh them only from the verified root-owned main worktree.
require_canonical_main_sha "$SHA" || {
  echo "canonical main changed before the control-plane asset transaction" >&2
  exit 65
}
require_ci_gate_still_fresh || {
  echo "GitHub Actions evidence expired before the control-plane asset transaction" >&2
  exit 65
}
materialize_ci_gate_audit_record || {
  echo "durable GitHub Actions gate audit record could not be materialized" >&2
  exit 65
}
ASSET_BACKUP_RECORD="$(mktemp "$STATE_ROOT/systemd-assets-backup.XXXXXX")"
chmod 0600 "$ASSET_BACKUP_RECORD"

# The bootstrap precondition (round-3 P1-10). The installer replaces the control
# plane, including this wrapper, so it must not accept the word of a wrapper that
# checked nothing — and production still runs the old f37c203 one, which passes no
# CI_EVENT and runs none of the gates above. This record is that evidence: written
# only here, after every gate has passed, bound to this SHA and this run, and
# verified by scripts/verify-deploy-gate-record.mjs inside the installer before it
# touches anything. A wrapper that does not write it cannot install.
GATE_RECORD="$(mktemp "$STATE_ROOT/deploy-gates.XXXXXX")"
chmod 0600 "$GATE_RECORD"
cat > "$GATE_RECORD" <<EOF
sha=$SHA
event=$CI_EVENT
run=$RUN_ID
gate=canonical-main-verified
gate=github-required-jobs-green
gate=taskboard-predeploy-ready
gate=release-claim-derived
gate=remote-migration-history
gate=release-companions-verified
EOF
sync -f "$STATE_ROOT"

# The installer is invoked with the record still in place; cleanup() removes it on
# every exit path, and it is removed here as soon as the installer returns.
NEWME_ASSET_BACKUP_RECORD="$ASSET_BACKUP_RECORD" \
NEWME_DEPLOY_GATE_RECORD="$GATE_RECORD" \
NEWME_NODE_BIN="$NODE_BIN" \
  bash "$WORKTREE/scripts/install-systemd-assets.sh"
remove_gate_record
load_asset_backup_from_record || { echo "installer did not return a valid asset backup" >&2; exit 65; }

# Bootstrap is the first control-plane installation only. It deliberately runs
# through every release-candidate gate above and lets the candidate wrapper write
# the one-use installer gate record; there is no operator-authored gate label or
# shortcut around exact CI, taskboard, migration history, or companions.
# The installer opens a durable asset transaction before mutation. Health is
# checked while that rollback record still exists; only then may the candidate
# tree's verifier finalize the transaction. Any interruption or failed health
# check reaches cleanup(), which restores the recorded asset snapshot.
if [ "$BOOTSTRAP_ONLY" -eq 1 ]; then
  systemctl is-active --quiet newme-platform || {
    echo "bootstrap installed the control plane but the application service is not active" >&2
    exit 65
  }
  curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null || {
    echo "bootstrap installed the control plane but application health verification failed" >&2
    exit 65
  }
  NEWME_ASSET_FINALIZE_CONFIRM=bootstrap \
    bash "$WORKTREE/scripts/install-systemd-assets.sh" finalize || {
      echo "bootstrap control-plane transaction could not be finalized" >&2
      exit 65
    }
  if [ -e "$PENDING_ASSET_RECORD" ] || [ -L "$PENDING_ASSET_RECORD" ]; then
    echo "bootstrap finalizer left an unresolved asset transaction" >&2
    exit 66
  fi
  echo "bootstrapped control-plane release=$SHA run=$RUN_ID systemd_asset_transaction=none"
  exit 0
fi

require_canonical_main_sha "$SHA" || {
  echo "canonical main changed before postdeploy browser runtime preparation" >&2
  exit 65
}
require_ci_gate_still_fresh || {
  echo "GitHub Actions evidence expired before postdeploy browser runtime preparation" >&2
  exit 65
}
prepare_postdeploy_browser_image || {
  echo "digest-pinned postdeploy browser image could not be prepared" >&2
  exit 65
}

DEPLOY_STATE_RECORD="$(mktemp "$STATE_ROOT/deploy-state.XXXXXX")"
chmod 0600 "$DEPLOY_STATE_RECORD"

/usr/bin/logger --journald <<EOF
MESSAGE=newme canonical deployment request
PRIORITY=5
SYSLOG_IDENTIFIER=newme-deploy
NEWME_ACTOR=${SUDO_USER:-root}
NEWME_RELEASE_SHA=$SHA
NEWME_CI_RUN_ID=$RUN_ID
NEWME_MIGRATION_STATUS=$MIGRATION_STATUS
EOF

CI_RUN_ID="$RUN_ID" \
CI_RUN_URL="$CI_RUN_URL" \
CI_HEAD_SHA="$SHA" \
CI_CONCLUSION="$CI_CONCLUSION" \
CI_EVENT="$CI_EVENT" \
CI_WORKFLOW_ID="$CI_WORKFLOW_ID" \
CI_WORKFLOW_PATH="$CI_WORKFLOW_PATH" \
CI_RUN_COMPLETED_AT="$CI_RUN_COMPLETED_AT" \
CI_GATE_AUDIT_SHA256="$CI_GATE_AUDIT_SHA256" \
CI_GATE_AUDITED_AT="$CI_GATE_AUDITED_AT" \
CI_GATE_AUDIT_RECORD="$CI_GATE_AUDIT_RECORD" \
CI_MAX_RUN_AGE_SECONDS="$CI_MAX_RUN_AGE_SECONDS" \
NEWME_MANUAL_VERIFICATION=0 \
MIGRATION_STATUS="$MIGRATION_STATUS" \
MIGRATION_IDS="$REQUIRED_IDS" \
ROLLBACK_GIT_SHA="$ROLLBACK_SHA" \
NEWME_ASSET_BACKUP="$ASSET_BACKUP" \
NEWME_DEPLOY_STATE_RECORD="$DEPLOY_STATE_RECORD" \
bash "$WORKTREE/scripts/deploy-immutable.sh" "$SHA"
load_deploy_state && [ "$DEPLOY_STATE" = "complete=$SHA" ] || { echo "immutable deploy did not record durable completion" >&2; exit 65; }
DEPLOY_SUCCEEDED=1
