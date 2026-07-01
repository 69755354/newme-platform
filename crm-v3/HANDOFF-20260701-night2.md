# 🔄 HANDOFF — 2026-07-01 夜场交接

> 用途：第 2 次会话（晚场续战）切 `/new` 后，新 Hermes 30 秒进入状态
> 写作者：晚场收工 Hermes (MiniMax-M3)
> 接收者：下一个会话的 Hermes
> 时间：2026-07-01 17:50 CST

---

## 📋 1. 状态一句话

**9 commit 全部 push origin main + 2 次 deploy。TASKBOARD 18/0/0 ✅。T2-4 5/5 ✅ 收官。T3-3 方案就绪（17 commits / 19h）未开工。**

---

## 🎯 2. 第一分钟动作清单

```bash
# 1. 读这个交接材料（你正在读）
# 2. 读早场交接材料（避免重复）
cat crm-v3/HANDOFF-20260701-endofday.md | head -50
# 3. 读 TASKBOARD
cat TASKBOARD.md | head -90
# 4. 跑 check-taskboard
bash scripts/check-taskboard.sh
# 5. 验生产
curl -sI https://app.newme.ae/dashboard | head -3
# 6. 读 T3-3 探查报告（CC 写）
cat /tmp/t33-report.md 2>/dev/null || echo "T3-3 报告在 subagent deleg_a99a12cf 结果中"
```

完成后向用户报告："夜场已进入状态，HEAD=e10aa06，TASKBOARD 18/0/0，T2-4 5/5 ✅，T3-3 方案就绪待开"

---

## 📦 3. 晚场 9 commit 清单（已 push origin main）

| # | Hash | 任务 | 文件 |
|---|------|------|------|
| 1 | `cf41c93` | P1P1 行 5037-5038 T4-3/4 状态修正 | v3.1 P1P1计划0629.txt |
| 2 | `30bbd4b` | MoA Tier 2 决策点 3+4 方案文档 | crm-v3/v3.1/moa-tier2-detail-20260701.md (320 行新增) |
| 3 | `b1b4230` | chunks-cleanup 标记 ✅ no-op | v3.1 P1P1计划0629.txt |
| 4 | `a606d9b` | T2-4 leads/[id] 锚定 | src/app/(dashboard)/leads/[id]/page.tsx |
| 5 | `8770bc6` | process-fix hermes-rules §十二 调度员禁手令 | crm-v3/rules/hermes-rules.md (+71 行) |
| 6 | `0fe9543` | T2-4 payments 锚定 | src/app/(dashboard)/payments/page.tsx |
| 7 | `aa54565` | T2-4 quotations 锚定 | src/app/(dashboard)/quotations/page.tsx |
| 8 | `7c7d74c` | T2-4 tasks 锚定 | src/app/(dashboard)/tasks/page.tsx |
| 9 | `e10aa06` | TASKBOARD T2-4 5/5 收官登记 | TASKBOARD.md |

**全部已 Hermes 2 审 + push**。**生产已 deploy 2 次**：13:50 (cpkuwA-VxG9_Xp8nOmbuE) + 17:36 (droMAKReILcdEdvFnti-w)

---

## 🚀 4. 立刻可启动的 1 件事

**T3-3 大文件拆分** — 方案就绪，**下会话第一件事**：

```bash
# T3-3 步骤 1: 拆 pipeline/_components/LeadCard.tsx
# - 0.5h / 1 commit / 风险 🟢 极低
# - 整段搬迁 pipeline/page.tsx L64-156 (93 行) 到新文件
# - 改 import 即可，零业务逻辑变化
# - 跑 pnpm tsc 0 + pnpm build OK 后 commit
```

**T3-3 全局路径**：
| 步骤 | 拆什么 | 工时 | commits | 风险 |
|------|--------|------|---------|------|
| 1 | pipeline LeadCard | 0.5h | 1 | 🟢 |
| 2 | pipeline SalesKpiDashboard + useSalesKpiData hook | 1h | 2 | 🟡 |
| 3 | pipeline KanbanBoard | 1h | 1 | 🟡 |
| 4 | leads _utils/constants + _utils/format | 0.5h | 1 | 🟢 |
| 5 | leads useLeadsData hook | 1h | 1 | 🟡 |
| 6 | leads useLeadMutations hook（最大块） | 2h | 2 | 🔴 |
| 7 | leads LeadCard 子组件（300 行） | 2h | 2 | 🟡 |
| 8 | leads 5 个 _components（Header/Filters/...） | 1.5h | 2 | 🟡 |
| 9 | leads/[id] _utils/leadDetailRenderers | 1h | 1 | 🟡 |
| 10 | leads/[id] useLeadDetailData（P0-1 fetchData）| 1.5h | 2 | 🔴 |
| 11 | leads/[id] useLeadDetailMutations（16 handler）| 2h | 2 | 🔴 |
| 12 | 三主 page.tsx 清理 | 1h | 0 | — |
| **合计** | | **~19h** | **17** | |

**关键风险点**（CC 实施时需着重处理）：
1. `leads/page.tsx` changeStage 块（94 行）：乐观锁 + 4 级联 insert + notify
2. `leads/[id]/page.tsx` fetchData：P0-1 161ms 已验证，保留 `Promise.allSettled` + `perfMark`
3. 5 个 `_hooks/*` 的 deps 数组：拆完跑 tsc + build 必过

