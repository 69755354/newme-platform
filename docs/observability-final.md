# NewMe CRM 可观测性生产落地方案（Final）

**文档路径**: `/home/ubuntu/newme-platform/docs/observability-final.md`  
**生效日期**: 立即执行  
**环境基准**: Ubuntu 22.04, Hermes 三服务拓扑 (bridge/dashboard/worker), Sentry Org: newme-o4

---

## 一、目标与量化指标

**核心目标**: 建成以 Sentry 为底座、零新增成本的可观测性系统，实现**系统先于用户感知故障**。

**量化目标**:
- **MTTD**（平均检测时间）: < 1 分钟（P0 验收标准）
- **MTTR**（平均修复时间）: < 30 分钟（P2 目标，针对已知故障模式）
- **告警信噪比**: > 70%（有效告警 / 总告警）
- **故障覆盖率**: L0 登录路径 100% 覆盖，核心业务流程（创建/导出/支付）P1 阶段覆盖

**三期演进**:
- **P0（本周，5-8 人天）**: 有感知 —— 服务端复活 + 基础设施监控 + 拨测 + 告警 + Hermes 三服务高可用底座
- **P1（下周）**: 可诊断 —— Tracing + 业务指标 + 配额管理 + Autofix 只读诊断（需先完成 Hermes 拓扑适配）
- **P2（本月）**: 能闭环 —— 错误预算 + 受控自动修复（L2/L3 需人工确认）

---

## 二、能力矩阵（修正路径版）

### Sentry 承担（激活已有能力）

| # | OS 能力 | Sentry 功能 | 当前状态 | P0/P1 |
|---|---------|------------|---------|-------|
| S1 | 服务端 crash | Issues | ❌ 构建 bug 禁用 | P0 复活 |
| S2 | 前端 crash + 体验 | Issues + Replay | ✅ 运行中 | — |
| S3 | 全链路追踪 | Distributed Tracing | ❌ 未开 | P1 开启 |
| S4 | 前端性能劣化 | Web Vitals | ❌ 未开 | P1 开启 |
| S5 | 业务指标突变 | Custom Metrics | ❌ 未埋点 | P1 埋点 |
| S6 | 错误上下文 | Breadcrumbs | ⚠️ 客户端有/服务端缺 | P0 随复活 |
| S7 | 版本 ↔ 错误关联 | Release Tracking | ⚠️ 配了但未关联 deploy | P0 CI 加一步 |
| S8 | 告警规则 | Alert Rules | ❌ 未设 | P0 配规则 |
| S9 | Session 回放 | Replay | ❓ 未确认 | P1 合规评估后开启 |
| S10 | 去重收敛 | Issue Grouping | ✅ 自带 | — |
| Q1 | 配额监控与采样 | Usage Stats + Dynamic Sampling | ❌ 未配置 | P0 配置 |

### 外部补充（零成本实现）

| # | OS 能力 | 实现方式 | 成本 | P0/P1 |
|---|---------|---------|------|-------|
| E1 | 功能感知（登录拨测） | Cron + curl + OAuth 自动刷新 | 0 | P0 |
| E2 | 告警通道（微信/Telegram） | Sentry Webhook → Hermes 推送 | 0 | P0 |
| I1 | 基础设施监控 | Cron + bash (df/free/ps) → Hermes → Sentry/微信 | 0 | P0 |
| I2 | Supabase 基础监控 | Supabase API → Cron → Hermes | 0 | P0 |
| H1 | Hermes 三服务高可用 | systemctl 监控 + 独立心跳 + 降级直发通道 | 0 | P0 |
| P1-AF | Autofix 只读诊断 | Hermes Worker 扩展（L1 级） | 0 | P1（降级） |
| E3 | 闭环（Issue → Linear） | Sentry Webhook → Hermes → Linear API | 0 | P1 |
| E4 | CI 失败 / Deploy 回滚通知 | GitHub Webhook → Hermes | 0 | P1 |

---

## 三、P0-P2 分期任务（生产可执行版）

