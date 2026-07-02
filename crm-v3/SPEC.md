# SPEC — NewMe CRM

> ⚠️ **COMPACT 后:用户最后 3 条消息 > 本文件 > handoff 摘要**
> (本文件是参考手册,不是圣经。compaction 时用户的尾消息是唯一权威。)

## 项目一句话
NewMe CRM 自托管 (systemd + Next.js 15 + Supabase + Sentry/PostHog) on `app.newme.ae`。

## 当前状态（写时 commit `6dda27d`）
- **Branch**: `main` @ `6dda27d`
- **生产 BUILD_ID**: `WHeSglDPoDcDPPXrrCRW-`（auth fix + SPEC 门禁 已部署）
- **TASKBOARD**: 18 PASS / 0 FAIL / 0 WARN (脚本可见层)
- **真相源**: `cos://newme-1302961787/crm-v3/v3.1/v3.1 P1P1计划0629.txt`（4990 → ~5279 行）
- **本地指针**: `TASKBOARD.md`（薄指针文件，仅保留脚本可识别表 + check-taskboard.sh 依赖）
- **上次更新**: 2026-07-02

---

## 一、COS 真相源 vs 本地对照（2026-07-02 核对）

✅ **P1P1 与 TASKBOARD 一致（10/10 已完成项）**

| 项目 | P1P1 | TASKBOARD | 一致 |
|------|------|-----------|------|
| Phase 1 (25/25) | ✅ 2026-07-01 | ✅ COMPLETE | ✅ |
| Phase 1.5 RLS (36 表) | ✅ 2026-07-01 | (合并在 Phase 1) | ✅ |
| Tier 1 (12/12) | ✅ 2026-07-01 | 12/12 (100%) ✅ | ✅ |
| Tier 2 (3/3) | ✅ 2026-07-01 | 3/4 (80%) ⚠️ | ⚠️ 详见下 |
| Tier 3 / T3-4 | ✅ 2026-07-01 | ✅ | ✅ |
| Tier 4 / T4-1 | ✅ 2026-07-01 | ✅ | ✅ |
| Tier 4 / T4-2 | ✅ 2026-07-01 | ✅ | ✅ |
| P0-1 编码 + migration | ✅ 2026-07-01 | ✅ (编码 + 161ms) | ✅ |
| v3.1 合并 | ✅ 2026-07-01 | (薄指针) | ✅ |

🔴 **矛盾：TASKBOARD 比 P1P1 多两项完成**

| ID | P1P1 | TASKBOARD | 实际状态 |
|----|------|-----------|---------|
| T4-3 deploy.sh Step 3 build guard | ❌ 待开 | ✅ 2026-07-01 commit `5d7b60b` | **TASKBOARD 对**（已重构 deploy.sh + package.json）|
| T4-4 PostHog CSP 白名单 | ❌ 待开 | ✅ 2026-07-01 (nginx 改完) | **TASKBOARD 对**（生产 200 + CSP 头返回）|
| T2-4 锚定功能卡片 | 未列 | ✅ 2026-07-01 (commits 1ac84ca + a606d9b + 0fe9543 + aa54565 + 7c7d74c) | **TASKBOARD 对**（P1P1 漏写，但实际已完成 5 commits）|

→ **结论**：2026-07-01 后又有进展，P1P1 没更新。**TASKBOARD.md 是当前事实上的 ground truth，P1P1 下次同步要补 T4-3/T4-4/T2-4。**

---

## 二、待办状态（P1P1 列出 31 项 + 实际 27 项）

### Tier 3 / Tier 4 / P0-1 验收（4 项）
| ID | 任务 | 状态 |
|----|------|------|
| T3-1 | DashboardLayout 统一（方案 A，全 6+ 页重构） | ❌ |
| T3-2 | 性能监控 + 告警（Lighthouse/Web Vitals） | ❌ |
| T3-3 | 代码债清理（leads 1067 行 / pipeline 已拆完 3/3 + HOTFIX；leads 0/8 待开） | ⚠️ partial |
| T3-5 | profiles.email 列 vs R1 矛盾统一 | ❌ |
| verify-p0-1 | P0-1 验收（用户手机实测 <5s / <50 请求） | ❌ |

