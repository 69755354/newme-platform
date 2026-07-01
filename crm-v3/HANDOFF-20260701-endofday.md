# 🔄 HANDOFF — 2026-07-01 收工交接

> 用途：当前 Hermes 会话因上下文长度撑不住，切 `/new` 新会话时**新 Hermes 30 秒内进入状态**
> 写作者：即将退场的 Hermes (MiniMax-M3)
> 接收者：下一个会话的 Hermes
> 时间：2026-07-01 16:10 CST (commit 18525f1 时刻)

---

## 📋 1. 状态一句话

**今天 8 commit 已 push origin main（18525f1 HEAD），TASKBOARD 18/0/0 ✅，生产未 deploy。**
继续做 T2-4 follow-up（剩 4 页）/ verify-p0-1 / chunks-cleanup / moa-tier2-detail。

---

## 🎯 2. 第一分钟动作清单（新会话必跑）

```bash
# 1. 读这份交接材料（你正在读）
# 2. 读 P1P1 文件（任务源）
cat "crm-v3/v3.1/v3.1 P1P1计划0629.txt" | head -100  # 顶部摘要
# 3. 读 git 状态
cd /home/ubuntu/newme-platform && git log --oneline -10
# 4. 跑 check-taskboard
bash scripts/check-taskboard.sh
# 5. 验生产
curl -sI https://app.newme.ae/dashboard | head -5
```

完成后向用户报告："已进入状态，HEAD=18525f1，TASKBOARD 18/0/0，待办 N 项"

---

## 📦 3. 今日 8 commit 清单（已 push origin main）

| # | Hash | 任务 | 文件 |
|---|------|------|------|
| 1 | `5d7b60b` | T4-3 + T4-4 | scripts/deploy.sh + package.json (+nginx /etc/nginx/sites-enabled/newme-platform) |
| 2 | `1ac84ca` | T2-4 锚定 1/5 | src/app/(dashboard)/leads/page.tsx |
| 3-8 | `4dfcafc/c00a07e/17df4aa/ca7421c/aafba1b/18525f1` | i18n-dubai 6 文件 7 处 | leads/page, leads/[id]/timeline, quotations/page, quotations/[id]/page, tasks/page, tasks/[id]/page |

**全部已 1 审 (Codex deleg_077af8d9) + 2 审 (Hermes spot check) + push**。
**生产未 deploy**——BUILD_ID 仍是 `6rXVcdEAiHfV2_pneoln0`（上次部署的旧版）。

---

## ✅ 4. TASKBOARD 当前状态

| 层级 | 进度 |
|------|------|
| Tier 1 | 12/12 ✅ |
| Tier 2 | 3.2/4（80%，T2-4 ⚠️ 1/5）|
| Tier 3 | 1/4（25%，T3-4 ✅，剩 T3-1/2/3/5）|
| Tier 4 | **4/4 (100%) ✅** |
| P0 | P0-1 ✅（已收，等用户手机实测 verify-p0-1）|
| i18n-dubai | ✅ 6/6 文件 7 处 |

**check-taskboard: 18 PASS / 0 FAIL / 0 WARN**（脚本能识别的任务，不含新立的 T2-4/i18n-dubai/T3/T4-3/4）

---

## 📝 5. P1P1 文件是唯一真相源

路径：`crm-v3/v3.1/v3.1 P1P1计划0629.txt`（约 5350 行）

**结构**：
- 行 5028-5032: Tier 3 任务（T3-1/2/3/5 ❌）
- 行 5035-5038: Tier 4 任务（T4-1/2 ✅, T4-3/4 待改 ❌ ← 实际已收，见 §6 修正）
- 行 5210-5255: 实时 todo 全量清单（i18n-dubai/T2-4 follow-up/chunks-cleanup/hermes-ci/moa-tier2-detail/process-fix/business-*）
- 行 5286-5335: 🤖 OpenClaw 派工验证报告（铁律：起草不写）
- 行 5336+: 单一真相源铁律

⚠️ **P1P1 文件可能与 TASKBOARD 有 30 秒延迟**——以 TASKBOARD 为准时，**也改 P1P1**。

---

## 🚨 6. 紧急修正：P1P1 与 TASKBOARD 不一致

**问题**：今天 16:00 push 8 commit 时，**P1P1 文件行 5037-5038 把 T4-3/T4-4 还标为 ❌**。但实际 commit `5d7b60b` 已收。

**修正**（新会话第一件事或用户先做）：

```bash
# 在 P1P1 文件行 5037-5038 附近
# 改：T4-3 ❌ 待开
# 为：T4-3 ✅ 2026-07-01 (commit 5d7b60b, deploy.sh + package.json + nginx CSP)
# 改：T4-4 ❌ 待开
# 为：T4-4 ✅ 2026-07-01 (nginx 改完 + reload, 生产 200 + CSP 头返回)
```

**TASKBOARD 已经在 16:00 同步过**（T2-4 ⚠️ / T4-3 ✅ / T4-4 ✅），但 P1P1 没改。**这是新会话第一件执行项**。

---

## 📌 7. 立刻可启动的 3 件事

