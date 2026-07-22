#!/usr/bin/env bash
# hermes-alert-notifier-v1.sh — executable adapter for the production source library.
# The library itself is source-only; do not execute it as a notifier.
# Contract: <alert|recovery> <source> <detail>
set -euo pipefail

LIBRARY="${HERMES_ALERT_LIBRARY:-/opt/hermes-scripts/observability/hermes-alert.sh}"
EVENT="${1:?event is required}"
SOURCE="${2:?source is required}"
DETAIL="${3:-}"
LEVEL="${HERMES_ALERT_LEVEL:-critical}"

case "$EVENT" in
  alert|recovery) ;;
  *) echo "hermes-alert-notifier-v1: invalid event" >&2; exit 2 ;;
esac
if [ ! -r "$LIBRARY" ]; then
  echo "hermes-alert-notifier-v1: library is not readable: $LIBRARY" >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$LIBRARY"
if ! declare -F hermes_alert >/dev/null 2>&1 || ! declare -F hermes_ok >/dev/null 2>&1; then
  echo "hermes-alert-notifier-v1: production alert functions are unavailable" >&2
  exit 1
fi

if [ "$EVENT" = "alert" ]; then
  hermes_alert "$SOURCE" "$DETAIL" "$LEVEL"
else
  hermes_ok "$SOURCE"
fi