**环境硬事实**:
- 脚本路径: `/home/ubuntu/.hermes/scripts/`（禁止 `/opt/newme/`)
- 日志路径: `/home/ubuntu/hermes-logs/`（禁止 `/tmp/`, 禁止 `/var/log/newme/`)
- Hermes 拓扑: 三服务 (`hermes-bridge`, `hermes-dashboard`, `hermes-worker`)
- Crontab: `ubuntu` 用户（禁止 root）
- Sentry: Org=`newme-o4`, Project=`javascript-nextjs`

---

### P0-1: 修复 Sentry 服务端 Instrumentation

**依赖**: 无  
**风险**: 🔴 高（禁止全量替换 next.config.ts）

#### 具体步骤

1. **备份现有配置**
   ```bash
   cp /home/ubuntu/newme-platform/next.config.ts /home/ubuntu/newme-platform/next.config.ts.bak.$(date +%Y%m%d%H%M%S)
   ```

2. **Patch 修改**（仅修改 Sentry 相关部分，保留生产构建守卫）
   
   **修改位置**: 在 `experimental` 对象内添加：
   ```typescript
   experimental: {
     // 保留现有所有配置...
     
     // 新增：Sentry 服务端兼容性修复
     serverComponentsExternalPackages: ["@sentry/node"],
     
     // 新增：Turbopack 兼容性（若使用 Turbopack）
     turbo: {
       resolveAlias: {
         "require-in-the-middle": false,
         "@opentelemetry/instrumentation": false,
       },
     },
   },
   ```
   
   **修改位置**: 在 `sentry` 配置对象确认：
   ```typescript
   sentry: {
     disableServerWebpackPlugin: false,
     autoInstrumentServerFunctions: true,
     // 保留 deleteSourcemapsAfterUpload: true 等现有配置
   }
   ```

3. **验证构建**
   ```bash
   cd /home/ubuntu/newme-platform
   npm run build 2>&1 | grep -i "sentry\|error\|warn" | head -20
   ```

#### 验证命令
```bash
# 检查服务端追踪是否生效
node -e "const { init } = require('@sentry/nextjs'); init({ dsn: process.env.SENTRY_DSN }); console.log('Sentry server init OK')"

# 手动触发错误（部署后）
curl -s http://localhost:3001/api/healthcheck/sentry-test
# 查看 Sentry Issues 是否收到 "Sentry Test Error" 事件
```

---

### P0-2: 基础设施监控（I1）

**依赖**: 无  
**冲突解决**: 与现有 `resource-alert.py`（每小时）共存，本脚本聚焦即时告警（3分钟级）

#### 具体步骤

1. **创建监控脚本**
   **路径**: `/home/ubuntu/.hermes/scripts/health_check.sh`
   
   ```bash
   #!/bin/bash
   set -euo pipefail

   LOG_FILE="/home/ubuntu/hermes-logs/health_check.log"
   mkdir -p "$(dirname "$LOG_FILE")"
   
   # Hermes Webhook 端点（本地桥接）
   HERMES_ENDPOINT="http://localhost:8080/webhook/infrastructure"
   WECHAT_KEY="# TODO: 从环境变量或安全存储读取"
   
   log() {
       echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
   }

   send_alert() {
       local title="$1"
       local content="$2"
       
       # 通过 Hermes 发送（若可用）
       curl -s -m 5 -X POST "$HERMES_ENDPOINT" \
           -H 'Content-Type: application/json' \
           -d "{\"level\":\"critical\",\"source\":\"infrastructure\",\"title\":\"${title}\",\"content\":\"${content}\"}" > /dev/null 2>&1 || true
       
       log "ALERT: $title - $content"
   }

   # 检查项
   DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
   if [ "$DISK_USAGE" -gt 90 ]; then
       send_alert "Disk Critical" "Root partition ${DISK_USAGE}% > 90%"
   fi

   MEM_USAGE=$(free | grep Mem | awk '{printf("%.0f"), $3/$2*100}')
   if [ "$MEM_USAGE" -gt 85 ]; then
       send_alert "Memory Critical" "Memory usage ${MEM_USAGE}% > 85%"
   fi

   # 检查应用健康（3001 端口）
   if ! curl -sf --max-time 5 http://localhost:3001/health > /dev/null 2>&1; then
       send_alert "App Health Fail" "localhost:3001/health unreachable"
   fi

   log "Check completed"
   ```