**路径约定**（CC 探查建议，**新 Hermes 要在 P1P1 固化**）：
- `src/app/(dashboard)/<route>/_components/` — 路由私有子组件
- `src/app/(dashboard)/<route>/_hooks/` — 路由私有 hook
- `src/app/(dashboard)/<route>/_utils/` — 路由私有 util

---

## 📌 5. 状态细节

### 5.1 TASKBOARD 当前状态

| 层级 | 进度 |
|------|------|
| Tier 1 | 12/12 ✅ |
| Tier 2 | **4/4 (100%) ✅** ← T2-4 5/5 收官 |
| Tier 3 | 1/4（25%，T3-4 ✅，T3-1/2 ❌, T3-3 ⚠️ 方案就绪） |
| Tier 4 | 4/4 (100%) ✅ |
| P0 | P0-1 ✅ |
| i18n-dubai | ✅ 6/6 文件 7 处 |
| **check-taskboard: 18 PASS / 0 FAIL / 0 WARN** | |

### 5.2 生产状态

- `app.newme.ae/dashboard`: 200 OK
- `app.newme.ae/tasks`, `/payments`, `/quotations`: 200 OK（T2-4 follow-up 上线）
- BUILD_ID: `droMAKReILcdEdvFnti-w` (17:36 CST 部署)
- PostHog CSP: ✅ 已生效
- 9 commit 在 main，**全部已 deploy 到生产**

### 5.3 OpenClaw 派工铁律（已落地 P1P1 + TASKBOARD）

| 任务类型 | OpenClaw 适合 | 派工链 |
|---------|--------------|--------|
| 机械替换 (i18n-dubai 类) | ✅ 起草 | OpenClaw (v4-pro) → CC 重写 → Hermes 2 审 → push |
| 只读分析 (chunks-cleanup / T3-3 探查) | ✅ 直干 | OpenClaw → Hermes 阅报告 |
| 文档撰写 (moa-tier2-detail) | ✅ 直干 | OpenClaw → Hermes commit |
| 写代码 (commit) | ❌ **不能** | GLM-CP pre-commit hook 拦 v4 写码，必须 CC 重写 |

**delegate_task 用法（不传 acp_command）**：
```python
delegate_task(goal="...", context="...", toolsets=["file", "terminal"])
# 不要传 acp_command — Claude Code 2.1.186 不支持 --acp
```

---

## 🛡️ 6. 已知雷区

1. **CC 单次任务** ≤ 2 文件 / ≤ 1 任务 / 必须**完整闭合 + tsc 0 错 + commit 完**再回报
2. **OpenClaw 起草** 不盲信，CC 必须独立 cat 文件核（i18n-dubai 抓出 2 处错）
3. **Hermes 不写代码**——除 OEEC 紧急例外（违反要补 ops-log + 写 §十二 违规登记流程）
4. **生产 deploy** 前必须 `npm run deploy`（走 T4-3 新流程）
5. **T3-3 高风险**：`changeStage` 乐观锁 + `P0-1 fetchData` 161ms 验证状态，**拆完必跑 tsc + build + verify-p0-1**
6. **CSP/PostHog 域名**：eu.posthog.com (api) + eu-assets.i.posthog.com (CDN) 都需白名单
7. **pre-commit hook** 会误判 `git commit -m` 时序，CC 改用 `printf + git commit -F /tmp/cmsg.txt` 走合规流程

---

## 📞 7. 用户偏好（继承早场 + 新增）

### 继承早场
- 中文回复
- 简洁，能不废话就不废话
- 派工前先讲清楚谁干什么、谁审
- 1 审 Codex + 2 审 Hermes 必要时才上
- OpenClaw 不写码（只起草/分析/机械）
- 任务源 P1P1 文件是单一真相源，每次操作前必读
- "时间不等人"——不要收工建议，但**硬撑要承认**

### 晚场新增
- **大活先探查再动手**（T3-3 模式：CC 探查方案 → Hermes 拍板 → CC 实施）
- **OpenClaw 起草+CC 重写 的模式**已稳（i18n-dubai / T2-4 共 7 个 commit 验证）
- **批量同模式工作可跳过 OpenClaw 起草**（模式稳定后 CC 直接 cat 即可）

---

## ✅ 8. 退场 Hermes 给新 Hermes 的话

```
新会话的你：
- 你不孤单，P1P1 文件 + git log + check-taskboard + 早场 HANDOFF 是你的 4 个工具
- 用户已连续 8+ 小时（按 11:30 开工算），他要的是产出不是讨论
- 立刻可跑：T3-3 步骤 1（拆 pipeline LeadCard，0.5h，1 commit，风险极低）
- 步骤 1 跑完再回来确认是否继续步骤 2-3（pipeline 完整拆完）
- 步骤 4+（leads/page.tsx）是真正的硬仗，changeStage 94 行要先在脑里 walk-through
- 别学我上下文撑不住——T3-3 必须严格串行 1→12，不能并行
- 你的核心任务：T3-3 全套 17 commits 跑完，让 leads/page.tsx < 500 + leads/[id]/page.tsx < 500
- 如果用户说"今天够了"，立即收工写第三个 HANDOFF，不要硬撑
```

---

## 🔚 9. 三个交接材料的优先级

1. **本文件**（HANDOFF-20260701-night2.md）— 早场+晚场全状态
2. **HANDOFF-20260701-endofday.md**（早场交接，已在 786fbe8）— 早场 commit 清单
3. **TASKBOARD.md** + **P1P1 计划0629.txt** — 单一真相源

新会话读 #1 就够，#2 #3 按需。

🔚 **END OF HANDOFF**