### UX 一致性 / 技术债 / Process 修复（4 项）
| ID | 任务 | 状态 |
|----|------|------|
| i18n-dubai | 12 处页面时区统一迪拜时间 fmtDubai() | ❌ |
| t2-1-followup | 其他 11 页接入 DashboardScrollContainer | ❌ |
| chunks-cleanup | 0~14i8bodcp 死引用清理（T3 范畴） | ❌ |
| process-fix | Hermes 不直接写代码的 process violation 修复（hermes-rules.md §十二 待加） | ❌ |

### CI / MoA 细化（2 项）
| ID | 任务 | 状态 |
|----|------|------|
| hermes-ci | Hermes CI webhook 订阅 crm-ci | ❌ |
| moa-tier2-detail | MoA Tier 2 决策点 3+4 方案细化（10-12 人天） | ❌ |

### 业务核心 / MVP（18 项，业务部门需求，非当前重构主线）
- **业务核心（6）**：business-leads-new / leads-detail / pipeline / payments / contracts / tasks
- **业务支撑（3）**：business-dashboard / excel-import / timeline-panel
- **业务 MVP（9）**：command-center / projects / quotes / quotations / workbench / team / analytics / ads / settings

→ 全部 ❌。**这些是销售日常功能需求，不在当前 MoA Tier 重构主线内。** 优先级由 森哥排定。

---

## 三、2026-07-02 新增变更（对比 P1P1 真相源）

| 变更 | 提交 | 影响 |
|------|------|------|
| **auth fix** — ensureSession() + token 去重 | `0638dcd` | 修双登 bug + 删除 lead → 登录页 redirect 问题 |
| **SPEC 门禁** — check-spec.sh + deploy.sh Step 0.5 | `6dda27d` | 强制 SPEC.md 在 3 commit 内更新，否则 deploy 警告 |

---

## 四、架构关键

| 路径 | 职责 | 行数 | 状态 |
|------|------|------|------|
| `src/app/(dashboard)/layout.tsx` | DashboardLayout | 92 | 🟢 T3-1 完成 |
| `src/components/dashboard/DashboardSidebar.tsx` | Sidebar + mobile button + overlay | 169 | 🟢 新建 |
| `src/components/dashboard/DashboardTopBar.tsx` | Top header | 75 | 🟢 拆完 |
| `src/app/(dashboard)/leads/page.tsx` | Leads 列表 | 415 | 🟢 T3-3 step 8+9+10+12 完成 |
| `src/app/(dashboard)/leads/_components/LeadCard.tsx` | Lead 卡片（含单卡 ↔️ reassign） | 510 | 🟢 拆完 |
| `src/app/(dashboard)/leads/_components/LeadsHeader.tsx` | Header + sticky page-title | 108 | 🟢 新建 |
| `src/app/(dashboard)/leads/_components/LeadsFilters.tsx` | Filter row | 198 | 🟢 新建 |
| `src/app/(dashboard)/leads/_components/LeadsBulkTransferBar.tsx` | 批量转移 sticky bar（admin/boss + checkbox） | 122 | 🟢 新建 |
| `src/app/(dashboard)/leads/[id]/page.tsx` | Lead Detail | 540 | 🟢 T3-3 step 11 完成 |
| `src/app/(dashboard)/leads/[id]/useLeadDetailData.ts` | Detail 数据 hook (16 queries → 4 并行) | 318 | 🟢 P0-1 完成 |
| `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts` | Detail 写 hook (12 handlers) | 445 | 🟢 新建 |
| `src/app/(dashboard)/pipeline/page.tsx` | Pipeline Kanban | 146 | 🟢 拆完 3/3 |
| `src/lib/supabase.ts` | Supabase client + ensureSession() + token 去重 | 92 | 🟢 auth fix |
| `src/hooks/useAuthRedirect.ts` | DashboardLayout auth | 157 | 🟢 auth fix |
| `src/hooks/useSupabaseQuery.ts` | 数据 query hook (timeout 8s + retry 2) | — | T1-1 freeze |
| `src/lib/nav.ts` | 全部 nav 配置 | 65 | 🟢 拆完 |
| `src/lib/supabaseQuery.ts` | useSupabaseQuery hook | — | T1-1 freeze |
| `src/shared/hooks/usePipelineDragDrop.ts` | 共享拖拽 hook | — | T1-3 freeze |
| `src/shared/hooks/useStageGuard.ts` | 阶段守卫 hook | — | T1-4 freeze |
| `src/components/DashboardErrorBoundary.tsx` | 全局 ErrorBoundary + Sentry captureException | — | T1-2 + T1-11 freeze |
| `scripts/check-taskboard.sh` | TASKBOARD 验证（deploy Step 0） | 216 | 🟢 |
| `scripts/check-spec.sh` | SPEC 新鲜度验证（deploy Step 0.5） | 65 | 🟢 2026-07-02 新建 |
| `scripts/deploy.sh` | 6 步 deploy pipeline | 153 | 🟢 T4-3 重构 |

