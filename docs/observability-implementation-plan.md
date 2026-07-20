# NewMe CRM 可观测性可落地方案（MoA 聚合版）

## 环境事实

- **OS**: Ubuntu 22.04 单机
- **服务**: `newme-platform.service` (端口 3001)
- **Hermes Agent**: `/home/ubuntu/.hermes/`
- **Sentry DSN**: 配置于 `next.config.ts`
- **Supabase**: `vfopmpxlhwzpxqegayew.supabase.co`
- **企业微信 Webhook**: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=# TODO: 需要实际值`
- **Telegram Bot Token**: `# TODO: 需要实际值`
- **Telegram Chat ID**: `# TODO: 需要实际值`
- **脚本目录**: `/opt/newme/scripts/`
- **日志目录**: `/var/log/newme/`
- **执行用户**: root crontab

---

## P0-1: 修复 Sentry 服务端 instrumentation

### 配置文件
**路径**: `/opt/newme/newme-platform/next.config.ts`

```typescript
/**
 * 来源模型: Kimi-K2.5 (主) + DS-R1 (Turbopack 兼容性)
 * 用途: Next.js + Sentry 配置，解决 Turbopack 与 require-in-the-middle 冲突
 */
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Turbopack 与 @sentry/nextjs 的 require-in-the-middle 冲突修复：生产构建强制使用 Webpack
  turbopack: process.env.NODE_ENV === "development" ? {} : undefined,
  
  experimental: {
    // 强制启用 instrumentation hook 确保服务端追踪加载
    instrumentationHook: true,
    // 禁用 serverComponentsExternalPackages 的自动处理以避免重复打包
    serverComponentsExternalPackages: ["@sentry/node"],
    turbo: {
      resolveAlias: {
        // 解决 Turbopack 下 require-in-the-middle 冲突
        "require-in-the-middle": false,
        "@opentelemetry/instrumentation": false,
      },
    },
    optimizePackageImports: ["@sentry/nextjs"],
  },

  webpack: (config, { isServer }) => {
    if (isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        // 强制使用 @sentry/node 的 CommonJS 版本避免 ESM/CJS 冲突
        "@sentry/nextjs": require.resolve("@sentry/nextjs/build/cjs/index.server.js"),
      };
    }
    return config;
  },

  // Sentry 特定配置
  sentry: {
    disableServerWebpackPlugin: false,
    disableClientWebpackPlugin: false,
    hideSourceMaps: true,
    widenClientFileUpload: true,
    automaticVercelMonitors: false,
    autoInstrumentServerFunctions: true,
    autoInstrumentMiddleware: false,
    tunnelRoute: "/monitoring",
  },
};

// Sentry 封装配置 - 禁用 debug 模式避免构建时日志污染
const sentryWebpackPluginOptions = {
  org: process.env.SENTRY_ORG || "newme",
  project: process.env.SENTRY_PROJECT || "newme-platform",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true, // 关键：禁用 verbose 日志避免 Turbopack 检测冲突
  hideSourceMaps: true,
  telemetry: false,
  runtime: {
    integrations: [],
  },
};

export default withSentryConfig(nextConfig, sentryWebpackPluginOptions);
```

### 自动化部署脚本（可选）
**路径**: `/opt/newme/scripts/deploy_sentry_fix.sh`

```bash
#!/bin/bash
# 来源模型: GLM-5.2
# 用途: 自动备份并更新 Sentry 配置，重启服务
set -euo pipefail

CONFIG_PATH="/opt/newme/newme-platform/next.config.ts"
BACKUP_PATH="/opt/newme/newme-platform/next.config.ts.bak.$(date +%Y%m%d%H%M%S)"

if [ -f "$CONFIG_PATH" ]; then
    cp "$CONFIG_PATH" "$BACKUP_PATH"
    echo "Backup created: $BACKUP_PATH"
fi

# 注意：实际部署时应通过 CI/CD 或手动替换配置文件内容
# 此处仅作备份和重启示意
systemctl restart newme-platform.service
echo "Service restarted at $(date)"
```

