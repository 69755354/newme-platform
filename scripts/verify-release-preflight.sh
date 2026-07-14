#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir/.." rev-parse --show-toplevel 2>/dev/null)" ||
  fail "unable to resolve repository root"

branch="$(git -C "$repo_root" symbolic-ref --quiet --short HEAD || true)"
[[ "$branch" == "main" ]] || fail "release preflight requires symbolic branch main"

git -C "$repo_root" fetch origin main --quiet ||
  fail "failed to fetch origin/main"

release_sha="$(git -C "$repo_root" rev-parse HEAD)"
origin_main="$(git -C "$repo_root" rev-parse refs/remotes/origin/main 2>/dev/null)" ||
  fail "origin/main is unavailable"
[[ "$release_sha" == "$origin_main" ]] ||
  fail "release HEAD must equal origin/main"

[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=all)" ]] ||
  fail "release worktree must be clean"

for name in CI_RUN_ID CI_RUN_URL CI_HEAD_SHA CI_CONCLUSION MIGRATION_STATUS ROLLBACK_GIT_SHA; do
  [[ -n "${!name:-}" ]] || fail "$name is required"
done
[[ -n "${MIGRATION_IDS+x}" ]] || fail "MIGRATION_IDS must be present"

[[ "$CI_RUN_ID" =~ ^[0-9]+$ ]] || fail "CI_RUN_ID must be numeric"
expected_run_url="https://github.com/69755354/newme-platform/actions/runs/$CI_RUN_ID"
[[ "$CI_RUN_URL" == "$expected_run_url" ]] ||
  fail "CI_RUN_URL must equal expected GitHub Actions run URL"
[[ "$CI_CONCLUSION" == "success" ]] ||
  fail "CI_CONCLUSION must be success"
[[ "$CI_HEAD_SHA" == "$release_sha" ]] ||
  fail "CI_HEAD_SHA must equal release SHA"

case "$MIGRATION_STATUS" in
  not_required)
    [[ -z "$MIGRATION_IDS" ]] ||
      fail "MIGRATION_IDS must be empty when migration is not_required"
    ;;
  applied_verified)
    [[ -n "$MIGRATION_IDS" ]] ||
      fail "MIGRATION_IDS is required for applied_verified"
    ;;
  *)
    fail "MIGRATION_STATUS must be not_required or applied_verified"
    ;;
esac

[[ "$ROLLBACK_GIT_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "ROLLBACK_GIT_SHA must be a full lowercase commit SHA"
git -C "$repo_root" rev-parse --verify "$ROLLBACK_GIT_SHA^{commit}" >/dev/null 2>&1 ||
  fail "ROLLBACK_GIT_SHA must resolve to a commit"

printf '%s\n' "$release_sha"
