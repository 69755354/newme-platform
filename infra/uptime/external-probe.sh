#!/bin/sh
# External uptime probe for app.newme.ae (S7 item 3, review 5-logging-monitoring F1).
# Runs OUTSIDE the production server (company NAS over Tailscale, or any small
# always-on machine) so a dead server, expired certificate, broken DNS or dead
# nginx is noticed by something that does not die with it. POSIX sh on purpose:
# NAS shells are often busybox. No secrets live in this file; the Telegram token
# and group id come from an env file readable only by its owner.
#
#   Config (UPTIME_ENV_FILE, default /etc/newme-uptime.env, chmod 600):
#     NEWME_BASE_URL=https://app.newme.ae
#     TELEGRAM_BOT_TOKEN=...            (bot that is a member of the alert group)
#     TELEGRAM_CHAT_ID=-100...          (the alert GROUP: Sam + backup)
#     FAIL_THRESHOLD=2                  (consecutive failed minutes before alerting)
#     STATE_DIR=/var/lib/newme-uptime
#     DAILY_HEARTBEAT_HOUR_UTC=3        (optional: one "still watching" message a day;
#                                        no message for two days means THIS probe died)
#
# Exit status is 0 when the site is healthy, 1 when a check failed (whether or not
# an alert was sent), 2 on configuration errors.
set -u
umask 077

ENV_FILE="${UPTIME_ENV_FILE:-/etc/newme-uptime.env}"
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
BASE_URL="${NEWME_BASE_URL:-https://app.newme.ae}"
THRESHOLD="${FAIL_THRESHOLD:-2}"
STATE_DIR="${STATE_DIR:-/var/lib/newme-uptime}"
TIMEOUT="${PROBE_TIMEOUT_SECONDS:-10}"
HEARTBEAT_HOUR="${DAILY_HEARTBEAT_HOUR_UTC:-}"
NOW_HOUR="${UPTIME_NOW_HOUR_UTC:-$(date -u +%H)}"
TODAY="${UPTIME_TODAY:-$(date -u +%Y-%m-%d)}"

case "$THRESHOLD" in ''|*[!0-9]*) echo "FAIL_THRESHOLD must be a number" >&2; exit 2;; esac
case "$BASE_URL" in https://*) ;; *) echo "NEWME_BASE_URL must be https" >&2; exit 2;; esac
mkdir -p "$STATE_DIR" || { echo "cannot create STATE_DIR" >&2; exit 2; }

tg_send() {
  # The token is passed through a curl config on stdin so it never appears in
  # the process list; the message body is plain text.
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || { echo "telegram not configured" >&2; return 1; }
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TELEGRAM_BOT_TOKEN" |
    curl -sS -m 15 -o /dev/null -K - --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=$1" \
      -w '' >/dev/null 2>&1
}

BODY="$STATE_DIR/body.$$"
trap 'rm -f "$BODY"' EXIT

# check <label> <path> <expected-status> <body-pattern or empty>
check() {
  code=$(curl -sS -m "$TIMEOUT" -o "$BODY" -w '%{http_code}' "$BASE_URL$2" 2>/dev/null) || code=000
  if [ "$code" != "$3" ]; then FAIL_REASON="$1 returned HTTP $code (expected $3)"; return 1; fi
  if [ -n "$4" ] && ! grep -q "$4" "$BODY" 2>/dev/null; then FAIL_REASON="$1 answered but the content was wrong"; return 1; fi
  return 0
}

FAIL_REASON=""
check "login page" "/login" 200 "" && check "health endpoint" "/api/health" 200 '"status":"ok"'
RESULT=$?

STATE_FILE="$STATE_DIR/state"
fail_count=0; alerted=0
[ -r "$STATE_FILE" ] && . "$STATE_FILE"

if [ "$RESULT" -eq 0 ]; then
  if [ "$alerted" = 1 ]; then
    tg_send "恢复 / RECOVERED: app.newme.ae is reachable again. 网站已恢复访问。" || echo "recovery message not delivered" >&2
  fi
  fail_count=0; alerted=0
else
  fail_count=$((fail_count + 1))
  if [ "$fail_count" -ge "$THRESHOLD" ] && [ "$alerted" = 0 ]; then
    if tg_send "故障 / DOWN: app.newme.ae — $FAIL_REASON (failed ${fail_count} checks in a row). 网站检查连续失败，请立即查看。"; then
      alerted=1
    else
      echo "alert not delivered; will retry next run" >&2
    fi
  fi
fi
printf 'fail_count=%s\nalerted=%s\n' "$fail_count" "$alerted" > "$STATE_FILE"

# Dead-man heartbeat: proves this watcher itself is alive.
if [ -n "$HEARTBEAT_HOUR" ] && [ "$(expr "$NOW_HOUR" + 0)" -eq "$(expr "$HEARTBEAT_HOUR" + 0)" ] && [ "$RESULT" -eq 0 ]; then
  if [ "$(cat "$STATE_DIR/heartbeat-day" 2>/dev/null)" != "$TODAY" ]; then
    tg_send "巡检正常 / OK: external uptime probe is alive, app.newme.ae healthy. 外部探测运行正常。" && printf '%s' "$TODAY" > "$STATE_DIR/heartbeat-day"
  fi
fi

[ "$RESULT" -eq 0 ] || { echo "$FAIL_REASON" >&2; exit 1; }
exit 0