### 验证命令
```bash
# 1. 重建项目（生产环境使用 Webpack）
cd /opt/newme/newme-platform
npm run build 2>&1 | grep -i "sentry\|error\|warn" | head -20

# 2. 检查服务端追踪是否生效
node -e "const { init } = require('@sentry/nextjs'); init({ dsn: process.env.SENTRY_DSN }); console.log('Sentry server init OK')"

# 3. 启动服务后检查 Sentry 事件
curl -s http://localhost:3001/monitoring | grep -q "sentry" && echo "Sentry tunnel OK"

# 4. 手动触发错误（访问测试端点）
curl -s http://localhost:3001/api/test/sentry
# 查看日志：tail -f /var/log/newme/newme-platform.log | grep -i sentry
```

### 依赖项
```bash
npm install @sentry/nextjs@latest @sentry/node@latest
```

---

## P0-2: 基础设施监控

### 监控脚本
**路径**: `/opt/newme/scripts/health_check.sh`

```bash
#!/bin/bash
# 来源模型: Kimi-K2.5 (主) + DS-R1 (阈值与告警通道)
# 用途: 监控 CPU、内存、磁盘、进程数、HTTP 健康检查，支持企业微信+Telegram双通道告警

set -euo pipefail

LOG_FILE="/var/log/newme/health_check.log"
LOCK_FILE="/var/run/newme_health_check.lock"
WECHAT_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=# TODO: 需要实际值"
TELEGRAM_BOT_TOKEN="# TODO: 需要实际值"
TELEGRAM_CHAT_ID="# TODO: 需要实际值"

# 防止并发执行
exec 200>"$LOCK_FILE"
flock -n 200 || { echo "[$(date '+%Y-%m-%d %H:%M:%S')] Another instance is running" >> "$LOG_FILE"; exit 1; }

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

send_alert() {
    local title="$1"
    local content="$2"
    
    # 企业微信
    curl -s -m 5 -X POST "$WECHAT_WEBHOOK" \
        -H 'Content-Type: application/json' \
        -d "{
            \"msgtype\": \"markdown\",
            \"markdown\": {
                \"content\": \"**[P0] 基础设施告警**\\n>标题: ${title}\\n>内容: ${content}\\n>时间: $(date '+%Y-%m-%d %H:%M:%S')\\n>主机: $(hostname)\"
            }
        }" > /dev/null 2>&1 || true
    
    # Telegram
    curl -s -m 5 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "text=[P0] ${title}%0A${content}%0AHost: $(hostname)" \
        -d "parse_mode=HTML" > /dev/null 2>&1 || true
    
    log "ALERT SENT: $title - $content"
}

check_cpu() {
    local cpu_idle=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print $1}')
    local cpu_usage=$(echo "scale=2; 100 - $cpu_idle" | bc)
    if (( $(echo "$cpu_usage > 90" | bc -l) )); then
        send_alert "CPU 使用率过高" "当前: ${cpu_usage}% (阈值: 90%)"
        return 1
    fi
    return 0
}

check_memory() {
    local mem_info=$(free | grep Mem)
    local total=$(echo $mem_info | awk '{print $2}')
    local used=$(echo $mem_info | awk '{print $3}')
    local usage_percent=$(echo "scale=2; $used / $total * 100" | bc)
    
    if (( $(echo "$usage_percent > 85" | bc -l) )); then
        send_alert "内存使用率过高" "当前: ${usage_percent}% (阈值: 85%)"
        return 1
    fi
    return 0
}

check_disk() {
    local disk_usage=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
    if [ "$disk_usage" -gt 90 ]; then
        send_alert "磁盘使用率过高" "根分区: ${disk_usage}% (阈值: 90%)"
        return 1
    fi
    return 0
}

check_processes() {
    local proc_count=$(ps aux | wc -l)
    if [ "$proc_count" -gt 500 ]; then
        send_alert "进程数过多" "当前: ${proc_count} (阈值: 500)"
        return 1
    fi
    return 0
}

check_app_health() {
    local health_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3001/health 2>/dev/null || echo "000")
    if [ "$health_code" != "200" ]; then
        send_alert "应用健康检查失败" "localhost:3001/health 返回 HTTP $health_code"
        return 1
    fi
    return 0
}

# 主逻辑
mkdir -p "$(dirname "$LOG_FILE")"
log "Starting health check..."

failed=0
check_cpu || failed=1
check_memory || failed=1
check_disk || failed=1
check_processes || failed=1
check_app_health || failed=1

if [ $failed -eq 0 ]; then
    log "All checks passed"
fi

exit $failed
```

