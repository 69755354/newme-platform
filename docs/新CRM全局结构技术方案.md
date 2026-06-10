# NewMe CRM 全局网站结构 — 技术架构方案

> **文档状态**: 初稿 v1.0  
> **编写人**: 架构总监  
> **更新日期**: 2026-06-03  
> **目标版本**: CRM v2.1（整体架构重组）

---

## 目录

1. [路由重组方案](#1-路由重组方案)
2. [导航组件设计](#2-导航组件设计)
3. [数据聚合架构](#3-数据聚合架构)
4. [权限路由守卫方案](#4-权限路由守卫方案)
5. [共享组件设计](#5-共享组件设计)
6. [迁移计划](#6-迁移计划)

---

## 1. 路由重组方案

### 1.1 设计原则

| 原则 | 说明 |
|------|------|
| **业务域优先** | 路由按业务域 (Domain) 组织，而非按功能类型 |
| **URL 即层级** | URL 路径直接反映业务域 → 子模块 → 操作 三层结构 |
| **渐进迁移** | 旧路由通过 next.config.js redirects 保持兼容 |
| **App Router 原生** | 充分利用 layouts, loading.tsx, error.tsx 等文件约定 |
| **扁平化嵌套** | 最多三层嵌套，避免过深的目录结构 |

### 1.2 新目录结构

```
src/app/
├── (auth)/                          # 非认证路由组
│   └── login/
│       └── page.tsx                 # 登录页（不变）
│
├── (dashboard)/                     # 认证路由组（旧路由组——保留过渡期）
│   ├── layout.tsx                   # ← 重写：成为新架构的入口
│   │
│   ├── dashboard/                   # 遗留：保留根 redirect
│   │   └── page.tsx                 # → 302 → /overview
│   │
│   ├── overview/                    # ★ 核心指标 (驾驶舱)
│   │   ├── page.tsx                 # 主驾驶舱
│   │   ├── loading.tsx
│   │   ├── error.tsx
│   │   └── components/
│   │       ├── OverviewKPIs.tsx
│   │       ├── SalesSnapshot.tsx    # 销售速览卡片
│   │       ├── RevenueChart.tsx     # 回款趋势图
│   │       ├── AdROICard.tsx        # 投流ROI摘要
│   │       └── AlertsPanel.tsx      # 预警面板
│   │
│   ├── sales/                       # ★ 销售管理 (业务域)
│   │   ├── layout.tsx              # 销售域布局（侧栏子菜单+面包屑）
│   │   ├── page.tsx                # 销售管理首页 → /sales/leads
│   │   │
│   │   ├── leads/
│   │   │   ├── page.tsx            # Leads 看板（从旧 /leads 迁移）
│   │   │   ├── new/page.tsx        # 新建 Lead
│   │   │   └── [id]/page.tsx       # Lead 详情
│   │   │
│   │   ├── pipeline/
│   │   │   └── page.tsx            # Pipeline 视图（从旧 /pipeline 迁移）
│   │   │
│   │   ├── contracts/
│   │   │   ├── page.tsx            # 合同列表（新增）
│   │   │   ├── new/page.tsx        # 新建合同
│   │   │   └── [id]/page.tsx       # 合同详情
│   │   │
│   │   ├── payments/
│   │   │   ├── page.tsx            # 回款总览（新增）
│   │   │   └── [id]/page.tsx       # 回款详情/登记
│   │   │
│   │   └── team/
│   │       ├── page.tsx            # 团队首页
│   │       ├── members/page.tsx    # 成员管理
│   │       ├── performance/page.tsx # 业绩看板
│   │       └── targets/page.tsx    # 目标管理
│   │
│   ├── marketing/                   # ★ 市场投流 (业务域)
│   │   ├── layout.tsx              # 市场投流域布局
│   │   ├── page.tsx                # → /marketing/ads
│   │   │
│   │   ├── ads/
│   │   │   └── page.tsx            # 归因分析（从旧 /ads 迁移）
│   │   │
│   │   ├── campaigns/
│   │   │   ├── page.tsx            # 活动管理（新增）
│   │   │   └── [id]/page.tsx       # 活动详情+ROI
│   │   │
│   │   └── roi/
│   │       └── page.tsx            # ROI 报表（新增）
│   │
│   ├── analytics/                   # ★ 分析 (业务域)
│   │   ├── layout.tsx
│   │   ├── page.tsx                # 分析首页
│   │   ├── trends/
│   │   │   └── page.tsx            # 趋势分析
│   │   ├── reports/
│   │   │   └── page.tsx            # 报表中心
│   │   └── exports/
│   │       └── page.tsx            # 数据导出
│   │
│   └── messages/
│       └── page.tsx                # 消息中心（单独功能）
│
├── api/                             # API 路由 (不变)
│   └── ...
│
└── layout.tsx                       # 根布局 (不变)
```

### 1.3 旧→新路由映射表

| 旧路由 | 新路由 | 重定向类型 | 原因 |
|--------|--------|-----------|------|
| `/dashboard` | `/overview` | 301 (Permanent) | 驾驶舱更名 |
| `/leads` | `/sales/leads` | 301 | 归入销售域 |
| `/leads/[id]` | `/sales/leads/[id]` | 301 | 同上 |
| `/leads/new` | `/sales/leads/new` | 301 | 同上 |
| `/pipeline` | `/sales/pipeline` | 301 | 归入销售域 |
| `/ads` | `/marketing/ads` | 301 | 归入市场域 |
| `/projects` | `/sales/contracts` | 301 | 项目→合同 |
| `/quotes` | `/sales/leads` (带stage参数) | 302 | 报价归入Leads |
| `/messages` | (不变) `/messages` | — | 保持独立 |
| `/team/*` | `/sales/team/*` | 301 | 归入销售域 |
| `/contracts/*` | `/sales/contracts/*` | 301 | 归入销售域 |

### 1.4 next.config.js 重定向配置

```ts
// next.config.ts
const nextConfig = {
  async redirects() {
    return [
      // 业务域重组 - 301 永久重定向（SEO + 书签）
      { source: '/dashboard', destination: '/overview', permanent: true },
      { source: '/leads', destination: '/sales/leads', permanent: true },
      { source: '/leads/:path*', destination: '/sales/leads/:path*', permanent: true },
      { source: '/pipeline', destination: '/sales/pipeline', permanent: true },
      { source: '/ads', destination: '/marketing/ads', permanent: true },
      { source: '/projects', destination: '/sales/contracts', permanent: true },
      { source: '/projects/:path*', destination: '/sales/contracts/:path*', permanent: true },
      { source: '/quotes', destination: '/sales/leads?stage=quotation_submitted', permanent: false },
      { source: '/team/:path*', destination: '/sales/team/:path*', permanent: true },
      { source: '/contracts/:path*', destination: '/sales/contracts/:path*', permanent: true },
      // 根路径重定向
      { source: '/', destination: '/overview', permanent: false },
    ];
  },
};
```

---

## 2. 导航组件设计

### 2.1 三层导航体系

```
┌─────────────────────────────────────────────────────────────────┐
│  Top Bar (全局筛选 + 面包屑 + 用户菜单)                            │
│  ┌─ 面包屑 ───────────┐  ┌─ 时间范围 ───┐ ┌─ 销售筛选 ─┐ ┌─ 👤 │
│  │ 销售管理 > Pipeline│  │ 📅 本月 ↓   │ │ 👥 全成员 ↓│ │ 头像│
│  └────────────────────┘  └─────────────┘ └───────────┘ └─────┘
├─────────────────────────────────────────────────────────────────┤
│ ┌─ Sidebar ─────────────┐ │  Main Content Area                  │
│ │                        │ │                                     │
│ │  ▸ N NewMe             │ │  [页面内容...]                      │
│ │    CRM Platform        │ │                                     │
│ │  ─────────────────     │ │                                     │
│ │                        │ │                                     │
│ │  ◎ 核心指标            │ │                                     │
│ │     └─ 驾驶舱          │ │                                     │
│ │                        │ │                                     │
│ │  ► 销售管理  ←active   │ │                                     │
│ │     ├─ Leads           │ │                                     │
│ │     ├─ Pipeline        │ │                                     │
│ │     ├─ 合同            │ │                                     │
│ │     ├─ 回款            │ │                                     │
│ │     └─ 团队            │ │                                     │
│ │                        │ │                                     │
│ │   市场投流             │ │                                     │
│ │     ├─ 归因分析        │ │                                     │
│ │     ├─ 活动管理        │ │                                     │
│ │     └─ ROI 报表        │ │                                     │
│ │                        │ │                                     │
│ │   分析                 │ │                                     │
│ │     ├─ 趋势分析        │ │                                     │
│ │     └─ 报表中心        │ │                                     │
│ │                        │ │                                     │
│ │   消息                 │ │                                     │
│ └────────────────────────┘ └─────────────────────────────────────┘
```

### 2.2 侧栏 (Sidebar) — `@/components/layout/Sidebar.tsx`

**设计要点:**
- 一级导航 = 4 大业务域 + 消息
- 二级导航 = 子模块（展开/折叠，当前域自动展开）
- 高亮当前路径
- 支持折叠模式（仅显示图标）
- 响应式：移动端 Drawer

```tsx
// 导航数据结构
interface NavDomain {
  key: string;
  label: string;          // i18n key
  icon: LucideIcon;
  defaultExpanded?: boolean;
  children: NavItem[];
}

interface NavItem {
  href: string;
  label: string;
  icon?: LucideIcon;
  badge?: number;          // 可选角标
  roles?: string[];        // 可见角色，undefined = 全部可见
}

const NAV_STRUCTURE: NavDomain[] = [
  {
    key: 'overview',
    label: 'nav.overview',
    icon: LayoutDashboard,
    children: [
      { href: '/overview', label: 'nav.dashboard' },
    ],
  },
  {
    key: 'sales',
    label: 'nav.sales',
    icon: Users,
    defaultExpanded: true,
    children: [
      { href: '/sales/leads', label: 'nav.leads' },
      { href: '/sales/pipeline', label: 'nav.pipeline' },
      { href: '/sales/contracts', label: 'nav.contracts' },
      { href: '/sales/payments', label: 'nav.payments' },
      { href: '/sales/team', label: 'nav.team', roles: ['admin', 'operator'] },
    ],
  },
  {
    key: 'marketing',
    label: 'nav.marketing',
    icon: BarChart3,
    children: [
      { href: '/marketing/ads', label: 'nav.ads' },
      { href: '/marketing/campaigns', label: 'nav.campaigns' },
      { href: '/marketing/roi', label: 'nav.roi' },
    ],
  },
  {
    key: 'analytics',
    label: 'nav.analytics',
    icon: TrendingUp,
    children: [
      { href: '/analytics/trends', label: 'nav.trends', roles: ['admin', 'operator'] },
      { href: '/analytics/reports', label: 'nav.reports', roles: ['admin', 'operator'] },
    ],
  },
  {
    key: 'messages',
    label: 'nav.messages',
    icon: MessageSquare,
    children: [
      { href: '/messages', label: 'nav.messages' },
    ],
  },
];
```

### 2.3 顶部栏 (TopBar) — `@/components/layout/TopBar.tsx`

**包含组件:**

| 区域 | 组件 | 说明 |
|------|------|------|
| 左侧 | `Breadcrumbs` | 基于当前路径自动生成面包屑 |
| 中间 | `GlobalFilters` | 时间范围选择器 + 销售成员选择器 |
| 右侧 | `UserMenu` | 头像 + 下拉菜单（设置/退出） |
| 移动端 | `MenuToggle` | 汉堡菜单按钮 |

**面包屑生成逻辑:**
```ts
// routeConfig.ts — 路径 → 面包屑映射
const BREADCRUMB_MAP: Record<string, BreadcrumbDef> = {
  '/overview':          { zh: '驾驶舱', en: 'Overview' },
  '/sales':             { zh: '销售管理', en: 'Sales' },
  '/sales/leads':       { zh: 'Leads', en: 'Leads' },
  '/sales/leads/[id]':  { zh: 'Lead 详情', en: 'Lead Detail', dynamic: true },
  '/sales/pipeline':    { zh: 'Pipeline', en: 'Pipeline' },
  '/sales/contracts':   { zh: '合同', en: 'Contracts' },
  '/sales/contracts/[id]': { zh: '合同详情', en: 'Contract Detail', dynamic: true },
  '/sales/payments':    { zh: '回款', en: 'Payments' },
  '/sales/team':        { zh: '团队', en: 'Team' },
  '/marketing':         { zh: '市场投流', en: 'Marketing' },
  '/marketing/ads':     { zh: '归因分析', en: 'Attribution' },
  '/marketing/campaigns': { zh: '活动管理', en: 'Campaigns' },
  '/analytics':         { zh: '分析', en: 'Analytics' },
};
```

**全局筛选器:**

```tsx
// GlobalFilters 组件接口
interface GlobalFiltersProps {
  timeRange: { start: Date; end: Date; preset: '7d' | '30d' | '90d' | 'thisMonth' | 'custom' };
  onTimeRangeChange: (range: GlobalFiltersProps['timeRange']) => void;
  selectedSalesPerson: string | null;  // null = 全部
  onSalesPersonChange: (id: string | null) => void;
  salesTeam: { id: string; name: string }[];
}
```

全局筛选器数据通过 **React Context** (`GlobalFilterContext`) 下发给所有子页面，子页面消费 `useGlobalFilters()` hook 来自动过滤数据。

### 2.4 认证后的根布局重构

```tsx
// src/app/(dashboard)/layout.tsx (重写)
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, role } = useAuthGate();  // 权限守卫

  return (
    <GlobalFilterProvider>   {/* 全局筛选 Context */}
      <Sidebar role={role} />
      <div className="flex-1 flex flex-col">
        <TopBar role={role} />
        <main className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>
    </GlobalFilterProvider>
  );
}
```

---

## 3. 数据聚合架构

### 3.1 问题分析

当前问题：**每个页面独立查询 leads 表**，驾驶舱、Pipeline、归因分析页面都执行类似的全量 leads select，导致：
- Client 端 N+1 查询浪费带宽
- 驾驶舱需要聚合 3 个域的数据（销售 + 回款 + 投流）
- 数据在浏览器端重复计算

### 3.2 分层数据架构

```
┌───────────────────────────────┐
│       UI 组件层 (消费侧)        │
│  DashboardPage / PipelinePage  │
└──────────┬────────────────────┘
           │ useDashboard() / usePipeline()
           ▼
┌───────────────────────────────┐
│    React Query / SWR 缓存层    │
│  （去重、缓存、自动刷新）        │
└──────────┬────────────────────┘
           │ useQuery / useMutation
           ▼
┌───────────────────────────────┐
│   Server Action / API Route   │
│  （Server 端执行）              │
└──────────┬────────────────────┘
           │ RLS-filtered queries
           ▼
┌───────────────────────────────┐
│     Supabase 数据层            │
│  ├─ 物化视图 (materialized)    │
│  ├─ Database Functions (RPC)   │
│  ├─ 原生表 (带索引)            │
│  └─ Realtime 订阅 (可选)       │
└───────────────────────────────┘
```

### 3.3 推荐的策略：Supabase RPC + Server Actions

#### 策略选择对比

| 方案 | 实时性 | N+1 风险 | 维护成本 | 适用场景 |
|------|--------|---------|---------|---------|
| ✅ **Supabase RPC** | ~分钟级 | 低 | 低 | **驾驶舱聚合查询**（推荐） |
| ✅ **Server Actions** | 实时 | 低 | 中 | **页面级数据 CRUD**（推荐） |
| ❌ 全量客户端查询 | 实时 | 高 | 低 | 仅限小型数据集 |
| ❌ 物化视图 | ~5分钟 | 低 | 中 | 已用 `sales_performance_v2` |
| ⚠️ Realtime 订阅 | 实时 | 低 | 高 | 多用户协作场景 |

#### 推荐方案：RPC + React Query (TanStack Query)

**Step 1: 创建 Supabase RPC 函数**

```sql
-- 1. 驾驶舱聚合查询 (一次调用获取所有概览数据)
CREATE OR REPLACE FUNCTION get_dashboard_overview(
  p_user_id UUID,
  p_role TEXT,
  p_start_date TIMESTAMPTZ DEFAULT date_trunc('month', now()),
  p_end_date TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSONB;
BEGIN
  -- 根据角色过滤数据 (RLS 在函数内显式执行)
  -- 销售只能看自己的数据，admin/operator 全量

  SELECT jsonb_build_object(
    'pipeline', (
      SELECT jsonb_agg(jsonb_build_object(
        'stage', stage,
        'count', COUNT(*),
        'value', COALESCE(SUM(quotation_value), 0),
        'weighted_value', COALESCE(SUM(quotation_value * COALESCE(win_probability, 0) / 100.0), 0)
      ))
      FROM leads
      WHERE (p_role IN ('admin','operator') OR assigned_to = p_user_id)
        AND updated_at BETWEEN p_start_date AND p_end_date
      GROUP BY stage
    ),
    'revenue', (
      SELECT COALESCE(SUM(amount_paid), 0)
      FROM payments p
      JOIN contracts c ON c.id = p.contract_id
      WHERE (p_role IN ('admin','operator') OR c.sales_person_id = p_user_id)
        AND p.paid_at BETWEEN p_start_date AND p_end_date
    ),
    'campaign_stats', (
      SELECT jsonb_agg(jsonb_build_object(
        'campaign', COALESCE(campaign_name, 'uncategorized'),
        'leads', COUNT(*),
        'won', COUNT(*) FILTER (WHERE stage = 'won'),
        'value', COALESCE(SUM(quotation_value) FILTER (WHERE stage = 'won'), 0)
      ))
      FROM leads
      WHERE (p_role IN ('admin','operator') OR assigned_to = p_user_id)
        AND created_at BETWEEN p_start_date AND p_end_date
      GROUP BY campaign_name
    ),
    'alerts', (
      SELECT jsonb_build_object(
        'yellow', COUNT(*) FILTER (WHERE ...),
        'red', COUNT(*) FILTER (WHERE ...)
      )
      FROM leads
      WHERE (p_role IN ('admin','operator') OR assigned_to = p_user_id)
        AND stage NOT IN ('won', 'lost')
    )
  ) INTO result;

  RETURN result;
END;
$$;
```

**Step 2: Server Action 封装 (推荐方式)**

```tsx
// src/lib/queries/getDashboardOverview.ts
'use server';

import { createServerSupabase } from '@/lib/supabase-server';

export async function getDashboardOverview(
  userId: string,
  role: string,
  timeRange: { start: Date; end: Date }
) {
  const supabase = await createServerSupabase();

  const { data, error } = await supabase.rpc('get_dashboard_overview', {
    p_user_id: userId,
    p_role: role,
    p_start_date: timeRange.start.toISOString(),
    p_end_date: timeRange.end.toISOString(),
  });

  if (error) throw error;
  return data as DashboardOverview;
}
```

**Step 3: Client 侧 React Query Hook**

```tsx
// src/lib/hooks/useDashboardOverview.ts
'use client';

import { useQuery } from '@tanstack/react-query';
import { getDashboardOverview } from '@/lib/queries/getDashboardOverview';
import { useGlobalFilters } from '@/components/layout/GlobalFilterContext';
import { useAuthGate } from '@/components/auth/AuthGate';

export function useDashboardOverview() {
  const { user, role } = useAuthGate();
  const { timeRange } = useGlobalFilters();

  return useQuery({
    queryKey: ['dashboard-overview', user.id, timeRange],
    queryFn: () => getDashboardOverview(user.id, role, timeRange),
    staleTime: 5 * 60 * 1000,     // 5 分钟缓存
    refetchInterval: 5 * 60 * 1000, // 5 分钟自动刷新
  });
}
```

### 3.4 驾驶舱数据流

```
用户打开 /overview
       │
       ▼
useDashboardOverview()        ← React Query
       │
       ▼
getDashboardOverview()         ← Server Action
       │
       ▼
supabase.rpc('get_dashboard_overview', { role, userId, timeRange })
       │
       ▼
───────┼─────────────────────────────────────────────────
       │  Supabase PostgreSQL — 单次 RPC 调用
       │
       ├─ 销售管道聚合 (leads 表)
       │   → stage 分组: count, value, weighted_value
       │
       ├─ 回款聚合 (payments + contracts 表)
       │   → 本月已收、逾期金额
       │
       ├─ 投流 ROI (leads 表之 campaign 维度)
       │   → 各渠道的 leads 数, 成交数, 成交金额
       │
       └─ 预警统计 (leads 表)
           → 黄灯/红灯数, 回收/转交候选数
───────┼─────────────────────────────────────────────────
       │
       ▼
返回 JSONB → React Query 缓存
       │
       ▼
DashboardPage 拆解 JSONB 到各子组件:
├─ OverviewKPIs        ← pipeline.total, revenue.total
├─ SalesSnapshot       ← 各阶段漏斗条形图
├─ RevenueChart        ← 回款趋势图
├─ AdROICard           ← campaign_stats
└─ AlertsPanel         ← alerts
```

### 3.5 实时性决策矩阵

| 页面 | 更新频率 | 策略 | 缓存时间 |
|------|---------|------|---------|
| 驾驶舱 `/overview` | 几分钟刷新 | RPC + React Query poll | 5 min |
| Pipeline `/sales/pipeline` | 操作后刷新 | RPC + Mutation 失效 | 实时 |
| Leads 看板 `/sales/leads` | 实时 | Server Actions | 实时 |
| 归因 `/marketing/ads` | 几分钟 | RPC | 5 min |
| 合同 `/sales/contracts` | 操作后刷新 | Server Actions | 实时 |
| 回款 `/sales/payments` | 操作后刷新 | Server Actions | 实时 |
| 分析 `/analytics/trends` | 慢（天级） | RPC + 缓存 | 1 hr |

---

## 4. 权限路由守卫方案

### 4.1 三层权限体系

```
Layer 1: Proxy (Middleware)        ← 认证检查
    ↓ 通过
Layer 2: Layout Gate               ← 角色/页面级守卫
    ↓ 通过
Layer 3: RLS (Database)            ← 行级数据安全
```

### 4.2 Layer 1: Proxy 重写 (认证+路由拦截)

```tsx
// src/proxy.ts (重写)
const PROTECTED_ROUTES = [
  '/overview',
  '/sales', '/sales/leads', '/sales/pipeline', '/sales/contracts', '/sales/payments', '/sales/team',
  '/marketing', '/marketing/ads', '/marketing/campaigns', '/marketing/roi',
  '/analytics', '/analytics/trends', '/analytics/reports',
  '/messages',
];

// 角色访问控制矩阵
const ROLE_ACCESS: Record<string, string[]> = {
  '/overview':             ['admin', 'operator'],
  '/analytics':            ['admin', 'operator'],
  '/analytics/*':          ['admin', 'operator'],
  '/sales/team':           ['admin', 'operator'],
  '/sales':                ['admin', 'operator', 'finance', 'sales'],
  '/sales/leads':          ['admin', 'operator', 'sales'],
  '/sales/pipeline':       ['admin', 'operator', 'sales'],
  '/sales/contracts':      ['admin', 'operator', 'finance', 'sales'],
  '/sales/payments':       ['admin', 'operator', 'finance'],
  '/marketing/*':          ['admin', 'operator'],
  '/messages':             ['admin', 'operator', 'finance', 'sales'],
};

export async function proxy(request: NextRequest) {
  const { supabase, response } = createMiddlewareClient(request);
  const { data: { session } } = await supabase.auth.getSession();
  const { pathname } = request.nextUrl;

  // 1. 认证检查
  if (!session) {
    // 保护路由列表
    const isProtected = PROTECTED_ROUTES.some(r => pathname.startsWith(r));
    if (isProtected) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
    return response;
  }

  // 2. 获取用户角色 (从 profiles 表)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .single();

  const role = profile?.role || 'sales';

  // 3. 角色路由守卫
  const matchedRoute = Object.entries(ROLE_ACCESS).find(
    ([route]) => route === pathname || (route.endsWith('/*') && pathname.startsWith(route.slice(0, -2)))
  );

  if (matchedRoute && !matchedRoute[1].includes(role)) {
    // 无权限 → 重定向到有权限的首页
    const fallback = role === 'sales' ? '/sales/leads'
      : role === 'finance' ? '/sales/payments'
      : '/overview';
    return NextResponse.redirect(new URL(fallback, request.url));
  }

  // 4. 将角色信息注入 request headers（供 Server Components 消费）
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-user-role', role);
  requestHeaders.set('x-user-id', session.user.id);

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}
```

### 4.3 Layer 2: 客户端 AuthGate + 角色 Context

```tsx
// src/components/auth/AuthGate.tsx
'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

interface AuthState {
  user: { id: string; email: string };
  role: 'admin' | 'operator' | 'sales' | 'finance';
  loading: boolean;
}

const AuthContext = createContext<AuthState>(null!);

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ loading: true } as any);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/login');
        return;
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .single();

      setState({
        user: { id: session.user.id, email: session.user.email! },
        role: profile?.role || 'sales',
        loading: false,
      });
    })();
  }, []);

  if (state.loading) return <LoadingSkeleton />;
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuthGate = () => useContext(AuthContext);
```

### 4.4 角色 UI 组件的显隐

```tsx
// src/components/auth/RoleGuard.tsx
export function RoleGuard({
  roles,
  fallback = null,
  children,
}: {
  roles: string[];
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { role } = useAuthGate();
  if (!roles.includes(role)) return fallback;
  return <>{children}</>;
}

// 使用示例
<RoleGuard roles={['admin', 'operator']}>
  <SalesPerformanceChart />
</RoleGuard>
```

### 4.5 页面的角色守卫封装

```tsx
// src/components/auth/PageGuard.tsx
export function PageGuard({
  requiredRoles,
  fallbackUrl = '/overview',
  children,
}: {
  requiredRoles: string[];
  fallbackUrl?: string;
  children: React.ReactNode;
}) {
  const { role } = useAuthGate();
  const router = useRouter();

  if (!requiredRoles.includes(role)) {
    useEffect(() => { router.replace(fallbackUrl); }, []);
    return null;
  }

  return <>{children}</>;
}

// 在各业务域 layout 中使用
// src/app/sales/layout.tsx
export default function SalesLayout({ children }) {
  return (
    <PageGuard requiredRoles={['admin', 'operator', 'sales', 'finance']}>
      <SalesSubNav />
      {children}
    </PageGuard>
  );
}

// src/app/analytics/layout.tsx
export default function AnalyticsLayout({ children }) {
  return (
    <PageGuard requiredRoles={['admin', 'operator']}>
      {children}
    </PageGuard>
  );
}
```

---

## 5. 共享组件设计

### 5.1 设计原则

1. **配置驱动** — 组件通过 props 控制行为，不硬编码数据来源
2. **数据无关** — 组件接收数据，不直接调用 API
3. **多态渲染** — 同一组件在不同上下文呈现不同大小/布局
4. **类型安全** — 严格 TypeScript 接口

### 5.2 共享组件目录结构

```
src/components/
├── auth/                          # 权限相关
│   ├── AuthGate.tsx               # 认证守卫 Provider
│   ├── RoleGuard.tsx              # 角色守卫组件
│   └── PageGuard.tsx              # 页面级守卫
│
├── layout/                        # 布局组件
│   ├── Sidebar.tsx                # 侧栏导航
│   ├── TopBar.tsx                 # 顶部栏
│   ├── Breadcrumbs.tsx            # 面包屑
│   ├── GlobalFilters.tsx          # 全局筛选器
│   └── GlobalFilterContext.tsx     # 筛选 Context
│
├── sales/                         # 销售域共享组件
│   ├── SalesPipeline.tsx          # Pipeline 多态组件 ★核心
│   ├── SalesPersonSelector.tsx    # 销售选择下拉
│   ├── LeadTransferDialog.tsx     # Lead 转交弹窗
│   ├── LeadCard.tsx               # Lead 卡片 (看板模式)
│   ├── LeadTable.tsx              # Lead 表格 (列表模式)
│   ├── StageBadge.tsx             # 阶段标签
│   └── ProbabilitySelect.tsx      # 概率选择器
│
├── marketing/                     # 市场域共享组件
│   ├── AttributionTable.tsx       # 归因分析表格
│   ├── ChannelBreakdown.tsx       # 渠道分解图
│   └── ROIMetric.tsx              # ROI 指标卡片
│
├── charts/                        # 图表组件
│   ├── FunnelChart.tsx            # 漏斗图 (通用)
│   ├── RevenueTrend.tsx           # 回款趋势折线图
│   ├── StageBar.tsx               # 阶段横条图
│   └── PieDistribution.tsx        # 饼图/环形图
│
├── data/                          # 数据组件
│   ├── DataTable.tsx              # 通用表格 (排序/筛选/分页)
│   ├── KPICard.tsx                # KPI 指标卡片
│   └── MetricGrid.tsx             # 指标网格布局
│
└── ui/                            # shadcn/ui 基础组件 (不变)
    ├── button.tsx
    ├── card.tsx
    └── ...
```

### 5.3 SalesPipeline 多态组件 — 核心共享组件

这是**最关键的共享组件**，被 4 个不同页面以不同形态使用。

```tsx
// src/components/sales/SalesPipeline.tsx

// ─── Props 接口 ───
export interface StageDef {
  key: string;
  label: string;
  color: string;
}

export interface LeadItem {
  id: string;
  customerName: string;
  stage: string;
  value: number | null;
  probability: number | null;
  assignee: string | null;
  lastContactDays: number | null;
  status: string | null;
  // ... 其他字段
}

export type PipelineViewMode = 'board' | 'table' | 'compact' | 'mini';

export interface SalesPipelineProps {
  stages: StageDef[];
  leads: LeadItem[];
  viewMode: PipelineViewMode;       // 视图模式
  maxItems?: number;                // 限制显示条目
  onLeadClick?: (id: string) => void;
  onStageChange?: (leadId: string, newStage: string) => void;
  showHeader?: boolean;             // 是否显示标题行
  showValue?: boolean;              // 是否显示金额
  showProbability?: boolean;        // 是否显示概率
  compact?: boolean;                // 紧凑模式
  className?: string;
}

// ─── 使用场景 ───
//
// 1. /sales/pipeline 页面
//    viewMode="board"          — 完整看板（9列 Kanban）
//    maxItems={unlimited}
//
// 2. /overview 驾驶舱
//    viewMode="compact"        — 小卡片版（每阶段仅显示 1-2 张）
//    maxItems={2}
//    showHeader={false}
//    compact={true}
//
// 3. /sales/leads 页面 (团队漏斗)
//    viewMode="table"          — 表格模式，按销售成员分组
//
// 4. /sales/leads/[id] 详情页
//    viewMode="mini"           — 极简版本（仅显示当前 Lead 的阶段路径）
//    showHeader={false}
//    maxItems={1}
```

**实现策略：**

```tsx
export function SalesPipeline({
  stages,
  leads,
  viewMode = 'board',
  maxItems = Infinity,
  onLeadClick,
  onStageChange,
  showHeader = true,
  showValue = true,
  showProbability = true,
  compact = false,
  className,
}: SalesPipelineProps) {
  // 按阶段分组
  const grouped = useMemo(() => {
    const g: Record<string, LeadItem[]> = {};
    for (const stage of stages) g[stage.key] = [];
    for (const lead of leads) {
      if (g[lead.stage]) {
        g[lead.stage].push(lead);
      }
    }
    return g;
  }, [leads, stages]);

  // 根据 viewMode 选择渲染器
  switch (viewMode) {
    case 'board':
      return <PipelineBoardView stages={stages} grouped={grouped}
        maxItems={maxItems} onLeadClick={onLeadClick} onStageChange={onStageChange}
        showHeader={showHeader} showValue={showValue} showProbability={showProbability}
        compact={compact} className={className} />;
    case 'table':
      return <PipelineTableView stages={stages} leads={leads}
        onLeadClick={onLeadClick} className={className} />;
    case 'compact':
    case 'mini':
      return <PipelineCompactView stages={stages} grouped={grouped}
        maxItems={maxItems} onLeadClick={onLeadClick}
        showValue={showValue} showProbability={showProbability}
        mini={viewMode === 'mini'} className={className} />;
    default:
      return null;
  }
}
```

### 5.4 DataTable 通用组件

```tsx
// src/components/data/DataTable.tsx
export interface DataTableColumn<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render: (item: T) => React.ReactNode;
  filterable?: boolean;
  width?: string;
}

export interface DataTableProps<T> {
  data: T[];
  columns: DataTableColumn<T>[];
  loading?: boolean;
  emptyMessage?: string;
  onRowClick?: (item: T) => void;
  pageSize?: number;
  searchable?: boolean;
  searchFields?: (keyof T)[];
}
```

### 5.5 KPICard + MetricGrid

```tsx
// src/components/data/KPICard.tsx
export interface KPICardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon: LucideIcon;
  color: string;
  bg: string;
  trend?: { direction: 'up' | 'down'; pct: number };
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
}

// src/components/data/MetricGrid.tsx
export interface MetricGridProps {
  items: KPICardProps[];
  columns?: 3 | 4 | 6;
}
```

### 5.6 现有页面迁移对照

| 页面 | 使用的主要共享组件 | 迁移工作 |
|------|-------------------|---------|
| `/overview` | KPICard, MetricGrid, SalesPipeline(compact), FunnelChart, RevenueTrend | 重写数据层，复用组件 |
| `/sales/leads` | SalesPipeline(board), LeadCard, StageBadge, DataTable, LeadTransferDialog | 大部分代码迁移 |
| `/sales/pipeline` | SalesPipeline(table), FunnelChart, StageBar | 简化，复用 SalesPipeline |
| `/marketing/ads` | AttributionTable, ChannelBreakdown, DataTable | 提取 |
| `/messages` | DataTable | 小改 |
| `/sales/contracts` | DataTable, KPICard | 新建 |

---

## 6. 迁移计划

### 6.1 三阶段迁移策略

```
Phase 1 — 基础设施 (2-3天)
├── 创建新目录结构
├── 实现 AuthGate + PageGuard
├── 实现 Sidebar 多级导航
├── 实现 TopBar + Breadcrumbs + GlobalFilterContext
├── 添加 next.config redirects
└── 安装 @tanstack/react-query

Phase 2 — 核心迁移 (3-4天)
├── 创建 SalesPipeline 多态组件
├── 迁移 /pipeline → /sales/pipeline
├── 迁移 /leads → /sales/leads (含 [id], new)
├── 迁移 /ads → /marketing/ads
├── 创建 /overview 驾驶舱 (使用 RPC 聚合)
├── 创建 Supabase RPC: get_dashboard_overview
└── 创建共享组件 (DataTable, KPICard 等)

Phase 3 — 增量完善 (2-3天)
├── 创建 /sales/payments 回款页面
├── 创建 /sales/contracts 合同页面
├── 创建 /marketing/campaigns 活动管理
├── 创建 /analytics 分析页面
├── 完善 RoleGuard 各页面守卫
├── 全局筛选器集成到所有页面
└── 端到端测试 + 旧路由重定向验证
```

### 6.2 迁移风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 旧书签失效 | 用户体验下降 | 所有旧路由 301 重定向 |
| 数据不一致 | 双写问题 | 同一 Supabase 实例，无双写风险 |
| 开发中需要同时维护两套路由 | 工作量翻倍 | 先改 Layout + Proxy，页面逐步迁移 |
| React Query 学习成本 | 进度延迟 | 渐进引入，现有页面先用 Server Actions |
| RPC 函数性能异常 | 驾驶舱加载慢 | 先在生产环境用简单的多 RPC，后合并 |

### 6.3 推荐执行顺序

```
Day 1-2: 基础设施
  1. 新建目录结构 (空页面 + redirects)
  2. AuthGate + RoleGuard + Proxy 重写
  3. 新 Sidebar + TopBar + Breadcrumbs
  4. GlobalFilterContext
  5. @tanstack/react-query 集成

Day 3-4: 核心页面迁移
  6. SalesPipeline 多态组件
  7. /sales/pipeline (复用 SalesPipeline board)
  8. /sales/leads (复用 SalesPipeline + 现有代码迁移)
  9. /overview (创建 RPC + 驾驶舱重构)
  10. /marketing/ads (复用归因组件)

Day 5-6: 新增功能
  11. /sales/contracts + /sales/payments
  12. /analytics 入口
  13. 全面集成 GlobalFilter
  14. 端到端测试 + 回归

Day 7: 收尾
  15. 删除旧 page.tsx (确认无流量)
  16. 性能优化
  17. 文档更新
```

### 6.4 旧路由清理条件

当满足以下所有条件时，可安全删除旧路由：

- [ ] 所有 301 重定向已稳定运行 ≥ 1 周
- [ ] 监控中 404 率为 0（针对旧路由）
- [ ] 团队确认未使用旧路径快捷方式
- [ ] 内部测试覆盖所有旧→新跳转

---

## 附录 A: 关键技术决策记录

| 决策编号 | 决策 | 方案 | 理由 |
|---------|------|------|------|
| ADR-001 | 数据聚合方案 | Supabase RPC + React Query | 避免 N+1，单次 RPC 返回完整 JSONB |
| ADR-002 | 路由守卫方案 | Proxy (Middleware) + Layout Gate + RLS | 三层纵深防御 |
| ADR-003 | 驾驶舱刷新策略 | 5 分钟轮询 (poll) | 驾驶舱不需要秒级实时 |
| ADR-004 | 导航数据结构 | 配置驱动 (NAV_STRUCTURE 数组) | 权限过滤 + i18n 统一管理 |
| ADR-005 | 共享组件方案 | 配置驱动多态组件 | 避免 props 爆炸，保持灵活性 |
| ADR-006 | 重定向类型 | 优先 301 (永久) | SEO 友好，浏览器缓存 |

## 附录 B: 目录迁移 check-list

```
旧路径 → 新路径 (迁移对照清单)
─────────────────────────────────────
□ /leads/page.tsx           → /sales/leads/page.tsx
□ /leads/[id]/page.tsx      → /sales/leads/[id]/page.tsx
□ /leads/new/page.tsx       → /sales/leads/new/page.tsx
□ /pipeline/page.tsx        → /sales/pipeline/page.tsx
□ /dashboard/page.tsx       → /overview/page.tsx (重写)
□ /ads/page.tsx             → /marketing/ads/page.tsx
□ /messages/page.tsx        → /messages/page.tsx (原地)
□ /projects/page.tsx        → /sales/contracts/page.tsx (新建)
□ /quotes/page.tsx          → 废弃/重定向到 /sales/leads?stage=quotation_submitted
□ (dashboard)/layout.tsx    → 重写为新布局
□ proxy.ts                  → 重写 (角色鉴权 + 路由守卫)
```

---

> **文档编辑记录**  
> v1.0 — 2026-06-03 — 初始完整方案，覆盖路由重组、导航体系、数据聚合、权限守卫、共享组件、迁移计划
