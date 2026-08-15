#!/usr/bin/env bash
set -Eeuo pipefail

[ "${NEWME_DRILL_CONFIRM:-}" = throwaway-container ] &&
  { [ -f /.dockerenv ] || [ -f /run/.containerenv ]; } || {
    echo "alert-state preflight drill is restricted to a throwaway container" >&2
    exit 64
  }
[ "$(id -u)" -eq 0 ] || exit 77

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT HUP INT TERM
SOURCE_ROOT="${NEWME_DRILL_SOURCE_ROOT:-/repo}"
FIXTURE_ROOT="$WORK/candidate"
mkdir -p "$FIXTURE_ROOT"
tar -C "$SOURCE_ROOT" \
  --exclude=./.git --exclude=./node_modules --exclude=./.next \
  --exclude=./.audit --exclude=./test-results -cf - . |
  tar -C "$FIXTURE_ROOT" -xf -
git -C "$FIXTURE_ROOT" init -q
git -C "$FIXTURE_ROOT" config user.email drill@invalid.example
git -C "$FIXTURE_ROOT" config user.name newme-drill
git -C "$FIXTURE_ROOT" add -A
git -C "$FIXTURE_ROOT" commit -qm fixture

CHECKS=0
FAILURES=0
pass() {
  CHECKS=$((CHECKS + 1))
  printf 'PASS: %s\n' "$1"
}
fail() {
  CHECKS=$((CHECKS + 1))
  FAILURES=$((FAILURES + 1))
  printf 'FAIL: %s\n' "$1" >&2
}

snapshot_target() {
  local output="$1"
  {
    find /var/lib/newme -xdev -printf 'node|%y|%u|%g|%m|%T@|%p|%l\n' 2>/dev/null | sort
    find /var/lib/newme -xdev -type f -print0 2>/dev/null |
      sort -z |
      xargs -0 -r sha256sum |
      sed 's/^/sha256|/'
  } >"$output"
}

run_negative_case() {
  local name="$1" setup="$2" before="" after=""
  local rc=0
  before="$WORK/$name.before"
  after="$WORK/$name.after"
  rm -rf -- /var/lib/newme
  rm -f -- /run/lock/newme-systemd-assets.lock
  mkdir -p /var/lib/newme
  chmod 0755 /var/lib/newme
  case "$setup" in
    untrusted_directory)
      mkdir -p /var/lib/newme/hermes-alert-v1
      printf 'sentinel-%s\n' "$name" >/var/lib/newme/hermes-alert-v1/state
      chown -R 1000:1000 /var/lib/newme/hermes-alert-v1
      chmod 0777 /var/lib/newme/hermes-alert-v1
      ;;
    untrusted_file)
      mkdir -p /var/lib/newme/hermes-alert-v1
      chmod 0700 /var/lib/newme/hermes-alert-v1
      printf 'sentinel-%s\n' "$name" >/var/lib/newme/hermes-alert-v1/state
      chmod 0600 /var/lib/newme/hermes-alert-v1/state
      chown 1000:1000 /var/lib/newme/hermes-alert-v1/state
      ;;
    symlink)
      mkdir -p /var/lib/newme/untrusted-target
      printf 'sentinel-%s\n' "$name" >/var/lib/newme/untrusted-target/state
      ln -s /var/lib/newme/untrusted-target /var/lib/newme/hermes-alert-v1
      ;;
    *) exit 64 ;;
  esac
  snapshot_target "$before"
  set +e
  bash "$FIXTURE_ROOT/scripts/install-systemd-assets.sh" \
    >"$WORK/$name.stdout" 2>"$WORK/$name.stderr"
  rc=$?
  set -e
  snapshot_target "$after"
  [ "$rc" -eq 65 ] && pass "$name is refused" || fail "$name returned rc=$rc instead of 65"
  cmp -s "$before" "$after" && pass "$name leaves the complete target tree unchanged" ||
    fail "$name changed target bytes, metadata, links, or directories"
  [ ! -e /run/lock/newme-systemd-assets.lock ] && [ ! -L /run/lock/newme-systemd-assets.lock ] &&
    pass "$name is refused before the installer lock write" || fail "$name created the installer lock"
  [ ! -e /var/lib/newme/deploy-state ] && [ ! -L /var/lib/newme/deploy-state ] &&
    pass "$name is refused before deploy-state creation" || fail "$name created deploy-state"
  grep -Fqx 'existing alert state contains untrusted metadata' "$WORK/$name.stderr" &&
    pass "$name reports the exact trust-boundary refusal" || fail "$name reported an unexpected error"
}

run_negative_case nobody-directory untrusted_directory
run_negative_case nobody-file untrusted_file
run_negative_case state-symlink symlink

printf 'alert-state preflight drill: checks=%s failures=%s\n' "$CHECKS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
