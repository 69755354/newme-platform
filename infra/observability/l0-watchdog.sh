#!/usr/bin/env bash
# Independent watchdog for the L0 probe (S7, review 5-logging-monitoring F1).
# The probe runs under `flock -n`; if a run hangs, later cron runs skip silently
# and neither Sentry nor the Telegram state machine hear about it. This job runs
# every minute outside that lock and raises an alert through the SAME state
# machine when the probe's heartbeat file is older than L0_STALE_SECONDS.
set -u -o pipefail

HEARTBEAT_FILE="${L0_HEARTBEAT_FILE:-/run/newme-l0.heartbeat}"
STALE_SECONDS="${L0_STALE_SECONDS:-420}"
ALERT_SCRIPT="${HERMES_ALERT_STATE_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
ALERT_KEY=l0-heartbeat-stale
NOW="${L0_WATCHDOG_NOW:-$(date +%s)}"

last=""
[ -r "$HEARTBEAT_FILE" ] && last="$(tr -dc '0-9' < "$HEARTBEAT_FILE" | head -c 12)"

if [ -z "$last" ]; then
  # No heartbeat yet (fresh boot): give the first runs a chance before alarming.
  uptime_seconds="$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)"
  if [ "${L0_WATCHDOG_IGNORE_UPTIME:-0}" != 1 ] && [ "$uptime_seconds" -lt "$STALE_SECONDS" ]; then exit 0; fi
  age=$STALE_SECONDS
  detail="L0 probe has never written a heartbeat"
else
  age=$((NOW - last))
  detail="L0 probe heartbeat is ${age}s old (limit ${STALE_SECONDS}s); a run is probably stuck holding its lock"
fi

if [ "$age" -ge "$STALE_SECONDS" ]; then
  bash "$ALERT_SCRIPT" "$ALERT_KEY" failure "$detail"
else
  bash "$ALERT_SCRIPT" "$ALERT_KEY" recovery "L0 probe heartbeat is fresh again"
fi
