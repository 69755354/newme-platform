#!/usr/bin/env bash
# hermes-alert.sh — persistent alert state and one-shot transitions
# Usage: hermes-alert.sh <alert-key> <failure|recovery> <summary>
set -euo pipefail

ALERT_KEY="${1:?alert key is required}"
EVENT="${2:?event must be failure or recovery}"
SUMMARY="${3:-}"
STATE_DIR="${HERMES_ALERT_STATE_DIR:-/var/lib/hermes/alerts}"
THRESHOLD="${HERMES_ALERT_THRESHOLD:-1}"
NOTIFIER="${HERMES_ALERT_COMMAND:-}"
WEBHOOK="${HERMES_ALERT_WEBHOOK_URL:-}"

case "$EVENT" in
  failure|recovery) ;;
  *) echo "hermes-alert: invalid event" >&2; exit 2 ;;
esac
case "$THRESHOLD" in
  ''|*[!0-9]*) echo "hermes-alert: invalid threshold" >&2; exit 2 ;;
esac
if [ "$THRESHOLD" -lt 1 ]; then
  echo "hermes-alert: threshold must be at least 1" >&2
  exit 2
fi

mkdir -p "$STATE_DIR"
SAFE_KEY=$(printf '%s' "$ALERT_KEY" | tr -c 'A-Za-z0-9_.-' '_')
STATE_FILE="$STATE_DIR/$SAFE_KEY.state"
LOCK_FILE="$STATE_FILE.lock"
exec 9>"$LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
  flock 9
fi

read_state() {
  STATUS=$(awk -F= '$1 == "status" {print $2}' "$STATE_FILE" 2>/dev/null || true)
  FAILURES=$(awk -F= '$1 == "failure_count" {print $2}' "$STATE_FILE" 2>/dev/null || true)
  STATUS="${STATUS:-ok}"
  FAILURES="${FAILURES:-0}"
}
write_state() {
  local next_status="$1"
  local next_failures="$2"
  local tmp_file="${STATE_FILE}.$$"
  {
    printf 'status=%s\n' "$next_status"
    printf 'failure_count=%s\n' "$next_failures"
  } > "$tmp_file"
  mv -f "$tmp_file" "$STATE_FILE"
}
safe_summary=$(printf '%s' "$SUMMARY" | tr '\r\n' '  ')

notify() {
  local notify_event="$1"
  local payload
  payload=$(printf 'event=%s\nkey=%s\nfailure_count=%s\nsummary=%s\n' "$notify_event" "$ALERT_KEY" "$FAILURES" "$safe_summary")
  if [ -n "$NOTIFIER" ]; then
    printf '%s' "$payload" | "$NOTIFIER" >/dev/null 2>&1 || true
  elif [ -n "$WEBHOOK" ] && command -v curl >/dev/null 2>&1; then
    printf '%s' "$payload" | curl -fsS --max-time 5 -X POST \
      -H 'Content-Type: text/plain; charset=utf-8' --data-binary @- "$WEBHOOK" >/dev/null 2>&1 || true
  fi
}

read_state
case "$EVENT:$STATUS" in
  failure:ok)
    FAILURES=$((FAILURES + 1))
    if [ "$FAILURES" -ge "$THRESHOLD" ]; then
      notify "alert"
      write_state "firing" "$FAILURES"
      printf 'hermes-alert transition=alert key=%s failure_count=%s\n' "$ALERT_KEY" "$FAILURES"
    else
      write_state "ok" "$FAILURES"
      printf 'hermes-alert transition=below-threshold key=%s failure_count=%s\n' "$ALERT_KEY" "$FAILURES"
    fi
    ;;
  failure:firing)
    FAILURES=$((FAILURES + 1))
    write_state "firing" "$FAILURES"
    printf 'hermes-alert transition=duplicate-suppressed key=%s failure_count=%s\n' "$ALERT_KEY" "$FAILURES"
    ;;
  recovery:firing)
    notify "recovery"
    write_state "ok" "0"
    printf 'hermes-alert transition=recovery key=%s\n' "$ALERT_KEY"
    ;;
  recovery:ok)
    write_state "ok" "0"
    printf 'hermes-alert transition=recovery-suppressed key=%s\n' "$ALERT_KEY"
    ;;
esac