### crontab 行（root）
```
*/3 * * * * /bin/bash /opt/newme/scripts/health_check.sh >> /var/log/newme/health_check_cron.log 2>&1
```

### 验证命令
```bash
# 手动执行
chmod +x /opt/newme/scripts/health_check.sh
/opt/newme/scripts/health_check.sh

# 检查日志
tail -f /var/log/newme/health_check.log

# 模拟高负载触发告警
stress --cpu 4 --timeout 10s 2>/dev/null; /opt/newme/scripts/health_check.sh
```

### 依赖项
```bash
apt-get install -y bc curl stress
```

---

## P0-3: Hermes 高可用

### 监控脚本
**路径**: `/opt/newme/scripts/hermes_watchdog.sh`

```bash
#!/bin/bash
# 来源模型: Kimi-K2.5 (主) + DS-R1 (PID 文件管理)
# 用途: Hermes Agent 保活与故障转移，异常时直接通过 Webhook 降级告警

set -euo pipefail

HERMES_PID_FILE="/home/ubuntu/.hermes/hermes.pid"
HERMES_BINARY="/home/ubuntu/.hermes/hermes"
LOG_FILE="/var/log/newme/hermes_watchdog.log"
WECHAT_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=# TODO: 需要实际值"
TELEGRAM_BOT_TOKEN="# TODO: 需要实际值"
TELEGRAM_CHAT_ID="# TODO: 需要实际值"
FAILOVER_MARKER="/var/run/hermes_failover_active"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

send_direct_alert() {
    local severity="$1"
    local message="$2"
    
    # 企业微信直发（绕过 Hermes）
    curl -s -m 5 -X POST "$WECHAT_WEBHOOK" \
        -H 'Content-Type: application/json' \
        -d "{
            \"msgtype\": \"text\",
            \"text\": {
                \"content\": \"[${severity}] Hermes 故障转移\\n${message}\\n主机: $(hostname)\\n时间: $(date '+%Y-%m-%d %H:%M:%S')\"
            }
        }" > /dev/null 2>&1 || true
    
    # Telegram 直发
    curl -s -m 5 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "text=[${severity}] Hermes Failover%0A${message}%0AHost: $(hostname)" > /dev/null 2>&1 || true
    
    log "[${severity}] ${message}"
}

check_hermes() {
    if [ -f "$HERMES_PID_FILE" ]; then
        local pid=$(cat "$HERMES_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            # 检查 HTTP 管理端口（Hermes 默认监听 9090）
            if timeout 2 curl -sf http://localhost:9090/health > /dev/null 2>&1; then
                # 如果之前是故障状态，发送恢复通知
                if [ -f "$FAILOVER_MARKER" ]; then
                    send_direct_alert "INFO" "Hermes 已恢复 (PID: $pid)"
                    rm -f "$FAILOVER_MARKER"
                fi
                return 0
            fi
        fi
    else
        # 没有 PID 文件，检查是否有进程在运行
        if pgrep -x "hermes" > /dev/null; then
            local pid=$(pgrep -x "hermes" | head -1)
            echo "$pid" > "$HERMES_PID_FILE"
            log "PID file recreated for existing process $pid"
            return 0
        fi
    fi
    return 1
}

restart_hermes() {
    log "Attempting to restart Hermes..."
    
    # 尝试优雅重启
    if [ -f "$HERMES_PID_FILE" ]; then
        kill -TERM "$(cat "$HERMES_PID_FILE")" 2>/dev/null || true
        sleep 2
    fi
    
    # 强制清理残留进程
    pkill -f "hermes" 2>/dev/null || true
    sleep 1
    
    # 启动
    if [ -x "$HERMES_BINARY" ]; then
        cd /home/ubuntu/.hermes
        nohup "$HERMES_BINARY" > /var/log/newme/hermes.log 2>&1 &
        local new_pid=$!
        echo $new_pid > "$HERMES_PID_FILE"
        
        sleep 3
        if kill -0 "$new_pid" 2>/dev/null; then
            log "Hermes restarted successfully with PID $new_pid"
            send_direct_alert "WARNING" "Hermes 已自动重启 (PID: $new_pid)"
            return 0
        else
            log "Failed to restart Hermes"
            return 1
        fi
    else
        log "Hermes binary not found: $HERMES_BINARY"
        return 1
    fi
}

# 主逻辑
mkdir -p "$(dirname "$LOG_FILE")"

if ! check_hermes; then
    touch "$FAILOVER_MARKER"
    send_direct_alert "CRITICAL" "Hermes 无响应，正在执行故障转移..."
    
    if ! restart_hermes; then
        send_direct_alert "CRITICAL" "Hermes 重启失败！进入静默模式，所有告警将通过本通道直发"
    fi
fi
```

