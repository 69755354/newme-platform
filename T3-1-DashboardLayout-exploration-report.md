# T3-1 DashboardLayout 拆分布局方案（探查报告）

> 日期: 2026-07-01
> 探查者: Claude Code (CC 子代理)
> 目的: 让 Hermes 决定是否采纳 4 步拆分方案
> 铁律: 仅探查, 不动 src/ 代码, 不 commit/push
> 源文件: src/app/(dashboard)/layout.tsx (366 行)
> 立项: crm-v3/v3.1/v3.1 P1P1计划0629.txt 行 5029 + 5132 + 5180-5183

---

## 1. 当前 layout.tsx 366 行职责热力图

### 1.1 行号 → 职责 → 类型 → 拆分去向 映射表

| 行号 | 职责摘要 | 类型 | 必须保留? | 拆分去向 |
|---|---|---|---|---|
| **1** | `"use client"` | 标记 | ✅ | layout 顶 |
| **2** | 空行 | — | — | — |
| **3-12** | imports: Link, usePathname, useRouter, cn, lucide-react(18 个图标), Toaster, useState/useEffect/Suspense | 配置 | 部分 | 图标全部分散到子组件; `usePathname/useRouter` 留 hook 用 |
| **13-20** | imports: LanguageProvider/Toggle, useLanguage, supabase, NotificationBell, DashboardErrorBoundary | 配置 | 部分 | ✅ **保留: ErrorBoundary/Suspense**; 其他归子组件 |
| **22-27** | `interface NavItem { href, labelKey, icon }` | 类型 | 拆 | 🟢 `src/lib/nav.ts` |
| **29-43** | `MGMT_NAV` 12 项 (含 command-center, ads, projects, team) | 配置 | 拆 | 🟢 `src/lib/nav.ts` |
| **45-55** | `SALES_NAV` 8 项 (含 workbench, payments) | 配置 | 拆 | 🟢 `src/lib/nav.ts` |
| **57-58** | section comment | — | — | — |
| **59-67** | 组件开头 + 9 个 useState/useRef/useContext | state | 部分 | 🟡 `useAuthRedirect` 接管 role/userEmail/authLoading/authError; sidebarOpen 归 Sidebar |
| **70-147** | **useEffect #1 (78 行)**: dev auto-login + production getUser + profile.role fetch + force_password_change 5s timeout | 副作用 | **保留在 hook** | 🟡 `src/hooks/useAuthRedirect.ts` |
| **149-156** | **useEffect #2 (8 行)**: sales user 从 `/dashboard` 跳 `/workbench` | 副作用 | 🟡 | `useAuthRedirect` 的 onRoleResolved 回调, 或单独 helper |
| **158-159** | `isManagement` + `nav = isManagement ? MGMT_NAV : SALES_NAV` | 派生 state | 拆 | Sidebar 接 isManagement prop |
| **161-167** | `isItemActive(href)` 高亮判定 (含 /dashboard 与 /workbench 精确匹配 + /pipeline startsWith 二级) | handler | 拆 | Sidebar 接 `currentPath`, 内部判定 |
| **169-181** | `handleLogout` (13 行): signOut + localStorage + 4 cookie clear + push | handler | 🟡 | `useAuthRedirect` 返回 |
| **183-185** | `roleLabel = t('nav.roleManagement')` 等 派生 | 派生 | 拆 | Sidebar/TopBar 接 t |
| **187-357** | 返回 JSX | JSX | 部分拆 | — |
| **188** | `<>` Fragment | JSX | 保留 | layout |
| **189** | `<div className="min-h-screen ... flex">` 外壳 | JSX | ✅ **保留** | layout (main 滚动容器之父级, 不许动) |
| **191-196** | Mobile menu button (fixed top-3 left-3) | JSX | 🟡 拆 | Sidebar 内部 |
| **198-200** | Mobile overlay backdrop | JSX | 🟡 拆 | Sidebar 内部 |
| **202-293** | **`<aside>` Sidebar** (90 行): logo + role badge + LanguageToggle + Nav list + footer user/logout/version | JSX | 🟡 拆 | `src/components/dashboard/DashboardSidebar.tsx` |
| **210-234** | Sidebar 头: logo "N" + 名称 + LanguageToggle + role badge | JSX | 🟡 拆 | Sidebar 内 |
| **236** | divider | JSX | 🟡 拆 | Sidebar 内 |
| **239-267** | Nav `.map()` 列表 (含 role-loading fallback) | JSX | 🟡 拆 | Sidebar 内 |
| **269-292** | Sidebar footer: user email 头像 + version + logout | JSX | 🟡 拆 | Sidebar 内 |
| **295** | `</aside>` | — | — | — |
| **296** | `<main>` 入口 | JSX | ✅ **保留** | layout |
| **298-321** | **Top header bar** (24 行): authError retry + NotificationBell + user avatar + roleLabel + logout button | JSX | 🟡 拆 | `src/components/dashboard/DashboardTopBar.tsx` |
| **322-332** | T2-1 scroll boundary 注释 (10 行) | 文档 | ✅ **保留** | layout 滚动 div 上方 (规约注释) |
| **333** | **`<div className="flex-1 ... overflow-hidden" data-dashboard-scroll-boundary="">`** | JSX | ✅ **保留** | layout (T2-1 滚动边界, 拆了 11 个子页面全断, 不可动) |
| **334-351** | authLoading/authError/Suspense/ErrorBoundary 分支 | JSX | ✅ **保留** | layout 滚动容器内 |
| **344-350** | **`<Suspense fallback>...<DashboardErrorBoundary>{children}</DashboardErrorBoundary>...</Suspense>`** | JSX | ✅ **保留** | T1-5 验收铁律, 不能动 |
| **352-353** | closing `</div></main>` | JSX | ✅ 保留 | — |
| **354-355** | `</div>` + `<Toaster />` | JSX | ✅ 保留 Toaster | layout |
| **356** | `</>` | — | — | — |
| **357** | `}` | — | — | — |
| **360-366** | 导出: `<LanguageProvider><DashboardLayoutInner>{children}</DashboardLayoutInner></LanguageProvider>` | 包装 | ✅ **保留** | layout 顶 (LanguageProvider 不能拆) |

