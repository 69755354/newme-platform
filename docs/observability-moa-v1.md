# NewMe 可观测性方案 v1.0
## MoA 评审稿 · 2026-07-20

---

## 一、背景

今日 L0 登录故障（SAM-50）由员工报告发现，系统自身无任何感知能力。
复盘发现：我们有 Sentry，但只用了客户端 crash 捕获这一个能力，
服务端追踪因构建 bug 实际已瘫痪。

**核心矛盾：** 工具已有，能力未激活；感知靠人，不是靠系统。

---

## 二、目标

建成一个**以 Sentry 为底座、零新增成本**的可观测性系统，
不等用户报告，系统自己知道出问题。

分三期：
- **P0（本周）：有感知** —— 服务端复活 + 拨测 + 告警
- **P1（下周）：可诊断** —— Tracing + 业务指标
- **P2（本月）：能闭环** —— 错误预算 + 自动建票

---

## 三、OS 能力矩阵（Sentry 能做什么，补什么）

### Sentry 承担（激活已有能力）

| # | OS 能力 | Sentry 功能 | 当前状态 | P0/P1 |
|---|---------|------------|---------|-------|
| S1 | 服务端 crash | Issues | ❌ 因构建 bug 已禁 | P0 复活 |
| S2 | 前端 crash + 体验 | Issues + Replay | ✅ 运行中 | — |
| S3 | 全链路追踪 | Distributed Tracing | ❌ 未开 | P1 开启 |
| S4 | 前端性能劣化 | Web Vitals | ❌ 未开 | P1 开启 |
| S5 | 业务指标突变 | Custom Metrics | ❌ 未埋点 | P1 埋点 |
| S6 | 错误上下文 | Breadcrumbs | ⚠️ 客户端有/服务端缺 | P0 随复活 |
| S7 | 版本 ↔ 错误关联 | Release Tracking | ⚠️ 配了但未关联 deploy | P0 CI 加一步 |
| S8 | 告警规则 | Alert Rules | ❌ 未设 | P0 配规则 |
| S9 | Session 回放 | Replay | ❓ 未确认 | P1 开启 |
| S10 | 去重收敛 | Issue Grouping | ✅ 自带 | — |

### 外部补充（Sentry 做不了的事）

| # | OS 能力 | 实现方式 | 成本 | P0/P1 |
|---|---------|---------|------|-------|
| E1 | 功能感知（登录拨测） | 1 个 cron job，curl 登录全链路 | 0 | P0 |
| E2 | 告警通道（微信/Telegram） | Sentry Webhook → Hermes 推送 | 0 | P0 |
| E3 | 闭环（Issue → Linear） | Sentry Webhook → Hermes → Linear API | 0 | P1 |
| E4 | CI 失败 / Deploy 回滚通知 | GitHub Webhook → Hermes | 0 | P1 |

---

## 四、分阶段任务

### P0：有感知（本周，约 4 项）

| ID | 任务 | 依赖 | 产出 |
|----|------|------|------|
| P0-1 | 修复 Sentry 服务端 instrumentation 构建 bug | 需定位 `require-in-the-middle` 打包兼容方案 | 服务端 crash 自动上报 |
| P0-2 | 配置 Sentry Alert Rules | S1 复活后 | L0 故障自动告警 |
| P0-3 | Sentry Webhook → Hermes → 微信推送 | E2 | 告警推送到人 |
| P0-4 | 登录拨测 cron | E1 | 比用户更快发现登录异常 |

**P0 验收标准：** 人为制造一个 500，1 分钟内收到微信告警。
**P0 风险：** P0-1 的 Sentry 复活依赖解决 Next.js 16 + Turbopack + Sentry `require-in-the-middle` 兼容问题，可能阻塞。

### P1：可诊断（下周，约 5 项）

| ID | 任务 | 依赖 |
|----|------|------|
| P1-1 | 开启 Distributed Tracing（proxy → route → Supabase） | P0-1 |
| P1-2 | 开启 Web Vitals 性能追踪 | — |
| P1-3 | 埋点：401 计数、登录成功率 | P0-1 |
| P1-4 | CI 加一步关联 Release 到 Sentry | — |
| P1-5 | CI 失败 / Deploy 回滚 → 微信通知 | — |

**P1 验收标准：** 一次部署后，能在 Sentry 看到新版本的错误率、Tracing 瀑布图、
401 突变曲线。

### P2：能闭环（本月，约 4 项）

| ID | 任务 | 依赖 |
|----|------|------|
| P2-1 | 定义 SLO：登录可用性 > 99.9% | P1-3 |
| P2-2 | Sentry Issue → Linear 自动建票 | E3 |
| P2-3 | Session Replay 开启 + 采样 | P0-1 |
| P2-4 | **Hermes 自动诊断引擎**：已知故障模式自动识别 + 尝试修复 | P1-3 |

**P2-4 说明：** Hermes 接收 Sentry webhook 告警后，不再仅转发给人，
而是执行诊断脚本判定故障类型（proxy 401 飙升 → 检查最近部署 / RLS 状态；
health 挂 → 检查 process / memory / journalctl），对已知可自动恢复的模式
（如回滚到上一版本）自动执行，仅在无法自动修复时推给人。

---

## 五、不做的

- 不上 UptimeRobot / Datadog / Grafana（Sentry 覆盖了核心能力）
- 不做全栈日志中心化（量太小，Supabase + journalctl 够用）
- 不追求 100% 覆盖（先覆盖 L0 路径和高频 P0 场景）

---

## 六、成本

| 类别 | 增量成本 |
|------|---------|
| Sentry 费用 | 0（已有 Plan，能力均在配额内） |
| 新工具 | 0 |
| 基础设施 | 0（cron + webhook 均用现有 Hermes） |
| 人力 | 约 3-5 人天（P0 约 1 天，P1 约 2-3 天） |

---

## 七、决策（已定）

1. **Sentry 复活：接受修改 next.config.ts，但不接受风险**
   → 修复必须过完整流程（OC → 构建验证 → K3 审计 → deploy），回滚必须可用。
     不接受"禁用 Sentry"作为永久方案。
2. **Hermes 接报警 + 自修**
   → 告警不推给人，推给 Hermes。已知故障模式（如 401 飙升、health 挂）自动诊断并尝试修复。
     新增 P2-4：Hermes 自动诊断引擎。
3. **全量交付：P0 + P1 + P2 全部**

---

## 八、启动 MoA 评审