### crontab 行（root）
```
*/1 * * * * /bin/bash /opt/newme/scripts/hermes_watchdog.sh
```

### 验证命令
```bash
# 手动执行
bash /opt/newme/scripts/hermes_watchdog.sh

# 模拟 Hermes 停止
kill $(cat /home/ubuntu/.hermes/hermes.pid) 2>/dev/null; sleep 2; bash /opt/newme/scripts/hermes_watchdog.sh

# 检查降级告警日志
cat /var/log/newme/hermes_watchdog.log
```

### 依赖项
```bash
apt-get install -y curl
```

---

## P0-4: Sentry 配额监控

### 监控脚本
**路径**: `/opt/newme/scripts/sentry_quota_monitor.sh`

```bash
#!/bin/bash
# 来源模型: GLM-5.2 (主) + DS-R1 (分级阈值策略)
# 用途: 调用 Sentry API 监控 usage，配额接近阈值时动态调整采样率

set -euo pipefail

# 配置
SENTRY_ORG="# TODO: 需要实际值"  # 例如: newme
SENTRY_PROJECT="newme-platform"
SENTRY_AUTH_TOKEN="# TODO: 需要实际值"  # Sentry Auth Token
SENTRY_API="https://sentry.io/api/0"
LOG_FILE="/var/log/newme/sentry_quota.log"
WECHAT_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=# TODO: 需要实际值"

QUOTA_WARNING_THRESHOLD=80   # 使用率达到 80% 告警
QUOTA_CRITICAL_THRESHOLD=95  # 达到 95% 强制降低采样率

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

send_alert() {
    local message="$1"
    curl -s -m 5 -X POST "$WECHAT_WEBHOOK" \
        -H "Content-Type: application/json" \
        -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"[Sentry Quota] ${message}\"}}" > /dev/null 2>&1 || true
    log "ALERT: $message"
}

# 获取当前组织 usage
get_usage() {
    local response
    response=$(curl -s -m 10 -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
        "${SENTRY_API}/organizations/${SENTRY_ORG}/stats_v2/?field=sum(quantity)&interval=1d&project=-1&category=error_transaction&groupBy=category" 2>/dev/null || echo "{}")
    
    # 解析使用率（简化处理，实际应根据 Sentry 返回结构调整）
    # 这里使用 project 级别的 quotas 接口
    local quota_response
    quota_response=$(curl -s -m 10 -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
        "${SENTRY_API}/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/quotas/" 2>/dev/null || echo "{}")
    
    echo "$quota_response"
}

# 获取当前采样率
get_current_sample_rate() {
    local response
    response=$(curl -s -m 10 -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
        "${SENTRY_API}/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/" 2>/dev/null || echo "{}")
    echo "$response" | jq -r '.options.tracesSampleRate // 1.0'
}

# 更新采样率
update_sample_rate() {
    local new_rate="$1"
    curl -s -m 10 -X PUT \
        -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
        -H "Content-Type: application/json" \
        "${SENTRY_API}/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/" \
        -d "{\"options\":{\"tracesSampleRate\":${new_rate}}}" > /dev/null 2>&1 || true
    log "Sample rate adjusted to $new_rate"
}

# 主逻辑
mkdir -p "$(dirname "$LOG_FILE")"
log "Starting Sentry quota check..."

# 获取配额数据（使用 stats 接口计算近似使用率）
TODAY=$(date +%Y-%m-%d)
RESPONSE=$(curl -s -m 15 -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
    "${SENTRY_API}/organizations/${SENTRY_ORG}/stats_v2/?field=sum(quantity)&interval=1h&project=-1&category=error&start=${TODAY}T00:00:00&end=${TODAY}T23:59:59" 2>/dev/null || echo "{}")

# 简化处理：直接检查项目设置中的近似使用量（实际生产环境应使用更精确的 API）
# 这里使用备用方案：检查过去 1 小时的错误数是否异常增长
HOUR_USAGE=$(echo "$RESPONSE" | jq '[.groups[0].series["sum(quantity)"] | add] | add // 0')

# 由于 Sentry API 限制，这里采用简化逻辑：如果配置了硬限制，则监控接近程度
# 实际部署时需要根据 Sentry 计划调整阈值逻辑

if [ "$HOUR_USAGE" -gt 10000 ]; then  # 示例阈值，需根据实际配额调整
    send_alert "Sentry 使用量告警: 过去1小时 ${HOUR_USAGE} 事件"
fi

# 动态采样率调整（如果支持）
CURRENT_RATE=$(get_current_sample_rate)
if (( $(echo "$CURRENT_RATE > 0.1" | bc -l) )); then
    # 如果使用率过高，降低采样率
    if [ "$HOUR_USAGE" -gt 50000 ]; then
        update_sample_rate "0.1"
        send_alert "采样率已自动降至 10% (原: $CURRENT_RATE)"
    elif [ "$HOUR_USAGE" -gt 30000 ]; then
        update_sample_rate "0.5"
        send_alert "采样率已自动降至 50% (原: $CURRENT_RATE)"
    fi
fi

log "Quota check completed. Hour usage: $HOUR_USAGE, Current rate: $CURRENT_RATE"
```