### 1.2 必须保留在 layout.tsx (不能拆出去的部分)

- ✅ `"use client"` 标记 + `LanguageProvider` 包装 (顶层, 子组件共享)
- ✅ 外层 `<div className="min-h-screen ... flex">` (flex 容器)
- ✅ `<main>` flex-1 入口
- ✅ `<div ... overflow-hidden data-dashboard-scroll-boundary="">` (T2-1 滚动边界铁律, 11 个子页面的 `DashboardScrollContainer`/`useDashboardScroll` 全靠它)
- ✅ `<Suspense fallback><DashboardErrorBoundary>{children}</DashboardErrorBoundary></Suspense>` (T1-5 验收铁律)
- ✅ `<Toaster position="top-center" richColors />` (全局 toast)
- ✅ T2-1 滚动边界规约注释 (10 行)

> **拆完后 layout.tsx 预计缩减: 366 → ~80 行** (主框架 + 滚动边界 + ErrorBoundary + Toaster + Provider 包装)

### 1.3 可以拆出去的部分

| 拆分目标 | 来源行号 | 大小 | 风险 |
|---|---|---|---|
| 🟢 `src/lib/nav.ts` | 22-27, 29-55 | 27 行 | 🟢 0 风险 (纯配置) |
| 🟡 `src/hooks/useAuthRedirect.ts` | 59-67 部分, 70-156 全部, 169-181 | ~95 行 | 🟡 中风险 (改 80 行 useEffect) |
| 🟡 `src/components/dashboard/DashboardTopBar.tsx` | 298-321 | 24 行 JSX | 🟡 中风险 (JSX 拆) |
| 🟡 `src/components/dashboard/DashboardSidebar.tsx` (可选) | 191-293 (含 191-200 mobile 控制) | ~103 行 | 🟡 中风险 (JSX + mobile state 拆) |

---

## 2. 推荐拆分方案 (4 步)

### 步骤 1: 拆 nav 配置 → `src/lib/nav.ts` (🟢 0 风险, 30 min)

