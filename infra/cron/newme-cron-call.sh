#!/bin/sh
# Call one application cron endpoint and make the result visible (S17 B-1).
#
#   newme-cron-call.sh <endpoint-name>      e.g. daily-reminder
#
# Environment (from /etc/newme/cron.env through the systemd unit):
#   CRON_SECRET            sent as the x-cron-secret header (never in the argument list)
#   NEWME_CRON_BASE_URL    default http://127.0.0.1:3001 (the application, not nginx)
#   NEWME_CRON_RETRIES     tries when the connection is refused (app restarting), default 3
#   NEWME_CRON_RETRY_DELAY seconds between those tries, default 20
#   ALERT_SENDER           default /usr/local/libexec/newme/newme-whatsapp-alert.sh
#
# Exit status: 0 HTTP 2xx, 1 any other HTTP status or no answer, 2 configuration, 4 the endpoint
# answered 2xx but says it is Disabled (a timer for a switched-off feature must not look healthy).
# The failure alert is raised by the unit's OnFailure=; this script sends the recovery message.
# Only a refused connection is retried: after any HTTP answer the write may already have happened.
set -u
umask 077

NAME="${1:-}"
case "$NAME" in ''|*[!a-z0-9-]*) echo "newme-cron-call: endpoint name must be lowercase letters, digits, dash" >&2; exit 2 ;; esac
BASE="${NEWME_CRON_BASE_URL:-http://127.0.0.1:3001}"
case "$BASE" in
  http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*|https://*) ;;
  *) echo "newme-cron-call: NEWME_CRON_BASE_URL must be loopback http or https" >&2; exit 2 ;;
esac
[ -n "${CRON_SECRET:-}" ] || { echo "newme-cron-call: CRON_SECRET is not set" >&2; exit 2; }
case "$CRON_SECRET" in *[!A-Za-z0-9._~+/=-]*) echo "newme-cron-call: CRON_SECRET has unexpected characters" >&2; exit 2 ;; esac
RETRIES="${NEWME_CRON_RETRIES:-3}"
DELAY="${NEWME_CRON_RETRY_DELAY:-20}"
case "$RETRIES$DELAY" in *[!0-9]*) echo "newme-cron-call: retry settings must be numbers" >&2; exit 2 ;; esac
SENDER="${ALERT_SENDER:-/usr/local/libexec/newme/newme-whatsapp-alert.sh}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/newme-cron.XXXXXX")" || exit 1
trap 'rm -rf "$WORK"' EXIT INT TERM HUP

attempt=1
while :; do
  # --fail: HTTP >= 400 is a curl failure (exit 22). -w keeps the status for the log line.
  printf 'url = "%s/api/cron/%s"\nheader = "x-cron-secret: %s"\n' "$BASE" "$NAME" "$CRON_SECRET" > "$WORK/curl.conf"
  code="$(curl --fail -sS -m 120 -K "$WORK/curl.conf" -o "$WORK/body" -w '%{http_code}' 2>"$WORK/err")"
  rc=$?
  [ "$rc" -eq 7 ] || break
  echo "newme-cron-call: $NAME attempt $attempt: connection refused" >&2
  [ "$attempt" -lt "$RETRIES" ] || break
  attempt=$((attempt + 1))
  sleep "$DELAY"
done

summary="$(head -c 300 "$WORK/body" 2>/dev/null | tr '\n\r' '  ')"
if [ "$rc" -ne 0 ]; then
  # curl's own message already says "HTTP 4xx/5xx" for --fail errors; add the code explicitly.
  echo "newme-cron-call: $NAME FAILED: curl exit $rc, HTTP ${code:-000}: $(head -c 200 "$WORK/err" | tr '\n' ' ') $summary" >&2
  exit 1
fi
echo "newme-cron-call: $NAME HTTP $code $summary"
case "$summary" in
  *'"message":"Disabled"'*) echo "newme-cron-call: $NAME answered Disabled; the feature is switched off, so this timer should not be enabled" >&2; exit 4 ;;
esac
if [ -x "$SENDER" ]; then
  "$SENDER" "newme-cron-$NAME" recovery "newme-cron $NAME is healthy again" || echo "newme-cron-call: recovery message not delivered" >&2
fi
exit 0
