#!/usr/bin/env bash
# hermes-alert-state-v1.sh — persistent state machine only.
# Transport contract: HERMES_ALERT_NOTIFIER <alert|recovery> <key> <one-line-summary>
# Call chain: health-check/login-probe -> this file -> the existing notifier.
set -euo pipefail

CONFIG_FILE="${HERMES_ALERT_CONFIG:-/etc/hermes/observability/hermes-alert-v1.env}"
if [ -r "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

ALERT_KEY="${1:?alert key is required}"
EVENT="${2:?event must be failure or recovery}"
SUMMARY="${3:-}"
STATE_DIR="${HERMES_ALERT_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-/home/ubuntu}/.local/state}/hermes-alert-v1}"
case "$ALERT_KEY" in
  login-probe|dependency-probe|l0-composite-sentry)
    THRESHOLD="${HERMES_L0_ALERT_THRESHOLD:-1}"
    ;;
  *)
    THRESHOLD="${HERMES_ALERT_THRESHOLD:-2}"
    ;;
esac
NOTIFIER="${HERMES_ALERT_NOTIFIER:-/opt/hermes-scripts/observability/hermes-alert-notifier-v1.sh}"

case "$EVENT" in
  failure|recovery) ;;
  *) echo "hermes-alert-state-v1: invalid event" >&2; exit 2 ;;
esac
case "$THRESHOLD" in
  ''|*[!0-9]*) echo "hermes-alert-state-v1: invalid threshold" >&2; exit 2 ;;
esac
if [ "$THRESHOLD" -lt 1 ]; then
  echo "hermes-alert-state-v1: threshold must be at least 1" >&2
  exit 2
fi
if [ -z "$NOTIFIER" ] || [ ! -x "$NOTIFIER" ]; then
  echo "hermes-alert-state-v1: notifier is not executable: $NOTIFIER" >&2
  NOTIFIER_READY=0
else
  NOTIFIER_READY=1
fi

mkdir -p "$STATE_DIR"
SAFE_KEY=$(printf '%s' "$ALERT_KEY" | sed 's/[^A-Za-z0-9_.-]/_/g')
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
  if [ "$NOTIFIER_READY" -ne 1 ]; then
    return 1
  fi
  "$NOTIFIER" "$notify_event" "$ALERT_KEY" "$safe_summary"
}

read_state
case "$EVENT:$STATUS" in
  failure:ok)
    FAILURES=$((FAILURES + 1))
    if [ "$FAILURES" -lt "$THRESHOLD" ]; then
      write_state "ok" "$FAILURES"
      printf 'hermes-alert-state-v1 transition=below-threshold key=%s failure_count=%s\n' "$ALERT_KEY" "$FAILURES"
    elif notify "alert"; then
      write_state "firing" "$FAILURES"
      printf 'hermes-alert-state-v1 transition=alert key=%s failure_count=%s capture=1\n' "$ALERT_KEY" "$FAILURES"
    else
      write_state "pending_failure" "$FAILURES"
      printf 'hermes-alert-state-v1 transition=alert-pending key=%s failure_count=%s capture=1\n' "$ALERT_KEY" "$FAILURES"
      echo "hermes-alert-state-v1: alert transport failed; retry pending" >&2
      exit 1
    fi
    ;;
  failure:pending_failure)
    if notify "alert"; then
      write_state "firing" "$FAILURES"
      printf 'hermes-alert-state-v1 transition=alert-retry key=%s failure_count=%s\n' "$ALERT_KEY" "$FAILURES"
    else
      write_state "pending_failure" "$FAILURES"
      echo "hermes-alert-state-v1: alert transport failed; retry pending" >&2
      exit 1
    fi
    ;;
  failure:firing)
    FAILURES=$((FAILURES + 1))
    write_state "firing" "$FAILURES"
    printf 'hermes-alert-state-v1 transition=duplicate-suppressed key=%s failure_count=%s\n' "$ALERT_KEY" "$FAILURES"
    ;;
  recovery:firing|recovery:pending_recovery)
    if notify "recovery"; then
      write_state "ok" "0"
      printf 'hermes-alert-state-v1 transition=recovery key=%s\n' "$ALERT_KEY"
    else
      write_state "pending_recovery" "$FAILURES"
      echo "hermes-alert-state-v1: recovery transport failed; retry pending" >&2
      exit 1
    fi
    ;;
  recovery:pending_failure)
    write_state "ok" "0"
    printf 'hermes-alert-state-v1 transition=recovery-suppressed key=%s\n' "$ALERT_KEY"
    ;;
  recovery:ok)
    write_state "ok" "0"
    printf 'hermes-alert-state-v1 transition=recovery-suppressed key=%s\n' "$ALERT_KEY"
    ;;
esac