**做什么**:
- 抽出 `interface NavItem` + `MGMT_NAV` (12 项) + `SALES_NAV` (8 项) 到 `src/lib/nav.ts`
- 必要的 18 个 lucide-react 图标导入随配置迁过去 (MGMT 用 14 个, SALES 用 7 个, 唯一不重叠的图标各自保留)
- layout.tsx 仅留 `import { MGMT_NAV, SALES_NAV } from "@/lib/nav"`

**预计 commit 数**: 1 (纯移动 + import 路径改写)

**风险评估**: 🟢 **0 风险**:
- `NavItem` interface 是纯类型, 无运行影响
- `MGMT_NAV` / `SALES_NAV` 仅在 layout.tsx 行 159 引用, 改 import 即可
- 没有 page.tsx 共享引用 (grep 全文 `MGMT_NAV|SALES_NAV` 仅 layout.tsx 三处: 30, 46, 159)
- 不影响 data-dashboard-scroll-boundary
- 不影响 ErrorBoundary 嵌套

**验收**: tsc OK + grep `MGMT_NAV` 应只剩 src/lib/nav.ts 声明与 src/app/(dashboard)/layout.tsx 引用

### 步骤 2: 拆 auth 逻辑 → `src/hooks/useAuthRedirect.ts` (🟡 中风险, 1h)

**做什么**:
- 新建 `src/hooks/useAuthRedirect.ts`, 暴露签名:
  ```ts
  function useAuthRedirect(): {
    role: string | null;
    userEmail: string | null;
    authLoading: boolean;
    authError: boolean;
    logout: () => Promise<void>;
    isManagement: boolean;
  }
  ```
- 内部封装:
  - useState 4 个: role / userEmail / authLoading / authError
  - useEffect #1 (行 70-147, 78 行): dev auto-login + production getUser + profile.role + force_password_change + 5s timeout
  - useEffect #2 (行 149-156, 8 行): sales user 从 /dashboard 跳 /workbench (内部 router 跳转)
  - handleLogout (行 169-181, 13 行): signOut + localStorage + 4 cookie + push
  - 派生: `isManagement = role === "admin" || role === "boss" || role === "operator"`
- layout.tsx 调用: `const { role, userEmail, authLoading, authError, logout, isManagement } = useAuthRedirect()`

**预计 commit 数**: 1 (新建 hook + layout.tsx 改调用 + 删除原行)

**风险评估**: 🟡 **中风险**:
- **state/handler 共享**: 验证 layout.tsx 与 page.tsx 间无共享 state — ✅ **layout 是唯一来源**, 拆 hook 后所有 state 集中于 hook, page.tsx 仍不接触
- **滚动边界**: 无影响, 滚动 div 仍在 layout.tsx
- **ErrorBoundary 嵌套**: 无影响, `<DashboardErrorBoundary>` 仍在 layout.tsx 滚动 div 内
- **潜在副作用**: hook 内 router.push 4 处 (5s timeout / force_password_change / sales 重定向 / logout), 需保证:
  1. cancelled flag 仍生效 (cleanup 时不触发跳转)
  2. deps 数组不变 (空 deps, 避免无限循环)
  3. supabase client 在 hook 内 `createClient()` 而非闭包旧引用

**验收**: tsc OK + 所有 dashboard 页 (login → /dashboard) 手工验证 4 场景:
1. 未登录 5s → /login
2. 已登录 sales → /dashboard 自动跳 /workbench
3. force_password_change → /change-password
4. dev mode (NEXT_PUBLIC_DEV_MODE=true) → admin 自动登录

### 步骤 3: 拆 TopBar → `src/components/dashboard/DashboardTopBar.tsx` (🟡 中风险, 1h)

**做什么**:
- 新建 `src/components/dashboard/DashboardTopBar.tsx`, props:
  ```ts
  {
    roleLabel: string;
    userEmail: string | null;
    authError: boolean;
    onLogout: () => void;
    onRetry: () => void; // window.location.reload
  }
  ```