2. **设置权限**
   ```bash
   chmod +x /home/ubuntu/.hermes/scripts/health_check.sh
   mkdir -p /home/ubuntu/hermes-logs
   ```

3. **配置 Crontab（ubuntu 用户）**
   ```bash
   crontab -e
   # 添加：
   */3 * * * * /bin/bash /home/ubuntu/.hermes/scripts/health_check.sh >> /home/ubuntu/hermes-logs/health_check_cron.log 2>&1
   ```

#### 验证命令
```bash
# 手动执行
bash /home/ubuntu/.hermes/scripts/health_check.sh

# 模拟磁盘满（测试后清理）
fallocate -l 50G /tmp/testfile; bash /home/ubuntu/.hermes/scripts/health_check.sh; rm /tmp/testfile

# 检查日志
tail -f /home/ubuntu/hermes-logs/health_check.log
```

---

### P0-3: Hermes 三服务高可用底座（H1）

**依赖**: 无  
**说明**: 适配三服务拓扑（bridge/dashboard/worker），替代单进程假设

#### 具体步骤

1. **创建三服务监控脚本**
   **路径**: `/home/ubuntu/.hermes/scripts/hermes_ha_watchdog.sh`
   
   ```bash
   #!/bin/bash
   # 监控 hermes-bridge, hermes-dashboard, hermes-worker
   set -euo pipefail

   LOG_FILE="/home/ubuntu/hermes-logs/hermes_ha.log"
   WECHAT_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=# TODO"
   SERVICES=("hermes-bridge" "hermes-dashboard" "hermes-worker")
   
   log() {
       echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
   }

   send_direct_alert() {
       local msg="$1"
       curl -s -m 5 -X POST "$WECHAT_WEBHOOK" \
           -H 'Content-Type: application/json' \
           -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"[Hermes HA] ${msg}\"}}" > /dev/null 2>&1 || true
       log "DIRECT ALERT: $msg"
   }

   for service in "${SERVICES[@]}"; do
       if ! systemctl is-active --quiet "$service"; then
           log "$service is down, attempting restart..."
           if sudo systemctl restart "$service"; then
               send_direct_alert "$service 已自动重启"
           else
               send_direct_alert "$service 重启失败，需人工介入"
           fi
       fi
   done

   # 独立心跳：每分钟发送一次" I'm alive"到备用通道（可选）
   log "HA check completed"
   ```

2. **配置 sudoers（免密重启服务）**
   ```bash
   sudo visudo
   # 添加：
   ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl restart hermes-bridge, /bin/systemctl restart hermes-dashboard, /bin/systemctl restart hermes-worker, /bin/systemctl is-active hermes-*
   ```

3. **配置 Crontab**
   ```bash
   */1 * * * * /bin/bash /home/ubuntu/.hermes/scripts/hermes_ha_watchdog.sh
   ```

#### 验证命令
```bash
# 测试单个服务停止
sudo systemctl stop hermes-bridge
# 等待 1 分钟，检查是否自动重启
systemctl status hermes-bridge
# 检查微信是否收到告警
```

---

### P0-4: Sentry 配额监控（Q1）

**依赖**: P0-1 完成（Sentry 服务端恢复）

#### 具体步骤

1. **创建配额监控脚本**
   **路径**: `/home/ubuntu/.hermes/scripts/sentry_quota_check.sh`
   
   ```bash
   #!/bin/bash
   set -euo pipefail

   SENTRY_AUTH_TOKEN="${SENTRY_AUTH_TOKEN:-# TODO}"
   SENTRY_ORG="newme-o4"
   SENTRY_PROJECT="javascript-nextjs"
   LOG_FILE="/home/ubuntu/hermes-logs/sentry_quota.log"
   
   # 获取当前小时使用量（简化逻辑，实际根据 Sentry API 调整）
   # 注意：这里使用 stats 接口近似计算
   RESPONSE=$(curl -s -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
       "https://sentry.io/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/stats/?stat=received&resolution=1h" 2>/dev/null || echo "[]")
   
   # 解析最近一小时数量（示例）
   LATEST_COUNT=$(echo "$RESPONSE" | tail -1 | grep -o '[0-9]*' | tail -1 || echo "0")
   
   # 阈值：每小时超过 5000 事件则告警（根据实际配额调整）
   if [ "$LATEST_COUNT" -gt 5000 ]; then
       curl -s -X POST "http://localhost:8080/webhook/sentry-quota" \
           -d "{\"level\":\"warning\",\"count\":${LATEST_COUNT}}" > /dev/null 2>&1 || true
       echo "[$(date)] Quota warning: ${LATEST_COUNT} events/hour" >> "$LOG_FILE"
   fi
   ```

