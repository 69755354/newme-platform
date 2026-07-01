# SPEC — NewMe CRM

> ⚠️ **COMPACT 后:用户最后 3 条消息 > 本文件 > handoff 摘要**
> (本文件是参考手册,不是圣经。compaction 时用户的尾消息是唯一权威。)

## 项目一句话
NewMe CRM 自托管 (systemd + Next.js 15 + Supabase + Sentry/PostHog) on `app.newme.ae`。

## 当前状态（写时 commit `6fb1860`）
- **Branch**: `main` @ `6fb1860`
- **生产 BUILD_ID**: `ArQKmw3zZEOURr8dpxj0E` (T3-1 + T3-3 step 8+10+12+9 待 deploy)
- **TASKBOARD**: 18 PASS / 0 FAIL / 0 WARN
- **今日 commit**: 33（3 次生产 deploy + T3-1 step 4 + T3-3 step 8+10+12/9/11 全部 push）

## 架构关键
| 路径 | 职责 | 风险 |
|------|------|------|
| `src/app/(dashboard)/layout.tsx` | DashboardLayout 92 行 | 🟢 T3-1 完成 |
| `src/components/dashboard/DashboardSidebar.tsx` | Sidebar + mobile button + overlay 169 行 | 🟢 新建 |
| `src/components/dashboard/DashboardTopBar.tsx` | Top header 75 行 | 🟢 拆完 |
| `src/app/(dashboard)/leads/page.tsx` | Leads 列表 415 行 | 🟢 T3-3 step 8+9+10+12 完成 |
| `src/app/(dashboard)/leads/_components/LeadCard.tsx` | Lead 卡片 510 行 | 🟢 拆完 |
| `src/app/(dashboard)/leads/_components/LeadsHeader.tsx` | Header + sticky page-title 108 行 | 🟢 新建 |
| `src/app/(dashboard)/leads/_components/LeadsFilters.tsx` | Filter row 198 行 | 🟢 新建 |
| `src/app/(dashboard)/leads/_components/LeadsBulkTransferBar.tsx` | 批量转移 sticky bar 122 行 | 🟢 新建 |
| `src/app/(dashboard)/leads/[id]/page.tsx` | Lead Detail 540 行 | 🟢 T3-3 step 11 完成 |
| `src/app/(dashboard)/leads/[id]/useLeadDetailData.ts` | Detail 数据 hook (318 行,fetchData + 11 state + 16 查询) | 🟢 新建 |
| `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts` | Detail 写 hook (445 行,12 handlers) | 🟢 新建 |
| `src/app/(dashboard)/pipeline/page.tsx` | Pipeline Kanban 146 行 | 🟢 拆完 |
| `src/hooks/useAuthRedirect.ts` | DashboardLayout auth (157 行) | 🟢 拆完 |
| `src/hooks/useSupabaseQuery.ts` | 数据 query hook (timeout 8s + retry 2) | T1-1 freeze 仅限 query |
| `src/lib/nav.ts` | 全部 nav 配置 65 行 | 🟢 拆完（仅 Sidebar 引用）|
| `src/lib/supabaseQuery.ts` | useSupabaseQuery hook | T1-1 freeze |

## 设计决策（为什么这么做）

- **不用 Turbopack build** — race condition bug（`.tmp/_buildManifest.js.tmp` ENOENT），统一 `NEXT_NO_TURBOPACK=1 npx next build`
- **useSupabaseQuery 替代 Promise.all** — 解决 3-4s 串行延迟，并行 + retry
- **self-hosted systemd 不上 Vercel** — 数据所有权 + 部署可控
- **T3-5 方案 B (R1 豁免)** — `profiles.email` 由 auth.users trigger 同步，R1 规则（业务层不写 email）保留，扫全仓 20+ 处风险大已弃
- **CC subagent 必跑三关** — tsc 0 + build OK + check-taskboard 18/0/0 才算完成
- **派工不靠 CC 自己报"已完成"** — 必须 `git log --oneline -1` 看到新 hash 才回报（步骤 5 stash 教训）
- **SPEC.md 半自动** — CC 在 commit 报里附 `**SPEC Impact**:` 段，Hermes 决定写不写

## 当前工作流

1. **任务派工** — Hermes 读探查报告 → 派给 CC (GLM-CP) → CC 写代码 → commit
2. **三关验证** — tsc 0 → build OK → check-taskboard 18/0/0（全在 `pre-push` hook 自动跑）
3. **push** — Hermes 手动 `git push origin main`
4. **deploy** — `npm run deploy` → `scripts/deploy.sh` 4 步（build → verify BUILD_ID → restart → health check）
5. **SPEC 更新** — 每 commit 后 Hermes 看 `SPEC Impact` 段，必要时改 SPEC.md

## 进行中任务
- T3-1 ✅ 完成 (DashboardLayout 326 → 92 行 -71.8%, Sidebar/TopBar 独立组件)
- T3-3 leads 拆分 **8/8 完成** ✅ (5afce2f / ea791b1 / f9d3565 / 8b1c96c / 192bee2 / b84512a / b508f46 / 6fb1860)
- 剩余 CRM 工作: v3.1 Phase 0-3 (Excel Import / Notes Timeline 等业务级,待 GO)

## 已知坑和 workaround

| 坑 | workaround | 教训 commit |
|----|-----------|------|
| CC stash 后报"已完成" | 派工模板加 `git log --oneline -1` 确认 | `414d219` |
| useSupabaseQuery import 误删 | T1-7 检查 + HOTFIX | `8b1c96c` |
| Turbopack `.tmp` ENOENT | `NEXT_NO_TURBOPACK=1` | 全天 |
| CC 主动违规不 commit | Hermes 手动 pathspec `git add` 救场 | T3-1 步骤 2 |
| 40 tsc 错在并行 untracked 工作目录 | 误报"非我引入"——必须自己跑一次验证 | T3-1 步骤 2 |

## 派工模板（v2，加固后）

```
你是 Claude Code 写码主力。任务：{TASK}。

【必跑三关验证 — 缺一不可】
1. npx tsc --noEmit 2>&1 | tail -20  →  0 错
2. rm -rf .next && NEXT_NO_TURBOPACK=1 npx next build 2>&1 | tail -10  →  通过
3. bash scripts/check-taskboard.sh 2>&1 | tail -5  →  18/0/0

【⚠️ 硬铁律 — CC 必须 commit 成功才返回】
- 最后必跑 git log --oneline -1 看到新 commit hash
- 必跑 git status 看到 clean
- **SPEC Impact:** [改了哪些文件/为什么/影响哪些架构决策]
- 失败/配额耗尽/任何意外 → git reset --hard HEAD~1 + 报告 "未完成"
- 禁止把改动 stash 后报告 "已完成"
```

## 跨会话交接

- **新 session / compact 后**: 读本文件 → 读最新 commit → 读 TASKBOARD → 派活
- **本文件不准凭模型记忆更新** — 必须从 git log / 文件读出真状态后改
- **夜场/中场交接**: 写 `crm-v3/HANDOFF-YYYYMMDD-{slot}.md`，commit 上去
