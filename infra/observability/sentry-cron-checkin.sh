#!/usr/bin/env bash
# Sentry Cron check-in transport. This file is sourced by production probes.
# It returns non-zero on every configuration or delivery failure; callers must
# route that failure through the independent Hermes notifier.

SENTRY_ENV_FILE="${SENTRY_ENV_FILE:-/opt/newme/current/.env.local}"
SENTRY_DSN_FILE="${SENTRY_DSN_FILE:-/home/ubuntu/.hermes/credentials/sentry-dsn.txt}"
SENTRY_CHECKIN_ENVIRONMENT="${SENTRY_CHECKIN_ENVIRONMENT:-production}"
CHECKIN_ID="${CHECKIN_ID:-}"

# SENTRY_DSN may arrive as an exported service environment variable. Keep the
# value available to this sourced library, but never pass a private DSN to curl
# or any other child process through its environment.
export -n SENTRY_DSN 2>/dev/null || true

read_env_value() {
  local key="$1" file="$2"
  [ -r "$file" ] || return 1
  python3 - "$file" "$key" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
wanted = sys.argv[2]
key_pattern = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
try:
    values = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ValueError
        parsed_key, value = line.split("=", 1)
        parsed_key = parsed_key.strip()
        value = value.strip()
        if not key_pattern.fullmatch(parsed_key) or parsed_key in values:
            raise ValueError
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[parsed_key] = value
    value = values.get(wanted, "")
    if not value:
        raise ValueError
except (OSError, UnicodeError, ValueError):
    raise SystemExit(1)
print(value)
PY
}

resolve_sentry_dsn() {
  export -n SENTRY_DSN 2>/dev/null || true
  if [ -z "${SENTRY_DSN:-}" ] && [ -r "$SENTRY_DSN_FILE" ]; then
    SENTRY_DSN="$(tr -d '\r\n' < "$SENTRY_DSN_FILE")"
    export -n SENTRY_DSN 2>/dev/null || true
  fi
  if [ -z "${SENTRY_DSN:-}" ]; then
    SENTRY_DSN="$(read_env_value SENTRY_DSN "$SENTRY_ENV_FILE" || true)"
    export -n SENTRY_DSN 2>/dev/null || true
  fi
  if [ -z "${SENTRY_DSN:-}" ]; then
    SENTRY_DSN="$(read_env_value NEXT_PUBLIC_SENTRY_DSN "$SENTRY_ENV_FILE" || true)"
    export -n SENTRY_DSN 2>/dev/null || true
  fi
  SENTRY_DSN="${SENTRY_DSN%\"}"
  SENTRY_DSN="${SENTRY_DSN#\"}"
  export -n SENTRY_DSN 2>/dev/null || true
  [ -n "$SENTRY_DSN" ] && [[ "$SENTRY_DSN" != *...* ]]
}

parse_dsn() {
  local xtrace_was_on=0
  case "$-" in
    *x*) xtrace_was_on=1; set +x ;;
  esac
  if ! resolve_sentry_dsn; then
    echo "sentry check-in DSN is unavailable" >&2
    [ "$xtrace_was_on" -eq 0 ] || set -x
    return 1
  fi
  local dsn_pattern='^https://([0-9a-f]{32})(:[0-9a-f]{32})?@([a-z0-9-]+[.]ingest([.][a-z0-9-]+)*[.]sentry[.]io)/([0-9]+)/*$'
  if [[ ! "$SENTRY_DSN" =~ $dsn_pattern ]]; then
    echo "sentry check-in DSN is malformed" >&2
    [ "$xtrace_was_on" -eq 0 ] || set -x
    return 1
  fi
  # A private Sentry DSN contains public:secret userinfo. Cron ingestion accepts
  # only the public project key in the path, never the private DSN password.
  SENTRY_KEY="${BASH_REMATCH[1]}"
  SENTRY_HOST="${BASH_REMATCH[3]}"
  SENTRY_PROJECT_ID="${BASH_REMATCH[5]}"
  [ "$xtrace_was_on" -eq 0 ] || set -x
}

new_checkin_id() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    tr -d '\r\n' < /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    echo "sentry check-in UUID generator is unavailable" >&2
    return 1
  fi
}

send_checkin() {
  local monitor_slug="$1" status="$2" checkin_id="$3"
  local http_code="" curl_status=0
  [[ "$monitor_slug" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || {
    echo "sentry monitor slug is invalid" >&2
    return 1
  }
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
    "https://${SENTRY_HOST}/api/${SENTRY_PROJECT_ID}/cron/${monitor_slug}/${SENTRY_KEY}/" \
    -H 'Content-Type: application/json' \
    -d "{\"status\":\"${status}\",\"check_in_id\":\"${checkin_id}\",\"environment\":\"${SENTRY_CHECKIN_ENVIRONMENT}\"}" \
    2>/dev/null)" || curl_status=$?
  if [ "$curl_status" -ne 0 ] || [ "$http_code" != 202 ]; then
    echo "sentry check-in delivery failed: HTTP ${http_code:-000}" >&2
    return 1
  fi
}

sentry_checkin_start() {
  local monitor_slug="$1"
  parse_dsn || return 1
  CHECKIN_ID="$(new_checkin_id)" || return 1
  send_checkin "$monitor_slug" in_progress "$CHECKIN_ID"
}

sentry_checkin_finish() {
  local monitor_slug="$1" exit_code="${2:-0}" status=ok
  [ -n "${CHECKIN_ID:-}" ] || { echo "sentry check-in was not started" >&2; return 1; }
  [ "$exit_code" -eq 0 ] || status=error
  parse_dsn || return 1
  send_checkin "$monitor_slug" "$status" "$CHECKIN_ID"
}
