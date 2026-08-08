#!/usr/bin/env bash
# Production host and service health probe.
set -u -o pipefail

ALERT_SCRIPT="${HERMES_ALERT_STATE_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
HOSTNAME_VALUE="$(hostname)"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
ALERTS=""

DISK_PCT="$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
if [ "$DISK_PCT" -gt 90 ]; then
  ALERTS="${ALERTS}[DISK_CRITICAL] root filesystem ${DISK_PCT}%\n"
elif [ "$DISK_PCT" -gt 80 ]; then
  ALERTS="${ALERTS}[DISK_WARN] root filesystem ${DISK_PCT}%\n"
fi

MEM_PCT="$(free | awk '/Mem:/ { printf "%.0f", $3 / $2 * 100 }')"
if [ "$MEM_PCT" -gt 85 ]; then
  ALERTS="${ALERTS}[MEM_CRITICAL] memory ${MEM_PCT}%\n"
elif [ "$MEM_PCT" -gt 75 ]; then
  ALERTS="${ALERTS}[MEM_WARN] memory ${MEM_PCT}%\n"
fi

CPU_LOAD="$(uptime | awk -F'load average:' '{ print $2 }' | awk -F',' '{ print $1 }' | xargs)"
CORES="$(nproc)"
CPU_PCT="$(awk -v load="$CPU_LOAD" -v cores="$CORES" 'BEGIN { printf "%.0f", load / cores * 100 }')"
if [ "$CPU_PCT" -gt 90 ]; then
  ALERTS="${ALERTS}[CPU_CRITICAL] load ${CPU_LOAD} (${CPU_PCT}%)\n"
fi

PROC_COUNT="$(ps aux | wc -l)"
if [ "$PROC_COUNT" -gt 500 ]; then
  ALERTS="${ALERTS}[PROC_WARN] process count ${PROC_COUNT}\n"
fi

if ! curl -sf --max-time 5 http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
  ALERTS="${ALERTS}[SERVICE_DOWN] newme-platform:3001 unavailable\n"
fi

for service in hermes-bridge hermes-dashboard hermes-worker; do
  if ! systemctl is-active --quiet "$service" 2>/dev/null; then
    ALERTS="${ALERTS}[HERMES_DOWN] ${service} inactive\n"
  fi
done

record_alert() {
  local event="$1" summary="$2" transition="" status=0
  transition="$(bash "$ALERT_SCRIPT" health-check "$event" "$summary" 2>&1)" || status=$?
  printf '%s\n' "$transition"
  if printf '%s' "$transition" | grep -q 'capture=1'; then
    /opt/hermes-scripts/observability/incident-capture.sh health-check "$summary" &
  fi
  [ "$status" -eq 0 ] || echo "[$TIMESTAMP] ALERT_STATE_FAILED: retry pending" >&2
  return "$status"
}

probe_status=0
[ -z "$ALERTS" ] || probe_status=1

alert_status=0
if [ "$probe_status" -eq 0 ]; then
  record_alert recovery "health checks recovered" || alert_status=$?
  echo "[$TIMESTAMP] $HOSTNAME_VALUE OK disk=${DISK_PCT}% mem=${MEM_PCT}% cpu=${CPU_PCT}% proc=${PROC_COUNT}"
else
  summary="$(printf '%b' "$ALERTS" | sed -n '1p')"
  printf '[$TIMESTAMP] %s ALERTS:\n%b' "$HOSTNAME_VALUE" "$ALERTS"
  record_alert failure "$summary" || alert_status=$?
fi

[ "$alert_status" -eq 0 ] || exit "$alert_status"
exit "$probe_status"
