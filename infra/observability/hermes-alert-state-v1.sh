#!/usr/bin/env bash
# hermes-alert-state-v1.sh — persistent state machine only.
# Transport contract: HERMES_ALERT_NOTIFIER <alert|recovery> <key> <one-line-summary>
# Call chain: probe/postdeploy drill -> this file -> the versioned notifier.
set -euo pipefail
umask 077

ALERT_KEY="${1:?alert key is required}"
EVENT="${2:?event must be failure or recovery}"
SUMMARY="${3:-}"
DRILL_MODE="${NEWME_ALERT_DRILL_MODE:-}"
DRILL_RELEASE_SHA="${NEWME_ALERT_DRILL_RELEASE_SHA:-}"
DRILL_TRIGGER_SHA256="${NEWME_ALERT_DRILL_TRIGGER_SHA256:-}"

case "$EVENT" in
  failure|recovery) ;;
  *) echo "hermes-alert-state-v1: invalid event" >&2; exit 2 ;;
esac

CANONICAL_STATE=/opt/hermes-scripts/observability/hermes-alert-state-v1.sh
CANONICAL_CONFIG=/etc/hermes/observability/hermes-alert-v1.env
CANONICAL_NOTIFIER=/opt/hermes-scripts/observability/hermes-alert-notifier-v1.sh
CANONICAL_STATE_ROOT=/var/lib/newme/hermes-alert-v1
if [ "$0" = "$CANONICAL_STATE" ]; then
  # The installed production state machine has one versioned transport. Tests
  # may inject a notifier only while executing an uninstalled repository copy.
  CONFIG_FILE="$CANONICAL_CONFIG"
  NOTIFIER="$CANONICAL_NOTIFIER"
else
  CONFIG_FILE="${HERMES_ALERT_CONFIG:-$CANONICAL_CONFIG}"
  NOTIFIER="${HERMES_ALERT_NOTIFIER:-$CANONICAL_NOTIFIER}"