2. **配置 Sentry 动态采样**（Web 控制台）
   - Project Settings → Performance → Dynamic Sampling
   - 设置：Login API 100%，其他 API 1%，Replay 0.1%
   - Usage Stats 设置 80% 阈值告警

3. **Crontab**
   ```bash
   0 * * * * /bin/bash /home/ubuntu/.hermes/scripts/sentry_quota_check.sh
   ```

---

### P0-5: Supabase 基础监控（I2）

**依赖**: 无

#### 具体步骤

1. **创建监控脚本**
   **路径**: `/home/ubuntu/.hermes/scripts/db_monitor.sh`
   
   ```bash
   #!/bin/bash
   set -euo pipefail

   DB_URL="postgresql://postgres:${DB_PASSWORD}@vfopmpxlhwzpxqegayew.supabase.co:5432/postgres"
   LOG_FILE="/home/ubuntu/hermes-logs/db_monitor.log"
   
   # 连接池检查
   POOL_USAGE=$(psql "$DB_URL" -t -c "SELECT count(*)::float / (SELECT setting::int FROM pg_settings WHERE name='max_connections') * 100 FROM pg_stat_activity;" 2>/dev/null || echo "0")
   
   if (( $(echo "$POOL_USAGE > 80" | bc -l) )); then
       curl -s -X POST "http://localhost:8080/webhook/db-alert" \
           -d "{\"level\":\"critical\",\"metric\":\"connection_pool\",\"value\":${POOL_USAGE}}" > /dev/null 2>&1 || true
       echo "[$(date)] DB Pool alert: ${POOL_USAGE}%" >> "$LOG_FILE"
   fi
   ```

2. **安装依赖**
   ```bash
   sudo apt-get install -y postgresql-client bc
   ```

3. **Crontab**
   ```bash
   */10 * * * * /bin/bash /home/ubuntu/.hermes/scripts/db_monitor.sh
   ```

---

### P0-6: 登录拨测与告警（E1+E2）

**依赖**: P0-3（Hermes 高可用底座）

#### 具体步骤

1. **创建拨测脚本**
   **路径**: `/home/ubuntu/.hermes/scripts/login_probe.sh`
   
   ```bash
   #!/bin/bash
   set -euo pipefail

   LOG_FILE="/home/ubuntu/hermes-logs/login_probe.log"
   ENDPOINT="http://localhost:3001/api/auth/login"
   
   # 使用 test 账号或健康检查端点
   HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
       -X POST "$ENDPOINT" \
       -H "Content-Type: application/json" \
       -d '{"probe":true}' 2>/dev/null || echo "000")
   
   if [ "$HTTP_CODE" != "200" ]; then
       # 直接告警（绕过 Hermes 以防 Hermes 本身故障）
       curl -s -m 5 -X POST "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=# TODO" \
           -H 'Content-Type: application/json' \
           -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"[CRITICAL] Login Probe Failed: HTTP ${HTTP_CODE}\"}}" > /dev/null 2>&1 || true
       echo "[$(date)] Login failed: $HTTP_CODE" >> "$LOG_FILE"
       exit 1
   fi
   
   echo "[$(date)] Login OK" >> "$LOG_FILE"
   ```

2. **Crontab**
   ```bash
   */1 * * * * /bin/bash /home/ubuntu/.hermes/scripts/login_probe.sh
   ```

---

### P1-1: Autofix 只读诊断引擎（降级任务）

**依赖**: P0-3（Hermes 三服务监控稳定运行 3 天+）  
**状态**: ⚠️ 禁止在 P0 执行  
**安全级别**: 严格 L1（只读）

#### 具体步骤

