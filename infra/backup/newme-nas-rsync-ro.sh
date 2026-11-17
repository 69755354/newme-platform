#!/bin/sh
# Forced command of the NAS pull account (S17 B-2). sshd runs this for every login of that key
# (authorized_keys: command="...",restrict,from="<NAS address>") and puts what the client asked for
# in SSH_ORIGINAL_COMMAND. Only one thing is allowed: an rsync SENDER (the NAS downloads) of the
# backup pull directory. Uploads, shells, scp, other paths and delete/remove options are refused.
# The account also has no write permission on the directory, so this is a second lock.
#
# After a pull that finished with exit 0 it writes the time to $NAS_PULL_STATE/last-pull-ok, which
# newme-backup-freshness.sh turns into an alert when the NAS stops pulling.
#
# Environment (tests and non-default layouts only): NAS_PULL_DIR, NAS_PULL_STATE, RSYNC_BIN.
set -u
umask 077
DIR="${NAS_PULL_DIR:-/var/backups/newme-db-pull}"
STATE="${NAS_PULL_STATE:-/var/lib/newme-nas-pull/state}"
RSYNC="${RSYNC_BIN:-/usr/bin/rsync}"

refuse() {
  echo "newme-nas-rsync-ro: refused: $1" >&2
  if mkdir -p "$STATE" 2>/dev/null; then
    printf '%s refused: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$STATE/refused.log" 2>/dev/null
  fi
  exit 126
}

CMD="${SSH_ORIGINAL_COMMAND:-}"
[ -n "$CMD" ] || refuse "no command (interactive shells are not allowed)"
# One line, only characters an rsync server command line needs: no quotes, $, ;, |, &, backtick, newline.
case "$CMD" in
  *[!A-Za-z0-9\ ._=/,+:@%-]*) refuse "unexpected characters in the command" ;;
esac

set -f
# shellcheck disable=SC2086
set -- $CMD
[ "$#" -ge 5 ] || refuse "too short"
if [ "$1" != rsync ] || [ "$2" != --server ] || [ "$3" != --sender ]; then refuse "only 'rsync --server --sender' is allowed"; fi
shift 3

# Every word but the last two must be an allowed option; the last two are "." and the directory.
count=$#
[ "$count" -ge 2 ] || refuse "missing source path"
i=1
for arg in "$@"; do
  if [ "$i" -le $((count - 2)) ]; then
    case "$arg" in
      --numeric-ids|--partial) ;;
      --timeout=[0-9]*) case "${arg#--timeout=}" in *[!0-9]*) refuse "bad --timeout" ;; esac ;;
      --*) refuse "option not allowed: $arg" ;;
      -*)
        # A short-option cluster: letters, digits and dots only (no "-M--delete" smuggling), and no "s"
        # in the part before "e." (-s = secluded args: rsync would then read the real path from the
        # data stream and the directory check above would mean nothing). Everything after the first
        # "e" is rsync's own capability string (it legitimately contains s) and is not parsed as options.
        cluster="${arg#-}"
        case "$cluster" in ''|*[!A-Za-z0-9.]*) refuse "bad option cluster: $arg" ;; esac
        case "${cluster%%e*}" in *s*) refuse "secluded-args (-s) is not allowed; do not use -s on the NAS" ;; esac
        ;;
      *) refuse "unexpected argument before the path: $arg" ;;
    esac
  fi
  last2="${last1:-}"; last1="$arg"
  i=$((i + 1))
done
dot="$last2"; path="$last1"
[ "$dot" = . ] || refuse "expected '.' before the path"
case "$path" in
  *..*) refuse "path traversal" ;;
  "$DIR"|"$DIR"/|"$DIR"/*) ;;
  *) refuse "path outside the backup pull directory" ;;
esac

"$RSYNC" --server --sender "$@"
rc=$?
if [ "$rc" -eq 0 ]; then
  if mkdir -p "$STATE" 2>/dev/null; then date +%s > "$STATE/last-pull-ok" 2>/dev/null; fi
fi
exit "$rc"
