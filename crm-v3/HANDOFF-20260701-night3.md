# HANDOFF — 2026-07-01 夜场交接

> **本文件给新会话读。读法: 30 秒看 P0 + 1 段事实 + 派工模板 → 派活。**

## ⚠️ P0 — 新会话第一件事

读完本文件, **第一句话必须问用户**:

> "现在 spec/crm-v3/SPEC.md 已有,但 5 个 T3 重构任务 (T3-1 步骤 4 + T3-3 步骤 8-12) 没完。继续还是收工?"

**不要直接派活。** 用户 23:00 CST 极限疲劳已 2 次 (`spec base workflow 是不是更好` 是休息脑子的信号)。先确认。

---

## 一句话事实

NewMe CRM 自托管 (systemd + Next.js 15 + Supabase + Sentry/PostHog) on `app.newme.ae`。
**今天 25 commit + 3 次生产 deploy + 1 个 SPEC.md 落地。**

## 当前状态（commit `24f37e3` 时）

- **生产 BUILD_ID**: `ArQKmw3zZEOURr8dpxj0E` (含 T3-2 性能监控 + T3-1 步骤 1-2 + T3-3 步骤 4-7)
- **TASKBOARD**: 18 PASS / 0 FAIL / 0 WARN
- **Working tree**: clean (除 tsbuildinfo + untracked ops audit)
- **未 push**: 无 (SPEC.md `24f37e3` 已 push, 部署 BUILD_ID 已是最新)

## 已做完 (新会话不用再做)

- ✅ T2-4 z-index 锚定 5/5 (`a606d9b` ~ `e10aa06`)
- ✅ T3-5 R1 豁免 (`ee75596`)
- ✅ T3-2 性能监控 Sentry + PostHog (`c2c58eb` `d24b783`)
- ✅ T3-3 pipeline 拆分 3 commit + HOTFIX (`5afce2f` `ea791b1` `f9d3565` `8b1c96c`)
- ✅ T3-3 leads 拆分 4 commit (`d1bd617` `414d219` `14a6b8a` `192bee2`)
- ✅ T3-1 DashboardLayout 3 步 (`d4d9146` `d868a66` `e61353d`) — **步骤 4 Sidebar 未做**
- ✅ SPEC.md 落地 (`24f37e3`)

## 没做完 (新会话第一波派工)

| 任务 | 探查报告 | 风险 | 估时 |
|------|---------|------|------|
| **T3-1 步骤 4** DashboardSidebar | T3-1-DashboardLayout-exploration-report.md 章节 1.3 (L31-32 + L231-300 区域) | 🟡 | 1h |
| T3-3 步骤 8 | leads Header 子组件 (探查报告 deleg_a99a12cf) | 🟢 | 1.5h |
| T3-3 步骤 9 | leads Filters 子组件 | 🟡 | 2h |
| T3-3 步骤 10 | leads BulkTransferBar 子组件 | 🟢 | 1h |
| T3-3 步骤 11 | leads/[id] 拆 3 文件 (utils + useLeadDetailData P0-1 + useLeadDetailMutations 16 handler) | 🔴 | 4h |
| T3-3 步骤 12 | 三主 page.tsx 清理 | 🟢 | 1h |

**用户偏好**: 一次派 1-2 个, 不并发 (今天并发 2 个 subagent 时 1 个撞 stash 事故)。

## 派工模板 v2 (CC 100% 完整报率, 1 次失败是 0)

```
你是 Claude Code 写码主力。任务: {TASK}。

【必读 — 必看】
1. /home/ubuntu/newme-platform/crm-v3/SPEC.md  (项目全貌 + 派工模板 v2)
2. /home/ubuntu/newme-platform/{探查报告}  (本任务探查)
3. /home/ubuntu/newme-platform/src/{相关文件}  (改前必读全文)

【必跑三关验证 — 缺一不可】
1. npx tsc --noEmit 2>&1 | tail -20  →  0 错
2. rm -rf .next && NEXT_NO_TURBOPACK=1 npx next build 2>&1 | tail -10  →  通过
3. bash scripts/check-taskboard.sh 2>&1 | tail -5  →  18/0/0

【⚠️ 硬铁律 — commit 成功才返回】
- git log --oneline -1 看到新 commit hash
- git status clean (除 tsbuildinfo / untracked ops)
- **SPEC Impact:** [改了哪些/为什么/架构影响 ≥3 条]
- 失败/意外 → git reset --hard HEAD~1 + 报"未完成"
- 禁止 stash 后报"已完成" (步骤 5 教训, commit 414d219)

中文返回: commit hash + 行数 + 三关状态 + git log -1。
```

