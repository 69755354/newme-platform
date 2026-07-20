#!/bin/bash
# sentry-cron-checkin.sh — Sentry Cron Monitor 保活心跳
# 被监控脚本调用，向 Sentry 报告"我还活着"
# 用法: source /opt/hermes-scripts/observability/sentry-cron-checkin.sh
#       sentry_checkin_start "health-check"
#       ... 脚本逻辑 ...
#       sentry_checkin_finish "health-check" $?

# 需要 SENTRY_DSN 环境变量 (从 newme-platform .env.local 读取)
# 如果无法获取，降级为 no-op（不阻塞监控脚本）

SENTRY_DSN="${SENTRY_DSN:-}"
if [ -z "$SENTRY_DSN" ] && [ -f /home/ubuntu/newme-platform/.env.local ]; then
  SENTRY_DSN=$(grep '^NEXT_PUBLIC_SENTRY_DSN=' /home/ubuntu/newme-platform/.env.local | cut -d'=' -f2-)
fi

# 从 DSN 提取 org ingest URL 和 project ID 和 key
# DSN 格式: https://{key}@{host}/api/{project_id}
parse_dsn() {
  if [ -z "$SENTRY_DSN" ] || echo "$SENTRY_DSN" | grep -q '\.\.\.'; then
    return 1
  fi
  SENTRY_KEY=$(echo "$SENTRY_DSN" | sed -n 's|https://\([^@]*\)@.*|\1|p')
  SENTRY_HOST=$(echo "$SENTRY_DSN" | sed -n 's|https://[^@]*@\([^/]*\).*|\1|p')
  SENTRY_PROJECT_ID=$(echo "$SENTRY_DSN" | sed -n 's|.*/\([0-9]*\)$|\1|p')
  return 0
}

sentry_checkin_start() {
  local monitor_slug="$1"
  if ! parse_dsn || [ -z "$SENTRY_KEY" ]; then
    return 0  # 降级: 不阻塞
  fi
  
  CHECKIN_ID="${monitor_slug}-$(date +%s)-$$"
  
  curl -s --max-time 5 -X POST \
    "https://${SENTRY_HOST}/api/${SENTRY_PROJECT_ID}/cron/${monitor_slug}/${CHECKIN_ID}/" \
    -H "Authorization: DSN ${SENTRY_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"in_progress\"}" \
    -o /dev/null 2>/dev/null || true
}

sentry_checkin_finish() {
  local monitor_slug="$1"
  local exit_code="${2:-0}"
  
  if ! parse_dsn || [ -z "$SENTRY_KEY" ] || [ -z "$CHECKIN_ID" ]; then
    return 0
  fi
  
  local status="ok"
  [ "$exit_code" -ne 0 ] && status="error"
  
  curl -s --max-time 5 -X PUT \
    "https://${SENTRY_HOST}/api/${SENTRY_PROJECT_ID}/cron/${monitor_slug}/${CHECKIN_ID}/" \
    -H "Authorization: DSN ${SENTRY_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"${status}\"}" \
    -o /dev/null 2>/dev/null || true
}