- 内部 `("use client")` + JSX 完全复制行 298-321 (24 行)
- 内部 `useLanguage()` 拿不到 (从 prop 收 roleLabel)
- layout.tsx 替换为 `<DashboardTopBar roleLabel={t(...)} userEmail={userEmail} authError={authError} onLogout={logout} onRetry={() => window.location.reload()} />`

**预计 commit 数**: 1 (新建文件 + layout.tsx 改 24 行)

**风险评估**: 🟡 **中风险**:
- 滚动边界: 无影响
- ErrorBoundary 嵌套: TopBar 在 `<main>` 内但在滚动 div **外**, ✅ ErrorBoundary 不包 TopBar 也无问题 (T1-5 仅要求包 `children`, 不包 header)
- 复用性: 11 个 dashboard 子页面都不引用 TopBar (它是 layout 独享), 无重入风险
- 唯一耦合点: `authError && retry` 文案 ("Connection error — tap to retry") 由 layout 翻译 → 可直接在 TopBar 内用 `useLanguage` (✅ 内部 hook 调用)

**验收**: tsc OK + 手工验证顶部 bar 完整呈现 NotificationBell + 头像 + roleLabel + logout 按钮

### 步骤 4: 拆 Sidebar → `src/components/dashboard/DashboardSidebar.tsx` (🟡 中风险, 可选, 1h)

**做什么**:
- 新建 `src/components/dashboard/DashboardSidebar.tsx`, props:
  ```ts
  {
    isManagement: boolean;
    isActive: (href: string) => boolean;
    userEmail: string | null;
    roleLoading: boolean;
    roleLabel: string;
    onLogout: () => void;
    closeOnNav: () => void;
  }
  ```
- 内部封装:
  - `useState(sidebarOpen)` 移动端控制
  - `MGMT_NAV` / `SALES_NAV` 从 `@/lib/nav` 取
  - `isItemActive` 函数从 layout 迁入, 接 prop `isActive` (或自实现)
  - 行 191-293 完整 JSX (含 mobile 按钮 / overlay / aside)
- layout.tsx 替换为 `<DashboardSidebar ... />`

**预计 commit 数**: 1 (新建文件 + layout.tsx 改 ~103 行)

**风险评估**: 🟡 **中风险**:
- **最大的 JSX 拆** — 占原文件 ~28% 体量
- mobile sidebarOpen state 跨页: 仅 layout 用, ✅
- LanguageToggle 在 Sidebar 头部 (行 222), 迁过去需注意 LanguageToggle 是 `'use client'` (✅ 已确认)
- 滚动边界: 无影响
- 嵌套: Sidebar 在 `<main>` **外**, 不被 ErrorBoundary 包 (✅ 安全)

**验收**: tsc OK + 手工验证:
1. PC (≥lg): sidebar 静态显示
2. Mobile (<lg): 点 hamburger → overlay + slide-in, 点链接 → 关 sidebar
3. isActive 高亮在 /dashboard /workbench /pipeline 等路径正确

---

## 3. 跨 step 风险统一评估

### 3.1 state/handler 在 page.tsx 之间共享?

| 状态/handler | 来源 | page.tsx 是否用到? |
|---|---|---|
| `role` / `userEmail` / `authLoading` / `authError` | layout useEffect | ❌ (所有 page.tsx 通过 `useRequireRole`/`useUserRole` 自己再 fetch, **重复但非耦合**) |
| `sidebarOpen` | layout useState | ❌ |
| `isManagement` | layout 派生 | ❌ |
| `nav` | layout 派生 (MGMT_NAV/SALES_NAV) | ❌ |
| `handleLogout` | layout handler | ❌ |
| `isItemActive` | layout handler | ❌ |

**结论**: ✅ **layout 是唯一的 UI 真实源**, page.tsx 不读 layout 状态, 拆分无任何跨页耦合。

> 已知 issue: `useUserRole` / `useRequireRole` 各自再 fetch role — 这是 T3-3 / Tier 1 阶段遗留, **不属于 T3-1 范畴**, 后续 TaskBoard T3-3 大文件拆分可考虑统一到 `useAuthRedirect`。

### 3.2 滚动边界 (`data-dashboard-scroll-boundary`) 引用会断吗?