1. **创建配置**
   **路径**: `/home/ubuntu/.hermes/config/autofix.yml`
   
   ```yaml
   autofix:
     enabled: true
     max_auto_level: L1  # 严格限制只读，禁止 L2/L3
     require_confirmation_for: [L2, L3]
     forbidden_auto: [L3]
     
     circuit_breaker:
       failure_threshold: 3
       recovery_timeout: 600s
       global_kill_switch: true
       
     audit_log: /home/ubuntu/hermes-logs/autofix.log
   ```

2. **创建诊断脚本（只读）**
   **路径**: `/home/ubuntu/.hermes/scripts/autofix_diagnose.sh`
   
   ```bash
   #!/bin/bash
   # L1 只读诊断示例
   echo "=== System Diagnosis $(date) ==="
   echo "Disk: $(df -h / | tail -1)"
   echo "Memory: $(free -h | grep Mem)"
   echo "Top Processes: $(ps aux --sort=-%mem | head -5)"
   echo "Recent Errors: $(journalctl -u newme-platform --since "5 minutes ago" --no-pager | tail -10)"
   ```

3. **集成到 Hermes Worker**（需开发组在 hermes-worker 中添加调用逻辑）

---

## 四、自动修复安全边界（生产修正版）

**配置路径**: `/home/ubuntu/.hermes/config/autofix.yml`（非 `/etc/hermes/`）

### 操作分级
- **L1 只读诊断**（允许自动执行）: `journalctl` 查询、`df`/`free`、进程列表、Git 日志、Sentry 上下文获取
- **L2 温和操作**（需人工确认）: 服务重启（`systemctl restart`）、配置重载
- **L3 危险操作**（禁止自动）: 数据库回滚、数据删除、DNS 切换、防火墙变更、扩缩容

### 强制约束
1. **硬熔断**: 连续 3 次诊断脚本非零退出或超时，自动设置 `autofix.enabled: false`，并推送 "Autofix Circuit Opened"
2. **软熔断**: 1 小时内错误数 > 100，降级为仅告警不诊断
3. **人工熔断**: `hermesctl autofix pause --duration=2h`（需实现 hermesctl 工具）

### 审计要求
- 所有命令记录到 `/home/ubuntu/hermes-logs/autofix.log`
- 保留配置快照：`/home/ubuntu/.hermes/config/autofix.yml.bak.*`

---

## 五、启动条件清单（可验证）

| # | 条件 | 验证方式 | 责任方 |
|---|------|----------|--------|
| 1 | **基础设施监控就绪** | `fallocate -l 50G /tmp/testfile` 填满磁盘，验证 3 分钟内收到微信告警 | 运维 |
| 2 | **Hermes 三服务高可用** | `sudo systemctl stop hermes-bridge`，验证 2 分钟内服务自动重启并收到告警 | 架构 |
| 3 | **Sentry 服务端复活** | 手动触发 `/api/healthcheck/sentry-test`，验证 Issues 出现新事件 | 开发 |
| 4 | **Sentry 配额基线** | Web 控制台可见 Usage Alert 阈值 80%，Dynamic Sampling 规则已保存 | 运维 |
| 5 | **路径合规检查** | 验证所有脚本在 `/home/ubuntu/.hermes/scripts/`，日志在 `/home/ubuntu/hermes-logs/` | 运维 |

---

## 六、冻结规则（不可协商）

1. **🚫 P0-3（Hermes 高可用）未完成前，禁止启动 P1-1（Autofix）**  
   *理由：防止在底座不稳时叠加自动修复逻辑*

2. **🚫 Hermes 未通过单点故障演练（停止任一服务验证自愈）前，禁止承担生产告警路由**  
   *理由：防止告警静默*

3. **🚫 未建立 Sentry 配额监控前，禁止开启 Session Replay 全量采集**  
   *理由：防止配额耗尽丢弃关键错误*

4. **🚫 未定义告警分级降噪策略前，禁止开启全量告警通道**  
   *理由：防止告警疲劳*

5. **🚫 未通过混沌工程演练前，禁止开启 L2/L3 级自动修复**  
   *理由：防止误操作级联故障*

---

## 七、风险注册表（生产环境）

