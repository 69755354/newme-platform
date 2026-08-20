#!/usr/bin/env bash
# Production host and service health probe.
set -u -o pipefail

ALERT_SCRIPT="${HERMES_ALERT_STATE_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
LOADAVG_FILE="${LOADAVG_FILE:-/proc/loadavg}"
HOSTNAME_VALUE="$(hostname)"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
ALERTS=""

add_alert() {
  ALERTS="${ALERTS}[$1] $2\n"
}

DISK_PCT="unknown"
if disk_value="$(df -P / 2>/dev/null | awk 'NR == 2 { gsub(/%/, "", $5); print $5; found=1 } END { if (!found) exit 1 }')" &&
  [[ "$disk_value" =~ ^[0-9]+$ ]]; then
  DISK_PCT="$disk_value"
  if [ "$DISK_PCT" -gt 90 ]; then
    add_alert DISK_CRITICAL "root filesystem ${DISK_PCT}%"
  elif [ "$DISK_PCT" -gt 80 ]; then
    add_alert DISK_WARN "root filesystem ${DISK_PCT}%"
  fi
else
  add_alert PROBE_ERROR "disk metric collection failed"
fi

MEM_PCT="unknown"
if mem_value="$(free 2>/dev/null | awk '/^Mem:/ && $2 > 0 { printf "%.0f", $3 / $2 * 100; found=1 } END { if (!found) exit 1 }')" &&
  [[ "$mem_value" =~ ^[0-9]+$ ]]; then
  MEM_PCT="$mem_value"
  if [ "$MEM_PCT" -gt 85 ]; then
    add_alert MEM_CRITICAL "memory ${MEM_PCT}%"
  elif [ "$MEM_PCT" -gt 75 ]; then
    add_alert MEM_WARN "memory ${MEM_PCT}%"
  fi
else
  add_alert PROBE_ERROR "memory metric collection failed"
fi

CPU_LOAD="unknown"
CPU_PCT="unknown"
if cpu_load_value="$(awk 'NR == 1 && $1 ~ /^[0-9]+([.][0-9]+)?$/ { print $1; found=1 } END { if (!found) exit 1 }' "$LOADAVG_FILE" 2>/dev/null)" &&
  core_value="$(nproc 2>/dev/null)" && [[ "$core_value" =~ ^[1-9][0-9]*$ ]] &&
  cpu_pct_value="$(awk -v load_value="$cpu_load_value" -v cores="$core_value" 'BEGIN { printf "%.0f", load_value / cores * 100 }')" &&
  [[ "$cpu_pct_value" =~ ^[0-9]+$ ]]; then
  CPU_LOAD="$cpu_load_value"
  CPU_PCT="$cpu_pct_value"
  if [ "$CPU_PCT" -gt 90 ]; then
    add_alert CPU_CRITICAL "load ${CPU_LOAD} (${CPU_PCT}%)"
  fi
else
  add_alert PROBE_ERROR "CPU metric collection failed"
fi

PROC_COUNT="unknown"
if proc_value="$(ps aux 2>/dev/null | wc -l)" && [[ "$proc_value" =~ ^[0-9]+$ ]]; then
  PROC_COUNT="$proc_value"
  if [ "$PROC_COUNT" -gt 500 ]; then
    add_alert PROC_WARN "process count ${PROC_COUNT}"
  fi
else
  add_alert PROBE_ERROR "process metric collection failed"
fi

if ! curl -sf --max-time 5 http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
  ALERTS="${ALERTS}[SERVICE_DOWN] newme-platform:3001 unavailable\n"
fi

# A masked unit is an operator declaration that it must not run, so asserting
# its liveness would be a permanent false positive. Only an explicit mask counts:
# a missing or merely disabled unit still alerts, so a failed asset install
# cannot hide here.
for service in hermes-bridge hermes-dashboard hermes-worker; do
  service_enablement="$(systemctl is-enabled "$service" 2>/dev/null)" || true
  case "$service_enablement" in
    masked | masked-runtime)
      echo "[$TIMESTAMP] retired service skipped: ${service} (${service_enablement})"
      continue
      ;;
  esac
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
  printf '[%s] %s ALERTS:\n%b' "$TIMESTAMP" "$HOSTNAME_VALUE" "$ALERTS"
  record_alert failure "$summary" || alert_status=$?
fi

[ "$alert_status" -eq 0 ] || exit "$alert_status"
exit "$probe_status"
