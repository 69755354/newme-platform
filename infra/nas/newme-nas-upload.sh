#!/usr/bin/env bash
# Upload ONE named local file to a sub-folder of the company NAS through the DSM FileStation API.
# Same approach as newme-nas-push.sh (which only pushes the newest backup): credentials come from
# /etc/newme/nas-push.env (root 0600) and travel only inside curl config files, never argv; an upload is
# skipped when the NAS already holds the same size, and verified by size afterwards.
# Usage: newme-nas-upload.sh [--overwrite] <local-file> <remote-dir under /newme-os-backup>
# --overwrite (or NAS_UPLOAD_OVERWRITE=1): never skip; always upload over the NAS copy and verify the size.
# For files that are regenerated under the same name (the dated Meta ID export); backups keep the default skip.
# Exit 0 uploaded or already present; 1 any failure (systemd OnFailure alerts); 2 bad usage or config.
set -euo pipefail
umask 077
ENV_FILE=${NAS_ENV_FILE:-/etc/newme/nas-push.env}
SCHEME=${NAS_SCHEME:-http}
ROOT=/newme-os-backup

OVERWRITE=${NAS_UPLOAD_OVERWRITE:-0}
if [ "${1:-}" = "--overwrite" ]; then OVERWRITE=1; shift; fi
LOCAL=${1:-}; REMOTE_DIR=${2:-}
if [ -z "$LOCAL" ] || [ -z "$REMOTE_DIR" ]; then echo "usage: $0 [--overwrite] <local-file> <remote-dir>" >&2; exit 2; fi
if [ ! -f "$LOCAL" ] || [ -L "$LOCAL" ]; then echo "not a regular file: $LOCAL" >&2; exit 2; fi
NAME=$(basename "$LOCAL")
case "$NAME" in *[!A-Za-z0-9._-]*|.*) echo "unsafe file name" >&2; exit 2 ;; esac
case "$REMOTE_DIR" in
  "$ROOT"|"$ROOT"/*) ;;
  *) echo "remote dir must be under $ROOT" >&2; exit 2 ;;
esac
case "$REMOTE_DIR" in *..*|*[!A-Za-z0-9._/-]*) echo "unsafe remote dir" >&2; exit 2 ;; esac
[ -r "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 2; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${NAS_USER:?}" "${NAS_PASSWORD:?}" "${NAS_HOST:?}"

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
BASE="$SCHEME://$NAS_HOST/webapi/entry.cgi"
SIZE=$(stat -c %s "$LOCAL")

printf 'url = "%s"\ndata-urlencode = "api=SYNO.API.Auth"\ndata-urlencode = "version=6"\ndata-urlencode = "method=login"\ndata-urlencode = "account=%s"\ndata-urlencode = "passwd=%s"\ndata-urlencode = "session=FileStation"\ndata-urlencode = "format=sid"\n' \
  "$BASE" "$NAS_USER" "$NAS_PASSWORD" > "$W/login.conf"
SID=$(curl -sS -m 30 -K "$W/login.conf" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["data"]["sid"] if d.get("success") else "")' 2>/dev/null || true)
[ -n "$SID" ] || { echo "NAS login failed" >&2; exit 1; }
trap 'printf "url = \"%s\"\nget\ndata-urlencode = \"api=SYNO.API.Auth\"\ndata-urlencode = \"version=6\"\ndata-urlencode = \"method=logout\"\ndata-urlencode = \"session=FileStation\"\ndata-urlencode = \"_sid=%s\"\n" "$BASE" "$SID" > "$W/logout.conf"; curl -sS -m 15 -K "$W/logout.conf" >/dev/null 2>&1 || true; rm -rf "$W"' EXIT

remote_size() {
  printf 'url = "%s"\nget\ndata-urlencode = "api=SYNO.FileStation.List"\ndata-urlencode = "version=2"\ndata-urlencode = "method=getinfo"\ndata-urlencode = "path=[\\"%s/%s\\"]"\ndata-urlencode = "additional=[\\"size\\"]"\ndata-urlencode = "_sid=%s"\n' \
    "$BASE" "$REMOTE_DIR" "$NAME" "$SID" > "$W/info.conf"
  curl -sS -m 30 -K "$W/info.conf" | python3 -c 'import sys,json;d=json.load(sys.stdin);f=(d.get("data",{}).get("files") or [{}])[0];print((f.get("additional") or {}).get("size",-1))'
}

if [ "$OVERWRITE" != "1" ] && [ "$(remote_size 2>/dev/null || echo -1)" = "$SIZE" ]; then echo "skip $NAME (already on NAS, $SIZE bytes)"; exit 0; fi

printf 'url = "%s?_sid=%s"\nform = "api=SYNO.FileStation.Upload"\nform = "version=2"\nform = "method=upload"\nform = "path=%s"\nform = "create_parents=true"\nform = "overwrite=true"\nform = "file=@%s;filename=%s"\n' \
  "$BASE" "$SID" "$REMOTE_DIR" "$LOCAL" "$NAME" > "$W/upload.conf"
curl -sS -m 600 -X POST -K "$W/upload.conf" | python3 -c 'import sys,json;d=json.load(sys.stdin);sys.exit(0 if d.get("success") else 1)' \
  || { echo "upload failed: $NAME" >&2; exit 1; }
GOT=$(remote_size 2>/dev/null || echo -1)
[ "$GOT" = "$SIZE" ] || { echo "size mismatch for $NAME (local $SIZE, NAS $GOT)" >&2; exit 1; }
echo "uploaded $NAME ($SIZE bytes) to $REMOTE_DIR"
