#!/usr/bin/env bash
# Daily: fetch the Meta ID registry CSV from the app with the read-only export token, keep a dated copy
# in /var/lib/newme-meta-ids/, and push it to the NAS (/newme-os-backup/exports/meta-ids-YYYYMMDD.csv).
# The token is sent as an Authorization header from a curl config file (never argv, never in a URL, so it
# does not reach any access log). Config: /etc/newme/meta-ids-export.env (root 0600), see meta-ids-export.env.example.
# Exit 1 on any failure (systemd OnFailure alerts); 2 on missing configuration.
set -euo pipefail
umask 077
ENV_FILE=${META_IDS_ENV_FILE:-/etc/newme/meta-ids-export.env}
[ -r "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 2; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${META_IDS_EXPORT_TOKEN:?}"
URL=${META_IDS_EXPORT_URL:-https://app.newme.ae/api/export/meta-ids}
OUT_DIR=${META_IDS_OUT_DIR:-/var/lib/newme-meta-ids}
NAS_UPLOAD=${NAS_UPLOAD_SCRIPT:-/usr/local/libexec/newme/newme-nas-upload.sh}
NAS_DIR=${META_IDS_NAS_DIR:-/newme-os-backup/exports}
KEEP_DAYS=${META_IDS_KEEP_DAYS:-60}
case "$META_IDS_EXPORT_TOKEN" in *[!A-Za-z0-9._~-]*) echo "token has unexpected characters" >&2; exit 2 ;; esac

mkdir -p "$OUT_DIR"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
DAY=$(TZ=Asia/Dubai date +%Y%m%d)
FINAL="$OUT_DIR/meta-ids-$DAY.csv"
printf 'header = "Authorization: Bearer %s"\n' "$META_IDS_EXPORT_TOKEN" > "$W/curl.conf"
code=$(curl -sS -m 120 -K "$W/curl.conf" -o "$W/out.csv" -w '%{http_code}' "$URL?format=csv") || { echo "fetch failed" >&2; exit 1; }
[ "$code" = "200" ] || { echo "export returned HTTP $code" >&2; exit 1; }
# A real export starts with the header row; a login page or error body must never replace the day's file.
tail -c +4 "$W/out.csv" > "$W/body.csv"   # skip the 3-byte UTF-8 byte-order mark the export starts with
head -1 "$W/body.csv" | grep -q '^lead_ref,source,meta_id_type,meta_id,' || { echo "unexpected export content" >&2; exit 1; }
mv "$W/out.csv" "$FINAL"
echo "saved $FINAL ($(stat -c %s "$FINAL") bytes, $(($(wc -l < "$FINAL") - 1)) data lines)"
# the dated file is regenerated on same-day reruns: always overwrite the NAS copy
"$NAS_UPLOAD" --overwrite "$FINAL" "$NAS_DIR"
find "$OUT_DIR" -maxdepth 1 -name 'meta-ids-*.csv' -mtime "+$KEEP_DAYS" -delete
date -u +%FT%TZ > "$OUT_DIR/last-ok"