| 风险 ID | 风险描述 | 概率 % | 影响 | 缓解措施 | 责任方 |
|---------|----------|--------|------|----------|--------|
| R1 | **Hermes 三服务同时故障**：bridge/dashboard/worker 同时宕机导致全局静默 | 15% | 🔴 致命 | 1. 独立心跳监控<br>2. 降级直发通道（P0-6 直接微信）<br>3. systemd `Restart=always` | 架构组 |
| R2 | **Autofix 误操作**：脚本缺陷导致数据损坏（虽已限制 L1 但需防范） | 10% | 🔴 致命 | 1. 严格 L1 只读限制<br>2. 熔断机制<br>3. 配置快照回退 | 开发组 |
| R3 | **Sentry 配额耗尽**：突发流量导致 event volume 超配额 | 35% | 🟠 高 | 1. 80% 配额预警<br>2. 动态采样<br>3. 本地日志兜底 | 运维组 |
| R4 | **磁盘满导致日志丢失**：`/home/ubuntu` 分区满导致监控失效 | 25% | 🔴 致命 | 1. P0-2 磁盘监控<br>2. logrotate 配置<br>3. 独立分区检查 | 运维组 |
| R5 | **拨测凭证过期**：OAuth Token 失效导致假阴性 | 40% | 🟠 高 | 1. 凭证过期独立告警<br>2. 多账号轮换<br>3. Token 自动刷新 | 开发组 |
| R6 | **next.config.ts Patch 失败**：合并配置时破坏生产构建守卫 | 30% | 🔴 致命 | 1. 禁止全量替换<br>2. 预发环境构建验证<br>3. 快速回滚方案（`cp next.config.ts.bak.*`） | 开发组 |
| R7 | **告警疲劳**：噪声过多导致团队忽略关键告警 | 50% | 🟡 中 | 1. 告警分级（P0/P1/P2）<br>2. 降噪策略<br>3. 值班轮转 | 运维组 |
| R8 | **Supabase 连接池耗尽**：无监控导致雪崩 | 20% | 🟠 高 | 1. P0-5 连接池监控<br>2. 慢查询告警优化 | 开发组 |

---

## 八、next.config.ts 修改指南（Patch 指令）

**禁止操作**: 全量替换文件内容  
**必须保留**: 生产构建守卫（22-37 行）、CORS headers、withBundleAnalyzer 包裹顺序、deleteSourcemapsAfterUpload

### 具体 Patch 步骤

1. **定位插入点**（在 `experimental:` 对象内）:
   ```typescript
   experimental: {
     // 保留现有所有内容...
     
     // 新增开始
     serverComponentsExternalPackages: ["@sentry/node"],
     // 若使用 Turbopack 则添加，否则跳过
     turbo: {
       resolveAlias: {
         "require-in-the-middle": false,
         "@opentelemetry/instrumentation": false,
       },
     },
     // 新增结束
   },
   ```

2. **验证 Sentry 配置对象**:
   ```typescript
   sentry: {
     // 确保以下存在（若无则添加，若存在则保持不变）
     disableServerWebpackPlugin: false,
     autoInstrumentServerFunctions: true,
     deleteSourcemapsAfterUpload: true, // 必须保留
     // 保持 SENTRY_ORG 为实际值 newme-o4（从环境变量读取）
   }
   ```

3. **验证命令**:
   ```bash
   git diff next.config.ts  # 确认只修改了目标行
   npm run build           # 确认构建通过且守卫逻辑未触发退出
   ```

---

## 九、部署顺序（执行路线图）

