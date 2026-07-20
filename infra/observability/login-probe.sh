#!/bin/bash
# login-probe.sh — NewMe CRM 登录拨测
# 路径: /opt/hermes-scripts/observability/login-probe.sh
# crontab: */2 * * * * /bin/bash /opt/hermes-scripts/observability/login-probe.sh
# 依赖: curl
# 需要: TEST_EMAIL, TEST_PASSWORD 环境变量 (或用 Supabase anon key 创建 session)

set -euo pipefail

SITE_URL="${SITE_URL:-http://localhost:3001}"
MAX_RETRIES=2
TIMEOUT=10
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ─── 1. Health endpoint ───
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "${SITE_URL}/api/health" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "000" ]; then
  echo "[$TIMESTAMP] 🔔 HEALTH_DOWN: ${SITE_URL} 不可达 (连接超时)"
  /opt/hermes-scripts/observability/incident-capture.sh "login-probe" "health端点不可达" &
  exit 1
fi

if [ "$HTTP_CODE" -ge 500 ]; then
  echo "[$TIMESTAMP] 🔔 HEALTH_5XX: ${SITE_URL}/api/health 返回 HTTP $HTTP_CODE"
  /opt/hermes-scripts/observability/incident-capture.sh "login-probe" "health返回HTTP ${HTTP_CODE}" &
  exit 1
fi

# ─── 2. Auth 链路拨测 (带重试) ───
attempt=0
last_error=""
while [ $attempt -le $MAX_RETRIES ]; do
  AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    "${SITE_URL}/api/auth/me" \
    -H "Content-Type: application/json" 2>/dev/null || echo "000")
  
  # 401=服务正常(未认证), 200=正常响应, 307=重定向(也是正常的)
  case "$AUTH_CODE" in
    200|401|307)
      echo "[$TIMESTAMP] 💓 登录链路 OK (auth/me HTTP $AUTH_CODE, 第$((attempt+1))次)"
      exit 0
      ;;
  esac
  
  [ "$AUTH_CODE" = "000" ] && last_error="连接超时" || last_error="HTTP $AUTH_CODE"
  attempt=$((attempt + 1))
  [ $attempt -le $MAX_RETRIES ] && sleep 2
done

echo "[$TIMESTAMP] 🔔 LOGIN_PROBE_FAIL: ${SITE_URL}/api/auth/me $last_error (重试${MAX_RETRIES}次后仍失败)"
/opt/hermes-scripts/observability/incident-capture.sh "login-probe" "auth/me返回${last_error}" &
exit 1