fi
if [ -z "$DRILL_MODE$DRILL_RELEASE_SHA$DRILL_TRIGGER_SHA256" ] && [ -r "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

if [ -n "$DRILL_MODE$DRILL_RELEASE_SHA$DRILL_TRIGGER_SHA256" ]; then
  case "$DRILL_MODE:$EVENT" in failure:failure|recovery:recovery) ;; *) echo "hermes-alert-state-v1: invalid drill event" >&2; exit 2 ;; esac
  [[ "$DRILL_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "hermes-alert-state-v1: invalid drill release" >&2; exit 2; }
  [[ "$DRILL_TRIGGER_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "hermes-alert-state-v1: invalid drill challenge" >&2; exit 2; }
  [ "$ALERT_KEY" = "postdeploy-acceptance-$DRILL_RELEASE_SHA" ] || { echo "hermes-alert-state-v1: invalid drill key" >&2; exit 2; }
  THRESHOLD=1
else
  case "$ALERT_KEY" in
    login-probe|dependency-probe|l0-composite-sentry)
      THRESHOLD="${HERMES_L0_ALERT_THRESHOLD:-1}"
      ;;
    *)
      THRESHOLD="${HERMES_ALERT_THRESHOLD:-2}"
      ;;
  esac
fi

if [ "$0" = "$CANONICAL_STATE" ]; then
  if [ -n "$DRILL_MODE$DRILL_RELEASE_SHA$DRILL_TRIGGER_SHA256" ]; then
    EXPECTED_STATE_DIR="$CANONICAL_STATE_ROOT/postdeploy/$DRILL_RELEASE_SHA"
  else
    EXPECTED_STATE_DIR="$CANONICAL_STATE_ROOT/production"
  fi
  STATE_DIR="${HERMES_ALERT_STATE_DIR:-$EXPECTED_STATE_DIR}"
  [ "$STATE_DIR" = "$EXPECTED_STATE_DIR" ] || {
    echo "hermes-alert-state-v1: canonical state directory mismatch" >&2
    exit 1
  }
  for trusted_dir in /var/lib/newme "$CANONICAL_STATE_ROOT" "$(dirname -- "$STATE_DIR")" "$STATE_DIR"; do
    [ -d "$trusted_dir" ] && [ ! -L "$trusted_dir" ] || {
      echo "hermes-alert-state-v1: trusted state directory is missing or symbolic" >&2
      exit 1
    }
    [ "$(stat -c '%U:%G' "$trusted_dir")" = root:root ] || {
      echo "hermes-alert-state-v1: trusted state directory owner mismatch" >&2
      exit 1
    }
    case "$trusted_dir" in
      /var/lib/newme)
        [ $((8#$(stat -c '%a' "$trusted_dir") & 8#022)) -eq 0 ] || {
          echo "hermes-alert-state-v1: trusted state ancestor is writable" >&2
          exit 1
        }
        ;;
      *)
        [ "$(stat -c '%a' "$trusted_dir")" = 700 ] || {
          echo "hermes-alert-state-v1: trusted state directory mode mismatch" >&2
          exit 1
        }
        ;;
    esac
  done
  TRUSTED_STATE=1
else
  STATE_DIR="${HERMES_ALERT_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-/home/ubuntu}/.local/state}/hermes-alert-v1}"
  mkdir -p "$STATE_DIR"
  [ -d "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] || {
    echo "hermes-alert-state-v1: test state directory is invalid" >&2
    exit 1
  }
  TRUSTED_STATE=0
fi
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

SAFE_KEY=$(printf '%s' "$ALERT_KEY" | sed 's/[^A-Za-z0-9_.-]/_/g')
[ "$SAFE_KEY" = "$ALERT_KEY" ] || { echo "hermes-alert-state-v1: unsafe alert key" >&2; exit 2; }
STATE_FILE="$STATE_DIR/$SAFE_KEY.state"
LOCK_FILE="$STATE_FILE.lock"
for state_path in "$STATE_FILE" "$LOCK_FILE"; do
  if [ -e "$state_path" ] || [ -L "$state_path" ]; then
    [ -f "$state_path" ] && [ ! -L "$state_path" ] || {
      echo "hermes-alert-state-v1: persisted state path is untrusted" >&2
      exit 1
    }
    if [ "$TRUSTED_STATE" -eq 1 ]; then
      [ "$(stat -c '%U:%G' "$state_path")" = root:root ] && [ "$(stat -c '%a' "$state_path")" = 600 ] || {
        echo "hermes-alert-state-v1: persisted state metadata is untrusted" >&2
        exit 1
      }
    fi
  fi
done
: >> "$LOCK_FILE"
chmod 0600 "$LOCK_FILE"
exec 9>>"$LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
  flock 9
fi

read_state() {
  STATUS=$(awk -F= '$1 == "status" {print $2}' "$STATE_FILE" 2>/dev/null || true)
  FAILURES=$(awk -F= '$1 == "failure_count" {print $2}' "$STATE_FILE" 2>/dev/null || true)
  STATUS="${STATUS:-ok}"
  FAILURES="${FAILURES:-0}"
  case "$STATUS" in ok|firing|pending_failure|pending_recovery) ;; *) echo "hermes-alert-state-v1: invalid persisted status" >&2; exit 1 ;; esac
  case "$FAILURES" in ''|*[!0-9]*) echo "hermes-alert-state-v1: invalid persisted failure count" >&2; exit 1 ;; esac
}
write_state() {
  local next_status="$1"
  local next_failures="$2"
  local tmp_file
  tmp_file="$(mktemp "$STATE_DIR/.${SAFE_KEY}.state.tmp.XXXXXX")"
  {
    printf 'status=%s\n' "$next_status"
    printf 'failure_count=%s\n' "$next_failures"
  } > "$tmp_file"
  chmod 0600 "$tmp_file"
  mv -fT "$tmp_file" "$STATE_FILE"
  if [ "$TRUSTED_STATE" -eq 1 ]; then
    sync -f "$STATE_FILE"
    sync -f "$STATE_DIR"
  fi
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
  recovery:firing|recovery:pending_failure|recovery:pending_recovery)
    if notify "recovery"; then
      write_state "ok" "0"
      printf 'hermes-alert-state-v1 transition=recovery key=%s\n' "$ALERT_KEY"
    else
      write_state "pending_recovery" "$FAILURES"
      echo "hermes-alert-state-v1: recovery transport failed; retry pending" >&2
      exit 1
    fi
    ;;
  recovery:ok)
    write_state "ok" "0"
    printf 'hermes-alert-state-v1 transition=recovery-suppressed key=%s\n' "$ALERT_KEY"
    ;;
esac
