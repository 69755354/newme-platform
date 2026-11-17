#!/bin/sh
# NewMe operational alert sender: WhatsApp Business Cloud API template messages (S17, B-3).
#
#   newme-whatsapp-alert.sh <key> <failure|recovery|info> <one-line summary>
#
# Same call contract as the old alert state machine (key, event, summary), so backup, freshness,
# watchdog, cron and probe scripts can call it unchanged.
#   failure   sent at once, then repeated at most every ALERT_REPEAT_HOURS while the key stays open
#   recovery  sent only if a failure for the same key was delivered before, then closes the key
#   info      always sent, no state (daily "still alive" notes)
#
# Config: /etc/newme/alerts.env (ALERT_ENV_FILE), owned by the running user, mode 600 or 400.
# Values already in the environment win over the file. Nothing secret lives in this repository.
#   ALERT_WHATSAPP_ACCESS_TOKEN     permanent system-user token of the WhatsApp Business account
#   ALERT_WHATSAPP_PHONE_NUMBER_ID  phone_number_id of the company's existing WhatsApp Business number
#   ALERT_WHATSAPP_RECIPIENTS       comma separated numbers, international format (Sam, Tanya)
#   ALERT_WHATSAPP_TEMPLATE         approved template name, default newme_ops_alert
#   ALERT_WHATSAPP_LANGUAGE         template language code, default zh_CN
#   ALERT_WHATSAPP_API_VERSION      Graph API version, default v26.0 (same as the review tools)
#   ALERT_STATE_DIR                 default /var/lib/newme-alerts (state files and alerts.log)
#   ALERT_REPEAT_HOURS              default 6
#   ALERT_CHANNEL                   whatsapp (default) or telegram (optional, TELEGRAM_BOT_TOKEN/CHAT_ID)
#
# Exit status: 0 delivered (or nothing to send), 1 delivery failed, 2 usage or configuration error.
# Delivery is judged by the HTTP status AND the message id in the answer; every attempt leaves one
# line in $ALERT_STATE_DIR/alerts.log and a failure also goes to stderr (the systemd journal).
set -u
umask 077

KEY="${1:-}"
EVENT="${2:-}"
SUMMARY="${3:-}"

ENV_FILE="${ALERT_ENV_FILE:-/etc/newme/alerts.env}"
if [ -e "$ENV_FILE" ]; then
  if command -v stat >/dev/null 2>&1; then
    mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo "")"
    case "$mode" in
      400|600) ;;
      *) echo "newme-whatsapp-alert: $ENV_FILE must be mode 400 or 600 (is ${mode:-unknown})" >&2; exit 2 ;;
    esac
    if [ "$(stat -c '%u' "$ENV_FILE" 2>/dev/null || echo x)" != "$(id -u)" ]; then
      echo "newme-whatsapp-alert: $ENV_FILE must be owned by the running user" >&2; exit 2
    fi
  fi
  # Environment values already set win over the file.
  while IFS='=' read -r name value; do
    case "$name" in
      ALERT_WHATSAPP_ACCESS_TOKEN|ALERT_WHATSAPP_PHONE_NUMBER_ID|ALERT_WHATSAPP_RECIPIENTS|ALERT_WHATSAPP_TEMPLATE|ALERT_WHATSAPP_LANGUAGE|ALERT_WHATSAPP_API_VERSION|ALERT_STATE_DIR|ALERT_REPEAT_HOURS|ALERT_CHANNEL|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)
        eval "current=\${$name:-}"
        if [ -z "$current" ]; then
          value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
          export "$name=$value"
        fi
        ;;
    esac
  done < "$ENV_FILE"
fi

CHANNEL="${ALERT_CHANNEL:-whatsapp}"
STATE_DIR="${ALERT_STATE_DIR:-/var/lib/newme-alerts}"
REPEAT_HOURS="${ALERT_REPEAT_HOURS:-6}"
API_VERSION="${ALERT_WHATSAPP_API_VERSION:-v26.0}"
TEMPLATE="${ALERT_WHATSAPP_TEMPLATE:-newme_ops_alert}"
LANGUAGE="${ALERT_WHATSAPP_LANGUAGE:-zh_CN}"
NOW="${ALERT_NOW:-$(date +%s)}"

fail_usage() { echo "newme-whatsapp-alert: $1" >&2; exit 2; }

