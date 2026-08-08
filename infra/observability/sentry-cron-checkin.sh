#!/usr/bin/env bash
# Sentry Cron check-in transport. This file is sourced by production probes.
# It returns non-zero on every configuration or delivery failure; callers must
# route that failure through the independent Hermes notifier.

SENTRY_ENV_FILE="${SENTRY_ENV_FILE:-/opt/newme/current/.env.local}"
SENTRY_DSN_FILE="${SENTRY_DSN_FILE:-/home/ubuntu/.hermes/credentials/sentry-dsn.txt}"
SENTRY_CHECKIN_ENVIRONMENT="${SENTRY_CHECKIN_ENVIRONMENT:-production}"
CHECKIN_ID="${CHECKIN_ID:-}"

read_env_value() {
  local key="$1" file="$2"
  [ -r "$file" ] || return 1
  awk -F= -v wanted="$key" '
    $1 == wanted { value = substr($0, index($0, "=") + 1) }
    END { if (value != "") print value }
  ' "$file" | tr -d '\r'
}

resolve_sentry_dsn() {
  if [ -z "${SENTRY_DSN:-}" ] && [ -r "$SENTRY_DSN_FILE" ]; then
    SENTRY_DSN="$(tr -d '\r\n' < "$SENTRY_DSN_FILE")"
  fi
  if [ -z "${SENTRY_DSN:-}" ]; then
    SENTRY_DSN="$(read_env_value SENTRY_DSN "$SENTRY_ENV_FILE" || true)"
  fi
  if [ -z "${SENTRY_DSN:-}" ]; then
    SENTRY_DSN="$(read_env_value NEXT_PUBLIC_SENTRY_DSN "$SENTRY_ENV_FILE" || true)"
  fi
  SENTRY_DSN="${SENTRY_DSN%\"}"
  SENTRY_DSN="${SENTRY_DSN#\"}"
  [ -n "$SENTRY_DSN" ] && ! printf '%s' "$SENTRY_DSN" | grep -q '\.\.\.'
}

parse_dsn() {
  resolve_sentry_dsn || { echo "sentry check-in DSN is unavailable" >&2; return 1; }
  SENTRY_KEY="$(printf '%s' "$SENTRY_DSN" | sed -n 's|https://\([^@]*\)@.*|\1|p')"
  SENTRY_HOST="$(printf '%s' "$SENTRY_DSN" | sed -n 's|https://[^@]*@\([^/]*\).*|\1|p')"
  SENTRY_PROJECT_ID="$(printf '%s' "$SENTRY_DSN" | sed -n 's|.*/\([0-9][0-9]*\)$|\1|p')"
  [ -n "$SENTRY_KEY" ] && [ -n "$SENTRY_HOST" ] && [ -n "$SENTRY_PROJECT_ID" ] || {
    echo "sentry check-in DSN is malformed" >&2
    return 1
  }
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