| # | 任务 | 派工路径 | 预计 | 阻塞 |
|---|------|----------|------|------|
| **A** | **T2-4 follow-up: leads/[id] 锚定** (935 行, 三列布局) | OpenClaw 起草 → CC 重写 (deleg_task, 不用 acp_command) | 5-10 min | 无 |
| **B** | **T2-4 follow-up: payments 锚定** (809 行) | CC 写 (单页) | 3-5 min | 无 |
| **C** | **npm run deploy** 把 8 commit 部署到生产 | 用户点头 → 我跑 | 5 min | 用户 |

**A 串 B 还是并行**：A 涉及 leads/[id]/LeadSalesProcess/LeadCustomerProfile 等子组件，需要小心 → 串行。
**B 独立可并行**。

---

## 🎯 8. 中长期待办（按优先级）

1. **verify-p0-1** — 用户手机实测 P0-1 性能，<5s / <50 请求（**用户执行**）
2. **T2-4 follow-up** 4 页（leads/[id] / payments / quotations / tasks）—— 锚定功能卡片
3. **t2-1-followup** 22 页接入 DashboardScrollContainer（OpenClaw 起草 + CC 重写）
4. **T3-1** DashboardLayout 统一（方案A，6+ 页重构，高风险）
5. **T3-3** 大文件拆分（leads 1108 / pipeline 689，<500 行/文件）
6. **T3-2** 性能监控+告警（待选工具）
7. **T3-5** profiles.email vs R1 矛盾（待决策）
8. **chunks-cleanup** 0~14i8bodcp 死引用（OpenClaw 直干）
9. **moa-tier2-detail** 决策点 3+4 方案细化（OpenClaw 直干）
10. **process-fix** hermes-rules §十二 禁手令（CC 写）
11. **hermes-ci** GitHub webhook 订阅（**等用户确认 repo 路径**）
12. **业务 9 项** (leads-new/payments/contracts/...）— 等业务方排期

---

## 🤖 9. OpenClaw 派工铁律（已落地 P1P1）

| 任务类型 | OpenClaw 适合 | 派工链 |
|---------|--------------|--------|
| 机械替换 (i18n-dubai 类) | ✅ 起草 | OpenClaw (v4-pro) → CC 重写 → Codex 1 审 → Hermes 2 审 → push |
| 只读分析 (chunks-cleanup) | ✅ 直干 | OpenClaw → Hermes 阅报告 |
| 文档撰写 (moa-tier2-detail) | ✅ 直干 | OpenClaw → Hermes 阅 |
| 写代码 (commit) | ❌ **不能** | GLM-CP pre-commit hook 拦 v4 写码，必须 CC 重写 |

**delegate_task 用法（不传 acp_command）**：
```python
delegate_task(
  goal="...",
  context="...",
  toolsets=["file", "terminal"]
)
# 不要传 acp_command — Claude Code 2.1.186 不支持 --acp
```

---

## 🛡️ 10. 已知雷区

1. **CC 单次任务** ≤ 2 文件 / ≤ 1 任务 / 必须**完整闭合 + tsc 0 错 + commit 完**再回报
2. **OpenClaw 起草** 不盲信，CC 必须独立 cat 文件核（i18n-dubai 抓出 2 处错）
3. **Hermes 不写代码**——除 OEEC 紧急例外（违反要补 ops-log）
4. **生产 deploy** 前必须 `npm run deploy`（走 T4-3 新流程）
5. **CSP/PostHog 域名**：eu.posthog.com (api) + eu-assets.i.posthog.com (CDN) 都需白名单

---

## 📊 11. 当前生产状态

- `app.newme.ae/dashboard`: 200 OK, 42ms
- BUILD_ID: `6rXVcdEAiHfV2_pneoln0` (上次 webpack 部署，2026-07-01 13:50)
- PostHog CSP: ✅ 已生效
- 8 commit 在 main，未 deploy 到生产

---

## 📞 12. 用户偏好（必须继承）

- 中文回复
- 简洁，能不废话就不废话
- 派工前先讲清楚谁干什么、谁审
- 1 审 Codex + 2 审 Hermes 必要时才上
- OpenClaw 不写码（只起草/分析/机械）
- 任务源 P1P1 文件是单一真相源，每次操作前必读
- "时间不等人"——不要收工建议，但**硬撑要承认**

---

## ✅ 13. 退场 Hermes 给新 Hermes 的话

```
新会话的你：
- 你不孤单，P1P1 文件 + git log + check-taskboard 是你的 3 个工具
- 用户已经累了 7 小时+（按 11:30 开工算），他要的是产出不是讨论
- 立刻可跑：T2-4 leads/[id] 锚定（让 OpenClaw 起草 + CC 重写 1 页 1 页来）
- 立刻可做：npm run deploy（但要先问用户）
- 别做没必要的"全栈核对"——我刚做过，你信 P1P1 文件
- 你的 5 件事优先级：CSP/PostHog 已在生产 / 8 commit 在 main / TASKBOARD 同步 / OpenClaw 铁律
- 别学我上下文撑不住——2 个 T2-4 页面就让 CC 干，别一次 5 页
```

---

🔚 **END OF HANDOFF**
