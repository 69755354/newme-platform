#!/usr/bin/env bash
# Bounded pre-switch load stabilization for canonical production deploys.
# This uses the same one-minute loadavg-per-core signal as health-check.sh,
# but it does not change the steady-state Cron alert or post-switch gates.

set -euo pipefail

HOST_LOADAVG_FILE="${HOST_LOADAVG_FILE:-/proc/loadavg}"
HOST_LOAD_READER="${HOST_LOAD_READER:-}"
HOST_LOAD_NPROC_BIN="${HOST_LOAD_NPROC_BIN:-/usr/bin/nproc}"
HOST_LOAD_AWK_BIN="${HOST_LOAD_AWK_BIN:-/usr/bin/awk}"
HOST_LOAD_SLEEP_BIN="${HOST_LOAD_SLEEP_BIN:-/usr/bin/sleep}"
HOST_LOAD_SETTLE_INTERVAL_SECONDS="${HOST_LOAD_SETTLE_INTERVAL_SECONDS:-10}"
HOST_LOAD_SETTLE_TIMEOUT_SECONDS="${HOST_LOAD_SETTLE_TIMEOUT_SECONDS:-120}"
HOST_LOAD_SETTLE_REQUIRED_SAMPLES="${HOST_LOAD_SETTLE_REQUIRED_SAMPLES:-2}"
HOST_LOAD_SETTLE_THRESHOLD_PCT="${HOST_LOAD_SETTLE_THRESHOLD_PCT:-90}"

fail() {
  echo "host load settle failed: $*" >&2
  exit 1
}

require_positive_integer() {
  local label="$1" value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$label must be a positive integer"
}

require_positive_integer interval "$HOST_LOAD_SETTLE_INTERVAL_SECONDS"
require_positive_integer timeout "$HOST_LOAD_SETTLE_TIMEOUT_SECONDS"
require_positive_integer required_samples "$HOST_LOAD_SETTLE_REQUIRED_SAMPLES"
[[ "$HOST_LOAD_SETTLE_THRESHOLD_PCT" =~ ^[0-9]+$ ]] || fail "threshold must be an integer"
[ "$HOST_LOAD_SETTLE_THRESHOLD_PCT" -le 100 ] || fail "threshold must not exceed 100"
[ -x "$HOST_LOAD_NPROC_BIN" ] || fail "nproc executable is unavailable"
[ -x "$HOST_LOAD_AWK_BIN" ] || fail "awk executable is unavailable"
[ -x "$HOST_LOAD_SLEEP_BIN" ] || fail "sleep executable is unavailable"
if [ -n "$HOST_LOAD_READER" ]; then
  [ -x "$HOST_LOAD_READER" ] || fail "load reader is unavailable"
else
  [ -r "$HOST_LOADAVG_FILE" ] || fail "loadavg is unavailable"
fi

if ! core_count="$("$HOST_LOAD_NPROC_BIN" 2>/dev/null)"; then
  fail "nproc collection failed"
fi
[[ "$core_count" =~ ^[1-9][0-9]*$ ]] || fail "nproc result is invalid"

max_samples=$((HOST_LOAD_SETTLE_TIMEOUT_SECONDS / HOST_LOAD_SETTLE_INTERVAL_SECONDS))
[ "$max_samples" -ge "$HOST_LOAD_SETTLE_REQUIRED_SAMPLES" ] || fail "timeout cannot satisfy required samples"

read_load_value() {
  if [ -n "$HOST_LOAD_READER" ]; then
    "$HOST_LOAD_READER"
  else
    "$HOST_LOAD_AWK_BIN" 'NR == 1 && $1 ~ /^[0-9]+([.][0-9]+)?$/ { print $1; found=1 } END { if (!found) exit 1 }' \
      "$HOST_LOADAVG_FILE" 2>/dev/null
  fi
}

attempt=1
consecutive=0
while [ "$attempt" -le "$max_samples" ]; do
  if ! load_value="$(read_load_value 2>/dev/null)"; then
    fail "loadavg collection failed"
  fi
  [[ "$load_value" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "loadavg result is invalid"
  if ! load_pct="$("$HOST_LOAD_AWK_BIN" -v load_value="$load_value" -v cores="$core_count" \
    'BEGIN { if (cores <= 0) exit 1; printf "%.0f", (load_value / cores) * 100 }')"; then
    fail "normalized load calculation failed"
  fi
  [[ "$load_pct" =~ ^[0-9]+$ ]] || fail "normalized load result is invalid"

  if [ "$load_pct" -le "$HOST_LOAD_SETTLE_THRESHOLD_PCT" ]; then
    consecutive=$((consecutive + 1))
  else
    consecutive=0
  fi
  printf 'host load settle sample=%s/%s load=%s normalized=%s%% consecutive=%s/%s\n' \
    "$attempt" "$max_samples" "$load_value" "$load_pct" "$consecutive" "$HOST_LOAD_SETTLE_REQUIRED_SAMPLES"

  if [ "$consecutive" -ge "$HOST_LOAD_SETTLE_REQUIRED_SAMPLES" ]; then
    echo "host load settled before release switch"
    exit 0
  fi
  if [ "$attempt" -lt "$max_samples" ]; then
    "$HOST_LOAD_SLEEP_BIN" "$HOST_LOAD_SETTLE_INTERVAL_SECONDS" || fail "settle sleep failed"
  fi
  attempt=$((attempt + 1))
done

fail "normalized load remained above ${HOST_LOAD_SETTLE_THRESHOLD_PCT}% within ${HOST_LOAD_SETTLE_TIMEOUT_SECONDS}s"