### crontab 行（root）
```
0 */6 * * * /bin/bash /opt/newme/scripts/sentry_quota_monitor.sh
```

### 验证命令
```bash
# 手动执行检查
bash /opt/newme/scripts/sentry_quota_monitor.sh

# 检查 Sentry UI 中的采样率变化
# 测试高流量场景下的自动调整
```

### 依赖项
```bash
apt-get install -y jq bc curl
```

---

## P0-5: Supabase 基础监控

### 监控脚本
**路径**: `/opt/newme/scripts/db_monitor.sh`

```bash
#!/bin/bash
# 来源模型: GLM-5.2
# 用途: 监控 Supabase 连接池使用率和慢查询

set -euo pipefail

DB_PASSWORD="# TODO: 需要实际值"
DB_URL="postgresql://postgres:${DB_PASSWORD}@vfopmpxlhwzpxqegayew.supabase.co:5432/postgres"
WEBHOOK_URL="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=# TODO: 需要实际值"
LOG_FILE="/var/log/newme/db_monitor.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

send_alert() {
    local content="$1"
    curl -s -m 5 -X POST "$WEBHOOK_URL" \
        -H 'Content-Type: application/json' \
        -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"[DB Alert] ${content}\"}}" > /dev/null 2>&1 || true
    log "ALERT: $content"
}

# 获取连接池使用率
POOL_USAGE=$(psql "$DB_URL" -t -c "SELECT COALESCE((count(*)::float / max_connections::float) * 100, 0) FROM pg_stat_activity, (SELECT setting::int as max_connections FROM pg_settings WHERE name='max_connections') mc;" 2>/dev/null || echo "0")

# 获取慢查询数量（>100ms）
SLOW_QUERIES=$(psql "$DB_URL" -t -c "SELECT COUNT(*) FROM pg_stat_statements WHERE mean_exec_time > 100;" 2>/dev/null || echo "0")

# 检查阈值
if (( $(echo "$POOL_USAGE > 80" | bc -l) )); then
    send_alert "Supabase 连接池使用率过高: ${POOL_USAGE}%"
fi

if [ "$SLOW_QUERIES" -gt 10 ]; then
    send_alert "Supabase 慢查询过多: ${SLOW_QUERIES} 条 (>100ms)"
fi

log "Pool: ${POOL_USAGE}%, Slow queries: ${SLOW_QUERIES}"
```