---

## 五、设计决策（为什么这么做）

- **不用 Turbopack build** — race condition bug（`.tmp/_buildManifest.js.tmp` ENOENT），统一 `NEXT_NO_TURBOPACK=1 npx next build`。Turbopack chunk naming 不稳定导致 ChunkLoadError（chunks-cleanup 待做）
- **useSupabaseQuery 替代 Promise.all** — 解决 3-4s 串行延迟，并行 + retry（leads/[id] P0-1 验证 161ms）
- **self-hosted systemd 不上 Vercel** — 数据所有权 + 部署可控
- **T3-5 方案 B (R1 豁免)** — `profiles.email` 由 auth.users trigger 同步，R1 规则保留。20+ 处扫全仓风险大已弃
- **CC subagent 必跑三关** — tsc 0 + build OK + check-taskboard 18/0/0 才算完成
- **派工不靠 CC 自己报"已完成"** — 必须 `git log --oneline -1` 看到新 hash 才回报
- **SPEC.md 半自动** — CC 输出 `**SPEC Impact**:` 段，Hermes 决定写不写；2026-07-02 加强制门禁
- **ensureSession() 机制** — 解决双登 bug，每次导航前等待 session 就绪 + token 去重
- **Hermes 禁手令（待立 §十二）** — Hermes 调度员不直接写代码，违反 P1P1 §代码审查流程铁律
- **MoA 三档分级** — 🟢免审 / 🟡单审 + OEEC 紧急例外 / 🔴双审（hermes-rules.md §十）
- **TASKBOARD + P1P1 双源** — 本地 TASKBOARD.md 是脚本可识别层（deploy gate 依赖），COS P1P1 是文档真相源（人工查阅）

---

## 六、当前工作流

1. **任务派工** — Hermes 读探查报告 → 派给 CC (GLM-CP) → CC 写代码 → commit
2. **三关验证** — tsc 0 → build OK → check-taskboard 18/0/0（pre-push hook 自动跑）
3. **SPEC 检查** — `scripts/check-spec.sh` 检查 SPEC.md 是否在 3 commit 内更新，超过 5 个硬上限则阻止 deploy
4. **push** — Hermes 手动 `git push origin main`
5. **deploy** — `npm run deploy` → `scripts/deploy.sh` 6 步（taskboard → SPEC → tsc → backup → build → verify → restart → health check）
6. **SPEC 更新** — 每 commit 后 Hermes 审核 CC 的 `SPEC Impact` 段，必要时改 SPEC.md

---

## 七、进行中任务（基于实际 commit）

- T3-1 ✅ 完成 (DashboardLayout 326 → 92 行 -71.8%, Sidebar/TopBar 独立组件, commits: `9719d06`)
- T3-3 leads 拆分 **8/8 完成** ✅ (pipeline: `5afce2f` / `ea791b1` / `f9d3565` / `8b1c96c`；leads: `192bee2` / `b84512a` / `b508f46` / `6fb1860`)
- P0-1 ✅ 完成（`d5bcac2` 编码 + migration `20260701130000`）
- T4-3 ✅ 完成（`5d7b60b` deploy.sh 重构）
- T4-4 ✅ 完成（nginx CSP 白名单已加）
- T2-4 ✅ 完成（5 commits：1ac84ca + a606d9b + 0fe9543 + aa54565 + 7c7d74c）
- auth fix ✅ 完成（`0638dcd`）
- SPEC 门禁 ✅ 完成（`6dda27d`）

