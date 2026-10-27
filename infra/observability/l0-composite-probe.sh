#!/usr/bin/env bash
# No-cost L0 monitor: aggregate health, login, and dependency probes into the
# single active Sentry Cron seat while preserving each probe's Hermes alerts.
set -u -o pipefail

OBSERVABILITY_DIR="${OBSERVABILITY_DIR:-/opt/hermes-scripts/observability}"
SENTRY_CHECKIN_SCRIPT="${SENTRY_CHECKIN_SCRIPT:-$OBSERVABILITY_DIR/sentry-cron-checkin.sh}"
ALERT_SCRIPT="${HERMES_ALERT_STATE_SCRIPT:-$OBSERVABILITY_DIR/hermes-alert-state-v1.sh}"
INCIDENT_CAPTURE_SCRIPT="${INCIDENT_CAPTURE_SCRIPT:-$OBSERVABILITY_DIR/incident-capture.sh}"
HEALTH_PROBE="${HEALTH_PROBE:-$OBSERVABILITY_DIR/health-check.sh}"
LOGIN_PROBE="${LOGIN_PROBE:-$OBSERVABILITY_DIR/login-probe.sh}"
DEPENDENCY_PROBE="${DEPENDENCY_PROBE:-$OBSERVABILITY_DIR/dependency-probe.sh}"
MONITOR_SLUG=newme-health-check
ALERT_KEY=l0-composite-sentry
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

probe_status=0
sentry_transport_status=0
sentry_started=0

if [ -r "$SENTRY_CHECKIN_SCRIPT" ]; then
  # shellcheck disable=SC1090
  source "$SENTRY_CHECKIN_SCRIPT"
  if sentry_checkin_start "$MONITOR_SLUG"; then
    sentry_started=1
  else
    sentry_transport_status=1
    echo "[$TIMESTAMP] SENTRY_CHECKIN_START_FAIL: composite check-in was not delivered" >&2
  fi
else
  sentry_transport_status=1
  echo "[$TIMESTAMP] SENTRY_LIBRARY_MISSING: $SENTRY_CHECKIN_SCRIPT" >&2
fi

run_probe() {
  local label="$1" script="$2" status=0
  if bash "$script"; then
    echo "[$TIMESTAMP] composite child OK: $label"
  else
    status=$?
    probe_status=1
    echo "[$TIMESTAMP] composite child FAIL: $label exit=$status" >&2
  fi
}

# Always run every child so one early failure cannot hide another L0 signal.
run_probe health "$HEALTH_PROBE"
run_probe login "$LOGIN_PROBE"
run_probe dependency "$DEPENDENCY_PROBE"

if [ "$sentry_started" -eq 1 ]; then
  if ! sentry_checkin_finish "$MONITOR_SLUG" "$probe_status"; then
    sentry_transport_status=1
    echo "[$TIMESTAMP] SENTRY_CHECKIN_FINISH_FAIL: composite completion was not delivered" >&2
  fi
fi

record_sentry_transport() {
  local event="$1" summary="$2" transition="" status=0
  transition="$(bash "$ALERT_SCRIPT" "$ALERT_KEY" "$event" "$summary" 2>&1)" || status=$?
  printf '%s\n' "$transition"
  if printf '%s' "$transition" | grep -q 'capture=1'; then
    "$INCIDENT_CAPTURE_SCRIPT" "$ALERT_KEY" "$summary" &
  fi
  return "$status"
}

alert_status=0
if [ "$sentry_transport_status" -eq 0 ]; then
  record_sentry_transport recovery "composite Sentry transport recovered" || alert_status=$?
else
  record_sentry_transport failure "composite Sentry check-in transport failed" || alert_status=$?
fi

[ "$alert_status" -eq 0 ] || exit "$alert_status"
[ "$sentry_transport_status" -eq 0 ] || exit 1
exit "$probe_status"