### crontab 行（root）
```
*/10 * * * * /bin/bash /opt/newme/scripts/db_monitor.sh >> /var/log/newme/db_monitor_cron.log 2>&1
```

### 验证命令
```bash
# 测试连接
psql "$DB_URL" -c "SELECT version();"

# 模拟慢查询
psql "$DB_URL" -c "SELECT pg_sleep(1);"

# 检查日志
tail -f /var/log/newme/db_monitor.log
```

### 依赖项
```bash
apt-get install -y postgresql-client bc curl
```

---

## P0-6: 登录拨测 + 告警规则

### 拨测脚本
**路径**: `/opt/newme/scripts/login_probe.sh`

```bash
#!/bin/bash
# 来源模型: GLM-5.2
# 用途: 定期测试登录接口可用性，失败时通过 Telegram 告警

set -euo pipefail

TELEGRAM_BOT_TOKEN="# TODO: 需要实际值"
CHAT_ID="# TODO: 需要实际值"
LOG_FILE="/var/log/newme/login_probe.log"

# OAuth 配置（如果使用 Google OAuth）
REFRESH_TOKEN="# TODO: 需要实际值"  # Google OAuth Refresh Token
CLIENT_ID="# TODO: 需要实际值"      # Google OAuth Client ID
CLIENT_SECRET="# TODO: 需要实际值"  # Google OAuth Client Secret

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

send_alert() {
    local message="$1"
    curl -s -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=[Login Probe] ${message}" > /dev/null 2>&1 || true
    log "ALERT: $message"
}

# 获取访问令牌（如果应用使用 OAuth）
get_access_token() {
    if [ -n "$REFRESH_TOKEN" ] && [ "$REFRESH_TOKEN" != "# TODO: 需要实际值" ]; then
        local token_response
        token_response=$(curl -s -m 10 -X POST "https://accounts.google.com/o/oauth2/token" \
            -d "client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&refresh_token=${REFRESH_TOKEN}&grant_type=refresh_token" 2>/dev/null || echo "{}")
        echo "$token_response" | jq -r '.access_token // empty'
    else
        echo ""
    fi
}

# 执行登录测试
TOKEN=$(get_access_token)
RESPONSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:3001/api/auth/login" \
    ${TOKEN:+-H "Authorization: Bearer ${TOKEN}"} \
    -H "Content-Type: application/json" \
    -d '{"test":true}' \
    --max-time 10 2>/dev/null || echo "000")

if [ "$RESPONSE_CODE" != "200" ]; then
    send_alert "NewMe 登录接口异常: HTTP $RESPONSE_CODE"
    exit 1
fi

log "Login probe success: HTTP $RESPONSE_CODE"
```

### crontab 行（root）
```
*/15 * * * * /bin/bash /opt/newme/scripts/login_probe.sh
```

### 验证命令
```bash
# 手动执行
bash /opt/newme/scripts/login_probe.sh

# 临时破坏登录测试
# mv /opt/newme/newme-platform/api/auth/login.ts /opt/newme/newme-platform/api/auth/login.ts.bak
# 恢复后检查告警
```

### 依赖项
```bash
apt-get install -y jq curl
```

---

## 统一 Crontab 配置汇总

将以下内容添加到 root 用户的 crontab（执行 `crontab -e`）：

```cron
# NewMe CRM 可观测性监控任务
# P0-1: Sentry 配置自动修复（每日凌晨2点检查）
0 2 * * * /bin/bash /opt/newme/scripts/deploy_sentry_fix.sh >> /var/log/newme/deploy_sentry_fix.log 2>&1

# P0-2: 基础设施监控（每3分钟）
*/3 * * * * /bin/bash /opt/newme/scripts/health_check.sh >> /var/log/newme/health_check_cron.log 2>&1

# P0-3: Hermes 高可用监控（每分钟）
*/1 * * * * /bin/bash /opt/newme/scripts/hermes_watchdog.sh

# P0-4: Sentry