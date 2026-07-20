# Sentry UI 配置指南（手机可操作）

## 前提

- Sentry 账号: 登录 https://sentry.io
- Organization: **newme-o4**
- Project: **javascript-nextjs**

---

## 一、Alert Rules（3 条规则，5 分钟）

### 规则 1: 前端错误飙升

1. 打开 https://newme-o4.sentry.io/alerts/rules/?project=4511552277512272
2. 点 **Create Alert** → 选 **Issues**
3. 条件:
   - `events` from `newme-o4` `javascript-nextjs`
   - `level` is `error`
   - `environment` is `production`
4. 阈值: `Number of events` > `5` in `10 minutes`
5. 动作: 先存 Webhook（第二步配），暂选 **Send a notification**
6. 命名: `[Frontend] Error Spike (>5 events/10min)`

### 规则 2: 性能劣化

1. 点 **Create Alert** → 选 **Performance**
2. 条件:
   - `p95(transaction.duration)` > `4000ms` for `5 minutes`
   - 筛选: `transaction` starts with `/`
3. 命名: `[Performance] P95 > 4s for 5min`

### 规则 3: HTTP 5xx 错误率

1. 点 **Create Alert** → 选 **Issues**
2. 条件：HTTP 5xx 事件在 5 分钟内超过阈值
3. 命名: `[HTTP] 5xx Error Rate > 1%`

---

## 二、Webhook → Hermes（5 分钟）

### Sentry 侧

1. Settings → Developer Settings → **Internal Integrations**
2. **New Internal Integration**
3. 名称: `Hermes Alert Bridge`
4. 权限: 勾选 `Issue & Event` → Read
5. Webhook URL: `https://hermes.newme.ae/api/sentry-webhook`（待部署，先填占位）
6. 勾选 alerts: `event_alert`, `metric_alert`, `issue`
7. **Save** → 复制 Webhook Secret

### Hermes 侧（待 Phase 2 实现）

接收 Webhook POST → 解析 `event.type / event.title / event.web_url` → 推微信/Telegram

---

## 三、Cron Monitoring（3 个 Monitor，5 分钟）

### 先决

需要完整的 SENTRY_DSN（当前 `.env.local` 中 key 被截断）。
获取方式: `coscmd download _cattle/hermes-config/credentials/sentry.json /tmp/sentry.json`

### Sentry UI

1. 打开 https://newme-o4.sentry.io/crons/
2. **Create Monitor**
3. Monitor 1:
   - 名称: `health-check`
   - Schedule: `*/5 * * * *` (Crontab)
   - Check-in margin: 2 minutes
   - Max runtime: 1 minute
4. Monitor 2:
   - 名称: `login-probe`
   - Schedule: `*/5 * * * *`
   - Check-in margin: 2 minutes
5. Monitor 3:
   - 名称: `supabase-monitor`
   - Schedule: `*/10 * * * *`
   - Check-in margin: 3 minutes

创建后每个 Monitor 会得到一个 `MONITOR_SLUG`，填入脚本 `sentry-cron-checkin.sh`。

---

## 四、Release Tracking（需 SENTRY_AUTH_TOKEN）

1. 获取 token: `coscmd download _cattle/hermes-config/credentials/sentry.json /tmp/sentry.json`
2. 设置环境变量: `export SENTRY_AUTH_TOKEN=$(jq -r '.auth_token' /tmp/sentry.json)`
3. 脚本已就绪: `/opt/hermes-scripts/observability/sentry-release.sh`

---

## 五、完成后验证

1. 造一个前端错误 → Sentry Issues 应出现 → 10 分钟内应有 Alert 通知
2. 人为关停 newme-platform → Cron Monitor 应在 5+2=7 分钟内报 missed check-in
3. 部署一次 → Sentry Releases 应出现新版本

**当前已部署的准备代码:**
- `/opt/hermes-scripts/observability/sentry-cron-checkin.sh` (Cron Monitor 心跳)
- `/opt/hermes-scripts/observability/sentry-release.sh` (Release 关联)
- `infra/observability/` (Git 同步)