case "$EVENT" in failure|recovery|info) ;; *) fail_usage "event must be failure, recovery or info" ;; esac
case "$KEY" in ''|*[!A-Za-z0-9_.-]*) fail_usage "key must be 1-100 characters of letters, digits, dot, dash, underscore" ;; esac
[ "${#KEY}" -le 100 ] || fail_usage "key is too long"
case "$REPEAT_HOURS" in ''|*[!0-9]*) fail_usage "ALERT_REPEAT_HOURS must be a number" ;; esac
case "$CHANNEL" in whatsapp|telegram) ;; *) fail_usage "ALERT_CHANNEL must be whatsapp or telegram" ;; esac

api_base_ok() {
  case "$1" in
    https://*) return 0 ;;
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$CHANNEL" = whatsapp ]; then
  API_BASE="${ALERT_WHATSAPP_API_BASE:-https://graph.facebook.com}"
  api_base_ok "$API_BASE" || fail_usage "ALERT_WHATSAPP_API_BASE must be https"
  [ -n "${ALERT_WHATSAPP_ACCESS_TOKEN:-}" ] || fail_usage "ALERT_WHATSAPP_ACCESS_TOKEN is not set"
  [ -n "${ALERT_WHATSAPP_PHONE_NUMBER_ID:-}" ] || fail_usage "ALERT_WHATSAPP_PHONE_NUMBER_ID is not set"
  case "$ALERT_WHATSAPP_PHONE_NUMBER_ID" in *[!0-9]*) fail_usage "ALERT_WHATSAPP_PHONE_NUMBER_ID must be digits" ;; esac
  case "$ALERT_WHATSAPP_ACCESS_TOKEN" in *[!A-Za-z0-9_.~+/=-]*) fail_usage "ALERT_WHATSAPP_ACCESS_TOKEN has unexpected characters" ;; esac
  [ -n "${ALERT_WHATSAPP_RECIPIENTS:-}" ] || fail_usage "ALERT_WHATSAPP_RECIPIENTS is not set"
  case "$TEMPLATE" in ''|*[!a-z0-9_]*) fail_usage "ALERT_WHATSAPP_TEMPLATE must be lowercase letters, digits, underscore" ;; esac
  case "$LANGUAGE" in ''|*[!A-Za-z_]*) fail_usage "ALERT_WHATSAPP_LANGUAGE is invalid" ;; esac
  case "$API_VERSION" in v[0-9]*) ;; *) fail_usage "ALERT_WHATSAPP_API_VERSION is invalid" ;; esac
  RECIPIENTS=""
  for raw in $(printf '%s' "$ALERT_WHATSAPP_RECIPIENTS" | tr ',;' '  '); do
    number="$(printf '%s' "$raw" | sed 's/^+//')"
    case "$number" in
      ''|*[!0-9]*) fail_usage "ALERT_WHATSAPP_RECIPIENTS has an entry that is not an international number" ;;
    esac
    if [ "${#number}" -lt 7 ] || [ "${#number}" -gt 15 ]; then fail_usage "ALERT_WHATSAPP_RECIPIENTS has an entry with a wrong length"; fi
    RECIPIENTS="$RECIPIENTS $number"
  done
  [ -n "$RECIPIENTS" ] || fail_usage "ALERT_WHATSAPP_RECIPIENTS is empty"
else
  API_BASE="${ALERT_TELEGRAM_API_BASE:-https://api.telegram.org}"
  api_base_ok "$API_BASE" || fail_usage "ALERT_TELEGRAM_API_BASE must be https"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then fail_usage "telegram is not configured"; fi
  case "$TELEGRAM_BOT_TOKEN" in *[!A-Za-z0-9_:.-]*) fail_usage "TELEGRAM_BOT_TOKEN has unexpected characters" ;; esac
fi

if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  echo "newme-whatsapp-alert: cannot create $STATE_DIR (log and state disabled)" >&2
  STATE_OK=0
else
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  STATE_OK=1
fi
LOG_FILE="$STATE_DIR/alerts.log"
STATE_FILE="$STATE_DIR/$KEY.state"

log_line() {
  [ "$STATE_OK" = 1 ] || return 0
  printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$KEY" "$EVENT" "$1" >> "$LOG_FILE" 2>/dev/null || true
}

# State: a failure that was delivered leaves "alerted_at=<epoch>".
alerted_at=""
if [ "$STATE_OK" = 1 ] && [ -r "$STATE_FILE" ]; then
  alerted_at="$(sed -n 's/^alerted_at=\([0-9]*\)$/\1/p' "$STATE_FILE" | head -n 1)"
