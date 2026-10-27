# NewMe CRM 可观测性审计报告
> 2026-06-12 | 当前状态：**裸奔** — 零错误追踪、零日志、零监控

> **2026-08-20 更正（本文档以下内容是当时的提案，不是现状）**：文中的 PostHog
> 方案曾经落地过，现已整体移除，前端不再采集任何真实用户指标。移除的三条理由都是
> 实测的：部署里的 project key 已失效（每个登录页多打两个 404 请求）、
> `session_recording` 配的是 `maskAllInputs: false` + `maskTextSelector: ""`
> ——在存客户联系方式的 CRM 上等于把输入框原文录进第三方、以及它注入的第三方脚本
> 与发布后浏览器闸门的同源策略冲突。要重新引入 RUM 的三个前置条件写在
> `docs/lighthouse-baseline.md`。Sentry 与后端结构化日志不受影响。

## 🔴 当前现状（全部缺失）

| 领域 | 状态 | 影响 |
|------|------|------|
| 前端错误追踪 | ❌ 无 | 销售遇到报错，我们完全不知道 |
| 前端Session回放 | ❌ 无 | 无法复现用户操作路径 |
| 后端结构化日志 | ❌ 只有console.error(141处) | 日志随进程消失，无法回溯 |
| API性能监控 | ❌ 无 | 不知道哪些接口慢、失败率高 |
| Admin Impersonate | ❌ 无 | 排查问题只能改用户密码（今天事故） |
| 审计日志 | ❌ 只有业务activities | 不知道谁在什么时候做了什么系统操作 |
| 健康检查 | ❌ 无 | 不知道服务是否活着 |
| 告警通知 | ❌ 无 | 服务挂了没人知道 |
| 用户反馈通道 | ❌ 无 | 销售有问题只能口头反馈 |
| 数据库监控 | ❌ 无 | 不知道慢查询、连接池状态 |
| 运行时性能 | ❌ 无 | 不知道前端渲染性能 |

## 完整清单：我们需要什么

### P0 — 没有=盲人运营（本周）

#### 1. 前端错误追踪 + Session Replay
**工具：PostHog**（开源，免费额度：5K recordings/月 + error tracking）
- 销售遇到JS错误 → 自动上报（含stack trace + 用户信息）
- Session Replay → 看到用户点了什么、在哪个页面卡住
- `posthog.captureException()` 捕获所有未处理异常
- 集成：1个`PostHogProvider`包裹layout + 10行代码

#### 2. 后端结构化日志
**工具：pino**（Node.js最快logger）
- 所有API路由的请求/响应/耗时/状态码
- 所有错误带context（userId, path, payload摘要）
- 写入文件（`/var/log/newme/`），不随进程消失
- 简单：pino中间件 + 替换141个console.error

#### 3. Admin Impersonate
**Supabase admin.generateLink({ type: 'magiclink' })**
- Admin面板一键"以XX身份登录"
- 不碰密码、不留永久token
- 操作带审计标记（`impersonated_by: admin_id`）
- 半天能做

#### 4. 健康检查端点
- `GET /api/health` → 返回DB连接、Supabase状态、版本号
- 供外部监控（UptimeRobot免费）ping
- 10分钟能做

### P1 — 运营必需（下周）

#### 5. 审计日志（Audit Log）
- 系统级操作记录表：`audit_logs(id, user_id, action, resource, detail, ip, created_at)`
- 覆盖：登录/密码修改/角色变更/数据导出/impersonate操作
- Admin面板可查看
- 区别于现有activities表（业务操作 vs 系统操作）

#### 6. API性能监控
- pino日志里已有耗时，加一个定期聚合
- 或者PostHog的`$http_request`事件
- 目标：知道哪些API >2s，哪些失败率>1%

#### 7. 告警通知
- 错误率突增 → TG群告警
- 服务不可用 → TG群告警
- 实现：PostHog webhook或简单的cron检查health端点

#### 8. 密码管理规范
- ✅ 已修：change-password API自动存hint
- 待做：创建用户时强制设hint
- 待做：admin面板显示hint（仅admin/boss可见）
- 待做：定期校验hint有效性（登录测试）

### P2 — 锦上添花（后续迭代）

#### 9. 用户反馈通道
- CRM内嵌"报告问题"按钮
- 自动附带：当前页面、用户角色、最近错误、浏览器信息
- 数据进audit_logs或独立表

#### 10. 数据库监控
- Supabase Dashboard自带（免费）
- 配置慢查询告警（>500ms）
- 连接池使用率监控

#### 11. 前端性能监控
- Core Web Vitals（LCP, FID, CLS）
- PostHog自带web analytics
- 知道哪个页面慢影响用户体验

#### 12. 运行时异常边界
- React ErrorBoundary包裹关键页面
- 错误时显示友好提示 + 上报PostHog
- 不再白屏

## 事故回顾：今天暴露的根因

| 事故 | 根因 | 对应解决方案 |
|------|------|-------------|
| 改了Faheem密码 | 没有Impersonate功能，只能改密码登录排查 | #3 Admin Impersonate |
| 不知道销售遇到什么错误 | 零前端错误追踪 | #1 PostHog Error Tracking |
| 不知道用户操作路径 | 零Session Replay | #1 PostHog Session Replay |
| 密码hint丢失 | change-password清空hint | #8 密码管理规范（已修） |
| 不知道服务是否正常 | 零健康检查 | #4 Health Endpoint |
| 排查全靠问人 | 零可观测性基础设施 | 全部 |

## 实施计划

### Day 1（今天）
- [ ] PostHog集成（前端错误追踪 + Session Replay）
- [ ] Health Check端点
- [ ] Admin Impersonate API

### Day 2
- [ ] pino结构化日志替换console.error
- [ ] 审计日志表 + 关键操作埋点
- [ ] TG告警bot

### Day 3
- [ ] 密码管理完善
- [ ] 用户反馈通道
- [ ] React ErrorBoundary

## 成本

| 工具 | 费用 |
|------|------|
| PostHog | 免费（5K sessions/月，我们~100用户远远够用） |
| pino | 开源，零费用 |
| UptimeRobot | 免费（50 monitors） |
| 总计 | **AED 0/月** |
