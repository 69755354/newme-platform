#!/usr/bin/env bash
# Runs the daily Meta lead reconciliation and reports through the existing
# Hermes alert state machine (same Telegram path as the L0 probes). Meant to be
# started by newme-meta-reconcile.service, which supplies the runtime environment.
set -u -o pipefail
ALERT_SCRIPT="${HERMES_ALERT_STATE_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
SCRIPT="${META_RECONCILE_SCRIPT:-/opt/newme/current/scripts/meta-reconcile.mjs}"
KEY=meta-lead-reconcile

output="$(timeout -k 10 240 "$NODE_BIN" "$SCRIPT" 2>&1)"
status=$?
# One line only; the script prints counts and reason codes, never lead data.
line="$(printf '%s' "$output" | tail -n 1 | tr -d '\r' | cut -c1-300)"
if [ "$status" -eq 0 ]; then
  bash "$ALERT_SCRIPT" "$KEY" recovery "Meta lead reconciliation OK: $line"
else
  bash "$ALERT_SCRIPT" "$KEY" failure "Meta lead reconciliation: ${line:-no output (exit $status)}"
fi
printf '%s\n' "$line"
exit "$status"