| 引用方式 | 引用方 | 拆后是否断? |
|---|---|---|
| 直接读 `data-dashboard-scroll-boundary` 属性 | `DashboardScrollContainer` (11 页用了 `data-dashboard-scroll`) | ❌ 无影响 (滚动 div 保留在 layout) |
| `<DashboardScrollContainer>` 子代 | leads/pipeline/payments/quotations/tasks 等 11 页 | ❌ 无影响 |
| `useDashboardScroll` hook | 同上 | ❌ 无影响 |

**结论**: ✅ **滚动 div (行 333) 必须留在 layout.tsx**, 拆分方案保留此 div 不动。

### 3.3 ErrorBoundary 嵌套会破坏吗?

- T1-5 验收条件: `grep "ErrorBoundary" src/app/(dashboard)/layout.tsx` 必须通过
- 拆完后: ✅ `<DashboardErrorBoundary>{children}</DashboardErrorBoundary>` 仍在行 ~80 的 layout.tsx
- TopBar/Sidebar 在 `<main>` 外, **不被 ErrorBoundary 包** — 这是 Next.js layout 标准做法 (header 错误不应该 crash 整个布局)
- 唯一注意: **不要在 TopBar 内 try/catch 静默吞错** — 让错误往上冒到 ErrorBoundary

**结论**: ✅ **T1-5 不破坏**, `check-taskboard.sh` 仍然 PASS。

### 3.4 已知隐藏风险点 (探查到)

| 风险 | 行号 | 缓解措施 |
|---|---|---|
| hook 内 `useEffect` deps `[]` 是 78 行单一 big effect, 拆到 3 个 useEffect (dev auto-login / getUser / sales 重定向 / logout) 时 deps 需细审 | 70-147 | 拆时保留原状, 先大块整体迁, 后再分小 function |
| `process.env.NEXT_PUBLIC_DEV_MODE === "true"` 判断在 effect 内, 拆到 hook 时需保证 SSR 不跑 (✅ "use client" 已确保) | 74 | 不变 |
| supabase client `createClient()` 在组件顶 (行 62), 拆到 hook 时需每次渲染重建 — `createClient()` 内已有 `_client` 单例 (lib/supabase.ts 行 6), ✅ 安全 | 62 | 不变 |
| `useLanguage()` 在 layout 行 64 调用, 拆 hook 后 hook 也需调 — 但 hook 不需语言, ✅ 保持 layout 调 | 64 | 不变 |
| `<LanguageToggle />` 在 Sidebar 头部 (行 222) — Sidebar 拆后 `<LanguageToggle />` 也随迁; **LanguageToggle 必须在 LanguageProvider 子代**, ✅ Sidebar 总在 Provider 下 | 222 | 不变 |
| `roleLabel` 派生自 `useLanguage().t('nav.roleManagement')` — 拆 TopBar/Sidebar 后, 二者都需要, 可作 prop 传入 (✅ 步骤 3/4 已规划) | 183-185 | 不变 |

---

## 4. 拆分顺序建议 (最低 → 最高风险)

| 顺序 | 步骤 | 文件 | 估计耗时 | 风险 | 必须 commit 数 |
|---|---|---|---|---|---|
| 1 | 拆 nav 配置 | `src/lib/nav.ts` 新建 | 30 min | 🟢 0 | 1 |
| 2 | 拆 auth 逻辑 | `src/hooks/useAuthRedirect.ts` 新建 | 1 h | 🟡 中 | 1 |
| 3 | 拆 TopBar | `src/components/dashboard/DashboardTopBar.tsx` 新建 | 1 h | 🟡 中 | 1 |
| 4 | 拆 Sidebar (可选) | `src/components/dashboard/DashboardSidebar.tsx` 新建 | 1 h | 🟡 中 | 1 |

**总工期**: **3.5 h** (4 commits, 0 重构风险叠加 — 因每步独立文件)

**总缩减**: layout.tsx **366 行 → ~80 行** (-78%)

---

## 5. 验证清单 (每步必跑)

### 必跑 (每 commit)
1. `npx tsc --noEmit` — 0 errors
2. `npx next build` — OK
3. `bash scripts/check-taskboard.sh` — 仍 12/12 PASS + 3 WARN (✅ T1-5 ErrorBoundary check 不破)