**剩余主线工作（MoA 范围）**：
- T3-1 重构全 6+ 页（架构债最大）
- T3-2 性能监控（防 P0 类问题再次悄悄出现）
- T3-3 leads 0/8 子组件（详情页 540 行仍较大）
- T3-5 profiles.email 列 vs R1 统一
- verify-p0-1 用户手机实测

---

## 八、已知坑和 workaround

| 坑 | workaround | 教训 commit |
|----|-----------|------|
| CC stash 后报"已完成" | 派工模板加 `git log --oneline -1` 确认 | `414d219` |
| useSupabaseQuery import 误删 | T1-7 检查 + HOTFIX | `8b1c96c` |
| Turbopack `.tmp` ENOENT | `NEXT_NO_TURBOPACK=1` | 全天 |
| CC 主动违规不 commit | Hermes 手动 pathspec `git add` 救场 | T3-1 步骤 2 |
| 40 tsc 错在并行 untracked 工作目录 | 误报"非我引入"——必须自己跑一次验证 | T3-1 步骤 2 |
| **双登 bug（setSession fire-and-forget）** | ensureSession() + token 去重 | `0638dcd` |
| **删除 lead → 跳登录页（token 过期）** | ensureSession() 在 getUser() 前 await | `0638dcd` |
| **Turbopack chunk naming 不稳定** | 全用 webpack build，chunks-cleanup 待做 | 2026-07-01 ChunkLoadError |
| **P1P1 vs TASKBOARD 状态不同步** | TASKBOARD 是 ground truth，P1P1 下次同步要补 T4-3/T4-4/T2-4 | 2026-07-02 发现 |
| **MEMORY 路径 vs 真实 COS key 不一致** | 用户给路径先用 `coscmd list` 实测，不靠 memory | 2026-07-02 v3.1 P1P1 事故 |
| **deploy 重启后冷启动 502** | systemd ExecStartPost 改 10×2s 重试 + 4 路由全部健康（login/root/dashboard/leads 都不能 000）；旧版只看 login 撞冷启动就 break | 2026-07-02 systemd unit (`infra/systemd/newme-platform.service`) |

---

## 九、派工模板（v2，加固后）

```
你是 Claude Code 写码主力。任务：{TASK}。

【必跑三关验证 — 缺一不可】
1. npx tsc --noEmit 2>&1 | tail -20  →  0 错
2. rm -rf .next && NEXT_NO_TURBOPACK=1 npx next build 2>&1 | tail -10  →  通过
3. bash scripts/check-taskboard.sh 2>&1 | tail -5  →  18/0/0

【⚠️ 硬铁律 — CC 必须 commit 成功才返回】
- 最后必跑 git log --oneline -1 看到新 commit hash
- 必跑 git status 看到 clean
- **必须输出 SPEC Impact 段**（改了哪些文件/为什么/影响哪些架构决策）— 不输出本 commit 按"未完成"处理
- 失败/配额耗尽/任何意外 → git reset --hard HEAD~1 + 报告 "未完成"
- 禁止把改动 stash 后报告 "已完成"
```

---

## 十、跨会话交接

- **新 session / compact 后**: 读本文件 → 读最新 commit → 读 TASKBOARD → 读 COS P1P1（必须实测路径，不信 memory）
- **本文件不准凭模型记忆更新** — 必须从 git log / 文件读出真状态后改
- **夜场/中场交接**: 写 `crm-v3/HANDOFF-YYYYMMDD-{slot}.md`，commit 上去
- **P1P1 同步检查**: 每次新 session 跑 `coscmd list crm-v3/v3.1/` 确认本地指针与 COS 一致
- **Faheem 已离职**（2026-07-02）— CRM 仍保留其账号，未做权限清理