```text
Day 1 (P0 基础)
├── 09:00 路径准备: mkdir -p /home/ubuntu/.hermes/scripts /home/ubuntu/hermes-logs
├── 09:30 P0-2: 部署 health_check.sh + 配置 ubuntu crontab (*/3)
├── 10:30 P0-3: 部署 hermes_ha_watchdog.sh + sudoers 配置 + crontab (*/1)
├── 14:00 P0-5: 部署 db_monitor.sh + 安装 postgresql-client
├── 15:00 P0-6: 部署 login_probe.sh + crontab (*/1)
└── 16:00 P0-4: 部署 sentry_quota_check.sh + 配置 Sentry Web 控制台采样规则
    └── [冻结点] 验证 Day 1 所有脚本路径正确，日志写入正常

Day 2 (P0 核心)
├── 09:00 P0-1: next.config.ts Patch（禁止全量替换）
├── 10:00 构建验证: npm run build（预发环境）
├── 14:00 生产部署: 重启服务，验证 Sentry 服务端 Issues 上报
└── 16:00 [验收] 执行启动条件 1-5 验证
    └── [冻结点] 未通过验证则禁止进入 P1

Day 3-7 (P0 稳定期)
├── 监控 P0 所有组件稳定性
├── 调整阈值（磁盘、内存、拨测超时）
└── 准备 P1 所需 Sentry Auth Token 等凭证

Week 2 (P1 启动)
├── P1-1: Autofix 配置（仅配置，不启用自动执行）
├── P1-2: 开启 Distributed Tracing
├── P1-3: 业务指标埋点（401/登录成功率）
└── [冻结点] Autofix 保持只读，禁止自动修复

Week 3-4 (P2)
├── P2-1: SLO 定义与错误预算仪表盘
├── P2-2: Issue → Linear 自动建票
└── P2-4: 混沌工程演练（验证 P0-3 高可用逻辑）
---

## 十、Phase 1 已部署（2026-07-21）

### 脚本位置
/opt/hermes-scripts/observability/
├── health-check.sh          # CPU/内存/磁盘/进程/服务健康
├── login-probe.sh           # 登录链路拨测 (health + auth/me)
└── supabase-pool-monitor.sh # Supabase REST API 可达性

### Crontab（待添加，ubuntu 用户）
```cron
# NewMe 可观测性 (2026-07-21)
*/3 * * * * /bin/bash /opt/hermes-scripts/observability/health-check.sh >> /tmp/hermes/health-check.log 2>&1
*/2 * * * * /bin/bash /opt/hermes-scripts/observability/login-probe.sh >> /tmp/hermes/login-probe.log 2>&1
*/5 * * * * /bin/bash /opt/hermes-scripts/observability/supabase-pool-monitor.sh >> /tmp/hermes/supabase-monitor.log 2>&1
```

添加命令: `(crontab -l 2>/dev/null; cat /tmp/new_crontab.txt) | crontab -`

---

## 十一、长期路线图：等待 instrumentation.ts 修复

### 阻塞现状

SAM-51 (2026-07-20): 6 次尝试修复 `instrumentation.ts` 均失败。
- 根因: Next.js 16 + Turbopack + Sentry `require-in-the-middle` 三方冲突
- 当前状态: **彻底禁用** — `register()` 是 no-op
- 服务端 crash 上报: **未启用**（仅客户端 Sentry 工作）

### 解除条件（任一满足）

| # | 条件 | 验证方式 |
|---|------|----------|
| 1 | Next.js 发布修复 `require-in-the-middle` 的版本 | 检查 GitHub release notes |
| 2 | Sentry SDK 发布 Turbopack 兼容版本 | `npm view @sentry/nextjs versions` + changelog |
| 3 | 社区发现 workaround（已验证） | 在 `/tmp/newme-build-` 隔离构建测试通过 |

### 跟踪机制

```bash
# 每周自动检查 (放在 crontab)
# 0 9 * * 1 curl -s https://api.github.com/repos/getsentry/sentry-javascript/releases | jq '.[0].tag_name'
```

### 解除后执行

1. 在 `/tmp/newme-build-` 隔离构建，设置 `ENABLE_INSTRUMENTATION=true`
2. 构建验证通过 → 灰度到 staging
3. Staging 24h 无 crash → 生产环境变量 `ENABLE_INSTRUMENTATION=true` + deploy
4. 验证 Sentry Issues 出现服务端错误
5. 关闭 SAM-51

**预计时间: 无法预测**（依赖 Sentry/Next.js 上游，可能数周到数月）

---

## 十二、长期架构：绕过 instrumentation.ts 的完整监控系统

### 核心认知

`instrumentation.ts` 被禁 → 失去了**服务端 Sentry 自动上报**这一个能力。
但监控系统不只有 Sentry 服务端。我们有 4 层可以独立建设：

```
                         Hermes 中央调度
                    接收→诊断→分级→路由→闭环
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────▼────┐          ┌────▼────┐          ┌─────▼─────┐
   │ 外部探针 │          │ Sentry  │          │ 基础设施   │
   │ (cron)  │          │ 客户端   │          │ (cron)    │
   │ ✅ 已建  │          │ ✅ 已有  │          │ ⏳ 整合   │
   └────┬────┘          └────┬────┘          └─────┬─────┘
        │                    │                     │
        │    ┌───────────────┤                     │
        │    │ 服务端 Sentry │  ← 🔒 阻塞          │
        │    │ (等待修复)    │                     │
        │    └───────────────┘                     │
        │                    │                     │
        └────────────────────┼─────────────────────┘
                             │
                    ┌────────▼────────┐
                    │   告警出口        │
                    │ 微信 / Telegram  │
                    │ Linear 自动建票   │
                    └─────────────────┘