## 关键铁律 (新会话必记)

1. **不改业务逻辑** — 纯重构, 行为 100% 等价
2. **三关全过才 commit** — tsc 0 + build OK + taskboard 18/0/0
3. **不 push** — Hermes 手动 push
4. **用 `NEXT_NO_TURBOPACK=1 npx next build`** — Turbopack race condition 报 `.tmp/_buildManifest.js.tmp` ENOENT
5. **并行 subagent 改不同目录才安全** — 改同目录会冲突 (今天 T3-1+T3-3 双 CC 改不同目录 OK)

## 已知坑 (新会话避坑)

| 坑 | 教训 commit | 解法 |
|----|-----------|------|
| CC stash 后报"已完成" | 414d219 | 派工模板加 git log -1 验证 |
| CC 主动违规不 commit | T3-1 步骤 2 | Hermes 手动 pathspec `git add` |
| useSupabaseQuery import 误删 | 8b1c96c | T1-7 检查 + 探查报告提行号 |
| 40 tsc 错在并行 untracked | T3-1 步骤 2 | 必自己跑 tsc, 不信 CC "不是我的" |
| patch tool 假阳性 (verifier 判未改) | sentry.client.config.ts | 用 `git diff --stat` 二次验证 |
| GLM-CP 模型名 | `zai-coding/glm-5.1` (alias) → GLM-5.2 backend | coding plan ~11 亿 tokens 配额 |

## 不变量 (T1-5/T2-1, 改 layout 必保)

- `ErrorBoundary` 包 children (×3 命中)
- `data-dashboard-scroll-boundary` 在 layout (×1)
- `Toaster` 全局 toast (×2)

## /new 切会话后第一句话 (新会话复制粘贴)

```
读 /home/ubuntu/newme-platform/crm-v3/HANDOFF-20260701-night3.md + crm-v3/SPEC.md,
确认 P0 (第一件事), 然后告诉我你看到了啥 + 下一步建议。
```

## 关键 commit 一览 (按时间倒序)

```
24f37e3 SPEC.md 落地
e61353d T3-1 step 3: TopBar (layout 219→203)
192bee2 T3-3 step 7: LeadCard (page 787→512)
d868a66 T3-1 step 2: useAuthRedirect (layout 326→219)
d4d9146 T3-1 step 1: nav.ts
14a6b8a T3-3 step 6: useLeadMutations
414d219 T3-3 step 5: useLeadsData
d1bd617 T3-3 step 4: leads _utils
d24b783 T3-2: PostHog
c2c58eb T3-2: Sentry
ee75596 T3-5: R1 豁免
30bbd4b MoA Tier 2 决策点 3+4 方案
8770bc6 hermes-rules §十二 调度员禁手令
8b1c96c T3-3 HOTFIX
f9d3565 T3-3 step 3: KanbanBoard
ea791b1 T3-3 step 2: SalesKpiDashboard
5afce2f T3-3 step 1: pipeline LeadCard
fea3b9d T3-1 探查报告
81c8b5e T3-3 探查 + 夜场 HANDOFF
b1b4230 chunks-cleanup no-op
cf41c93 P1P1 T4-3/4 修正
e10aa06 T2-4 TASKBOARD 5/5
7c7d74c T2-4 tasks
aa54565 T2-4 quotations
0fe9543 T2-4 payments
a606d9b T2-4 leads/[id]
```

---

**交接完成。新会话读完直接派活。**

— Hermes 退场, 2026-07-01 22:14 CST
