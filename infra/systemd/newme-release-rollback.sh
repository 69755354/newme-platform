#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  echo "usage: newme-release-rollback <provenance-reason>" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
readonly REASON=$1
[[ "$REASON" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,191}$ ]] || usage
[[ "$REASON" =~ ^[A-Za-z0-9_.@:-]+\.(service|socket|timer|target|mount|path|slice)$ ]] && usage

[ "$(id -u)" -eq 0 ] || {
  echo "newme-release-rollback must run as root" >&2
  exit 77
}

readonly RELEASES=/opt/newme/releases
readonly CURRENT=/opt/newme/current
readonly ROLLBACK=/opt/newme/current.rollback
readonly CONTROL=/usr/local/sbin/newme-service-control
readonly LOCK=/run/lock/newme-deploy.lock
readonly ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
SWITCHED=0

fail() {
  echo "newme release rollback failed: $*" >&2
  return 1
}

validate_release_link() {
  local link=$1 target mode
  [ -L "$link" ] || fail "$link must be a symlink"
  target="$(readlink -f "$link" 2>/dev/null)" || fail "$link target cannot be resolved"
  case "$target" in
    "$RELEASES"/*) ;;
    *) fail "$link must target an immutable release" ;;
  esac
  [ -d "$target" ] || fail "$link target is missing"
  [ -f "$target/manifest.json" ] || fail "$link target lacks manifest.json"
  [ -f "$target/.next/BUILD_ID" ] || fail "$link target lacks BUILD_ID"
  [ "$(stat -c '%U' "$target")" = ubuntu ] || fail "$link target owner is invalid"
  mode="$(stat -c '%a' "$target")"
  [ "$((8#$mode & 8#022))" -eq 0 ] || fail "$link target is group- or world-writable"
  printf '%s' "$target"
}

exchange_links() {
  python3 - "$CURRENT" "$ROLLBACK" <<'PY'
import ctypes
import os
import sys

current, rollback = (os.fsencode(value) for value in sys.argv[1:])
libc = ctypes.CDLL(None, use_errno=True)
try:
    renameat2 = libc.renameat2
except AttributeError:
    raise SystemExit("renameat2 is unavailable")
renameat2.argtypes = [
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_uint,
]
renameat2.restype = ctypes.c_int
AT_FDCWD = -100
RENAME_EXCHANGE = 2
if renameat2(AT_FDCWD, current, AT_FDCWD, rollback, RENAME_EXCHANGE) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
PY
}

restore_on_failure() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$SWITCHED" -eq 1 ]; then
    if exchange_links &&
      "$CONTROL" restart "rollback:$ID:restore" &&
      curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null; then
      echo "rollback target failed; original release restored" >&2
    else
      echo "CRITICAL: rollback failed and automatic release restoration failed" >&2
      exit 70
    fi
  fi
  exit "$rc"
}
trap restore_on_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

exec 9>"$LOCK"
flock -n 9 || {
  echo "another deployment or rollback is active" >&2
  exit 75
}

readonly ORIGINAL="$(validate_release_link "$CURRENT")"
readonly TARGET="$(validate_release_link "$ROLLBACK")"
[ "$ORIGINAL" != "$TARGET" ] || fail "current and current.rollback must differ"
[ -x "$CONTROL" ] || fail "audited service control is missing"

exchange_links
SWITCHED=1
[ "$(readlink -f "$CURRENT")" = "$TARGET" ] || fail "atomic rollback switch did not select target"
[ "$(readlink -f "$ROLLBACK")" = "$ORIGINAL" ] || fail "atomic rollback switch did not preserve original"
"$CONTROL" restart "rollback:$ID:switch"
curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null ||
  fail "rollback target health check failed"

/usr/bin/logger --journald <<EOF
MESSAGE=newme immutable release rollback succeeded
PRIORITY=5
SYSLOG_IDENTIFIER=newme-release-rollback
NEWME_ACTOR=${SUDO_USER:-root}
NEWME_REASON=$REASON
NEWME_FROM=$ORIGINAL
NEWME_TO=$TARGET
EOF

SWITCHED=0
trap - EXIT INT TERM
echo "rollback succeeded from=$ORIGINAL to=$TARGET"