### 必跑 (全部 4 步完成)
4. `grep "ErrorBoundary" src/app/(dashboard)/layout.tsx` — 命中 (T1-5 不破)
5. `grep "data-dashboard-scroll-boundary" src/app/(dashboard)/layout.tsx` — 命中 (T2-1 不破)
6. `grep "Toaster" src/app/(dashboard)/layout.tsx` — 命中 (全局 toast 不破)
7. 手工 smoke (按 6+ 页):
   - `/dashboard` (admin) → 侧栏 12 项 MGMT_NAV 显示 + TopBar notification bell 点开 OK + 登出 → /login
   - `/workbench` (sales) → 侧栏 8 项 SALES_NAV 显示 + role badge 显示 "Sales"
   - 移动端 (<lg): hamburger → slide-in sidebar → 点链接 → 自动关
   - dev mode (NEXT_PUBLIC_DEV_MODE=true) → 自动登录
   - force_password_change → 跳 /change-password
8. 文件行数: `wc -l src/app/(dashboard)/layout.tsx` 应 ≤ 90

### 验收命令 (一站式)
```bash
cd /home/ubuntu/newme-platform && \
  echo "=== layout.tsx 行数 ===" && wc -l src/app/'(dashboard)'/layout.tsx && \
  echo "=== T1-5 ErrorBoundary ===" && grep -c ErrorBoundary src/app/'(dashboard)'/layout.tsx && \
  echo "=== T2-1 滚动边界 ===" && grep -c data-dashboard-scroll-boundary src/app/'(dashboard)'/layout.tsx && \
  echo "=== tsc ===" && npx tsc --noEmit && \
  echo "=== check-taskboard ===" && bash scripts/check-taskboard.sh
```

---

## 6. 不推荐的方案 (探查中考虑但否决)

| 方案 | 否决理由 |
|---|---|
| 一步到位把 layout 拆 4 文件 (单 commit) | 不可回滚; 出错不知是哪个拆分引起 |
| 保留 nav 在 layout 但用 memo 优化 | 不是问题根因; 366 行仍是信号债 |
| Sidebar + TopBar 合并为一个 `DashboardShell` | 拆的方向违反 Single Responsibility, 且 mobile 控制 state 双向耦合 |
| 拆 auth 时把 supabase client 也提到 context | 增加架构复杂度, 不解决 366 行核心问题 |
| 用 Server Component 拆 auth effect | 不行, layout 是 `"use client"`, 且 `createClient` 是 browser client |

---

## 7. 给 Hermes 的拍板选项

| 选项 | 推荐 | 说明 |
|---|---|---|
| A. 采纳 4 步拆分方案 (本报告) | ⭐ **推荐** | 工时 3.5h, 4 commits, 风险 🟢 0 → 🟡 中递增 |
| B. 只做步骤 1+2 (nav + auth) | 备选 | 工时 1.5h, 2 commits, 拆完 layout ~200 行 (仍偏大但不阻塞) |
| C. 不拆, 接受 366 行 layout | 不推荐 | 违反 AGENTS.md "文件 > 500 行要拆" 信号 |
| D. 重写整个 layout (大重构) | 强烈不推荐 | 当前 90% 已统一, 大重构 = 回归风险 + 重写测试 |

**建议**: 选 A — 这是已知成本最低、收益最大的"加 1 拆 1"路径, 与 T3-3 拆分 pipeline 的探查 deleg_a99a12cf 报告同思路, 也符合 hermes-rules.md R9 强制约束 (Codex 1 审可批)。

---

## 8. 探查结论摘要 (给 Hermes 一句话拍板)

**T3-1 探查 = "4 步可拆, 3.5h 总工, 4 commits, 拆完 366 → ~80 行; 数据/滚动/ErrorBoundary 三条铁律都不破; 检查脚本与 T1-5/T2-1 验收标准自动继承。"** 

风险矩阵: 步骤 1 (拆 nav) 🟢 0 风险 → 步骤 2/3/4 (拆 hook + 拆两个组件) 🟡 中风险但 local 化。推荐采纳。