```

### 四层能力矩阵

| 层 | 能力 | 当前状态 | 依赖 instrumentation.ts? |
|----|------|---------|--------------------------|
| **外部探针** | health / login / supabase 拨测 | ✅ Phase 1 已部署 | ❌ 不需要 |
| **Sentry 客户端** | 前端 crash / web vitals / replay | ✅ 运行中 | ❌ 不需要 |
| **基础设施** | CPU/内存/磁盘/进程 | ⏳ 已有 resource-alert.py 需整合 | ❌ 不需要 |
| **Sentry 服务端** | 服务端 crash / tracing / breadcrumbs | 🔒 SAM-51 阻塞 | ✅ 需要 |

### Phase 2: Sentry 告警 Webhook（本周，0 依赖）

不需要 instrumentation.ts。Sentry 客户端已经在收前端 crash。

**步骤：**
1. Sentry UI → Alerts → 创建规则：前端 error >5次/10分钟 → Webhook
2. Hermes 接收 Webhook → 解析 error type/URL/stack
3. 已知模式（如 #310 infinite loop）= 自动诊断报告
4. 推送到微信/Telegram

### Phase 3: 统一告警聚合（下周）

现状：6 个脚本各自输出到不同日志，没人看。

**目标：一个脚本读所有日志，分类推送 Hermes。**

```
alert-aggregator.sh (每分钟)
  ├── 读 /tmp/hermes/health-check.log 最后 3 行
  ├── 读 /tmp/hermes/login-probe.log 最后 3 行
  ├── 读 /tmp/hermes/supabase-monitor.log 最后 3 行
  ├── 读 /tmp/hermes/resource-alert.log 最后 3 行
  ├── 去重（同类型告警 10 分钟内不重复推）
  └── 推送 Hermes → 微信
```

### Phase 4: Hermes 自动诊断引擎（本月，只读模式）

只做诊断，不做修复。基于外部信号。

```
Hermes 收到告警 → 诊断剧本:
  health 挂 → journalctl -u newme-platform --since "5 min ago" | tail -50
  401 飙升 → curl localhost:3001/api/auth/me → 分析响应
  磁盘 >90% → du -sh /home/ubuntu/* | sort -rh | head -10 → 找大文件
  Supabase 不可达 → curl https://status.supabase.com/ → 确认是否平台故障
```

### Phase 5: 闭环（等 instrumentation.ts 修复后）

服务端 Sentry 回来后追加：
- 全链路 Tracing (proxy → route → Supabase)
- 错误预算仪表盘
- 自动回滚（已知故障模式）
- Linear 自动建票

### 现在 vs 完整版对比

| 能力 | 没有 instrumentation.ts | 有了 instrumentation.ts 后 |
|------|------------------------|---------------------------|
| 服务端 crash 发现 | ⚠️ 靠 health 探针间接发现 | ✅ Sentry 自动上报 + stack trace |
| 前端 crash 发现 | ✅ Sentry 客户端（已运行） | ✅ 不变 |
| 全链路追踪 | ❌ 没有 | ✅ proxy→route→Supabase 瀑布图 |
| 基础设施监控 | ✅ health-check.sh | ✅ 不变 |
| 拨测 | ✅ login-probe.sh | ✅ 不变 |
| 告警路由 | ✅ Hermes webhook | ✅ 不变 |
| 自动诊断 | ✅ 只读诊断（journalctl/curl/du） | ✅ 可加写操作 |

**结论：80% 的能力不需要 instrumentation.ts。先建外部系统，服务端 Sentry 是最后一块拼图。**