fi
case "$EVENT" in
  failure)
    if [ -n "$alerted_at" ] && [ $((NOW - alerted_at)) -lt $((REPEAT_HOURS * 3600)) ]; then
      log_line "suppressed (alert already open, repeat every ${REPEAT_HOURS}h)"
      exit 0
    fi
    LABEL="故障" ;;
  recovery)
    if [ -z "$alerted_at" ]; then exit 0; fi
    LABEL="恢复" ;;
  info) LABEL="通知" ;;
esac

# One line, no tabs, no runs of spaces (WhatsApp template parameters reject them), at most 400 characters.
clean_text() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\010\013\014\016-\037' | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-400
}
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

TEXT="$(clean_text "$SUMMARY")"
[ -n "$TEXT" ] || TEXT="-"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/newme-alert.XXXXXX")" || { echo "newme-whatsapp-alert: cannot create a work directory" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT INT TERM HUP

mask() { n="$1"; printf '***%s' "$(printf '%s' "$n" | tail -c 4)"; }

DELIVERY_FAILED=0
report_failure() {
  # $1 = what failed (no secrets)
  DELIVERY_FAILED=1
  log_line "FAILED $1"
  echo "newme-whatsapp-alert: $KEY $EVENT delivery FAILED: $1" >&2
}

error_detail() {
  code="$(sed -n 's/.*"code":\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | head -n 1)"
  msg="$(sed -n 's/.*"message":"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1 | cut -c1-120)"
  printf '%s%s' "${code:+code $code }" "$msg"
}

if [ "$CHANNEL" = whatsapp ]; then
  for number in $RECIPIENTS; do
    label_json="$(json_escape "$LABEL")"; key_json="$(json_escape "$KEY")"; text_json="$(json_escape "$TEXT")"
    cat > "$WORK/body.json" <<JSON
{"messaging_product":"whatsapp","to":"$number","type":"template","template":{"name":"$TEMPLATE","language":{"code":"$LANGUAGE"},"components":[{"type":"body","parameters":[{"type":"text","text":"$label_json"},{"type":"text","text":"$key_json"},{"type":"text","text":"$text_json"}]}]}}
JSON
    # The token travels in a curl config on stdin, never in the argument list.
    printf 'url = "%s/%s/%s/messages"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
      "$API_BASE" "$API_VERSION" "$ALERT_WHATSAPP_PHONE_NUMBER_ID" "$ALERT_WHATSAPP_ACCESS_TOKEN" > "$WORK/curl.conf"
    http_code="$(curl -sS -m 20 -K "$WORK/curl.conf" -o "$WORK/resp.json" -w '%{http_code}' --data-binary "@$WORK/body.json" 2>"$WORK/curl.err")" || http_code="000"
    case "$http_code" in
      2??)
        if grep -q '"messages"' "$WORK/resp.json" 2>/dev/null && grep -q '"id"' "$WORK/resp.json" 2>/dev/null; then
          log_line "delivered to $(mask "$number") HTTP $http_code"
        else
          report_failure "HTTP $http_code without a message id for $(mask "$number")"
        fi ;;
      000) report_failure "no HTTP answer for $(mask "$number"): $(head -c 120 "$WORK/curl.err" | tr '\n' ' ')" ;;
      *) report_failure "HTTP $http_code for $(mask "$number") $(error_detail "$WORK/resp.json")" ;;
    esac
  done
else
  MESSAGE="[$LABEL] $KEY: $TEXT"
  printf 'url = "%s/bot%s/sendMessage"\n' "$API_BASE" "$TELEGRAM_BOT_TOKEN" > "$WORK/curl.conf"
  http_code="$(curl -sS -m 20 -K "$WORK/curl.conf" -o "$WORK/resp.json" -w '%{http_code}' \
    --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=$MESSAGE" 2>"$WORK/curl.err")" || http_code="000"
  if [ "$http_code" = 200 ] && grep -q '"ok":true' "$WORK/resp.json" 2>/dev/null; then
    log_line "delivered via telegram HTTP $http_code"
  else
    report_failure "telegram HTTP $http_code"
  fi
fi

if [ "$DELIVERY_FAILED" = 1 ]; then exit 1; fi

if [ "$STATE_OK" = 1 ]; then
  case "$EVENT" in
    failure) printf 'alerted_at=%s\n' "$NOW" > "$STATE_FILE" ;;
    recovery) rm -f "$STATE_FILE" ;;
  esac
fi
exit 0
