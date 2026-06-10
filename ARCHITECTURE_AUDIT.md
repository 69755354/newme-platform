# NewMe CRM 系统 — 架构总监审计报告

**审计时间**: 2026-06-04  
**代码路径**: /home/ubuntu/newme-platform  
**生产 URL**: https://app.newme.ae  
**技术栈**: Next.js 16.2.6 + React 19.2.4 + Supabase + TypeScript 5 + Tailwind CSS 4

---

## 1. 代码架构 (Code Architecture)

### 1.1 总体架构

```
┌─────────────────────────────────────────────────────────┐
│                    浏览器 (Client)                        │
│  Next.js 16 App Router / React 19 / Tailwind CSS 4       │
├─────────────────────────────────────────────────────────┤
│                    Next.js Server                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│  │ Dashboard│ │Leads     │ │ Ads      │ │ Pipeline     │ │
│  │ 页面     │ │ Kanban   │ │ Attribution│ │ Funnel分析  │ │
│  └──────────┘ └──────────┘ └──────────┘ └─────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│  │ 登录页   │ │Lead详情  │ │ Quotes   │ │ Projects     │ │
│  │(手动Auth)│ │          │ │(建设中)  │ │ (建设中)     │ │
│  └──────────┘ └──────────┘ └──────────┘ └─────────────┘ │
│  ┌──────────────────────────────────────────────────┐    │
│  │  API Routes                                      │    │
│  │  /api/hermes/generate-quote  → Hermes Engine     │    │
│  │  /api/leads/meta-capi        → Meta CAPI Ingest  │    │
│  └──────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────┤
│          Supabase (BaaS: Auth + PostgreSQL + RLS)         │
│  ┌──────────┐ ┌──────────────────┐ ┌──────────────────┐  │
│  │ Auth     │ │ PostgreSQL DB    │ │ Row Level        │  │
│  │ (JWT)    │ │ 7 tables + views │ │ Security (RLS)   │  │
│  └──────────┘ └──────────────────┘ └──────────────────┘  │
├─────────────────────────────────────────────────────────┤
│          Hermes Engine (127.0.0.1:22884)                  │
│  CAD分析 / 报价生成 / PPT方案                              │
└─────────────────────────────────────────────────────────┘
```

### 1.2 目录结构

```
src/
├── app/
│   ├── layout.tsx                 # Root layout (dark theme)
│   ├── page.tsx                   # Redirect → /leads
│   ├── globals.css                # Copper/wine brand theme
│   ├── login/page.tsx             # Custom login (manual auth)
│   ├── (dashboard)/
│   │   ├── layout.tsx             # Sidebar + LanguageProvider
│   │   ├── dashboard/page.tsx     # KPI + funnel + alerts
│   │   ├── leads/page.tsx         # Kanban board (500 lines+)
│   │   ├── leads/[id]/page.tsx    # Detail page (630 lines+)
│   │   ├── leads/new/page.tsx     # Create lead form
│   │   ├── pipeline/page.tsx      # Pipeline analysis
│   │   ├── ads/page.tsx           # Attribution analytics
│   │   ├── quotes/page.tsx        # Placeholder
│   │   ├── projects/page.tsx      # Placeholder
│   │   └── messages/page.tsx      # Placeholder
│   └── api/
│       ├── hermes/generate-quote/route.ts
│       └── leads/meta-capi/route.ts
├── components/ui/                 # shadcn UI components
├── lib/
│   ├── supabase.ts                # Client SDK (anon key)
│   ├── supabase-server.ts         # Server SDK (cookie-based)
│   ├── hermes.ts                  # Hermes API bridge
│   ├── utils.ts                   # cn() helper
│   └── i18n/
│       ├── translations.ts        # EN/ZH translations
│       └── LanguageContext.tsx     # Context provider
└── proxy.ts                       # Middleware (pass-through)
supabase/migrations/               # 6 migration files
```

### 1.3 关键架构决策

| 决策 | 选择 | 评价 |
|------|------|------|
| 前端框架 | Next.js 16 App Router | ✅ 最新版, RSC 支持 |
| UI 方案 | Tailwind CSS 4 + shadcn | ✅ 现代, 高效 |
| 后端 | Supabase (BaaS) | ✅ 免运维, 快速上线 |
| AI 引擎 | Hermes (:22884) | ✅ 独立微服务 |
| 认证方式 | 手动 localStorage Token | ⚠️ 非常规做法 |
| 状态管理 | React useState | ⚠️ 无全局状态管理 |
| 数据获取 | 客户端 fetch | ⚠️ 无 SWR/React Query |

---

## 2. 数据流 (Data Flow)

### 2.1 正常数据流

```
[Meta Ads] → CAPI Webhook → /api/leads/meta-capi
                                ↓ (TODO: 未连接 Supabase)
                            Console.log only

[Sales Manual] → /leads/new → supabase.from("leads").insert()
                                ↓
                            leads 表 ← 前端实时 re-fetch

[Kanban 操作] → stage/status/probability 更新
                   ↓
              leads 表 + activities 表 + business_events 表
                   ↓
              Supabase 触发器: update_lead_metrics()
                   ↓
              自动计算: recovery/transfer/manager_review 标记

[Hermes 报价] → /api/hermes/generate-quote
                   ↓ (Service Role Key)
              Supabase → leads 表查询
                   ↓
              Hermes Engine → /api/smart-home/quote
                   ↓
              Supabase → quotes 表 insert + activities + leads update
```

### 2.2 关键发现

- **Meta CAPI 处于断连状态** — `TODO` 注释明确表示 Supabase 未连接, leads 只落日志
- **无实时订阅** — 所有页面在 mount 时执行一次性 `fetch()`, 缺乏实时性
- **全表查询模式** — `supabase.from("leads").select("*").limit(500)` 在4个页面重复
- **前端业务逻辑耦合** — stage 变更、事件记录、分数计算全部在前端 JS 中硬编码

---

## 3. Schema 设计 (Schema Design)

### 3.1 当前表结构

| 表 | 用途 | 行数预估 | 备注 |
|----|------|----------|------|
| `leads` | 线索主表 | ~500+ | 70+ 列, 严重宽表 |
| `profiles` | 用户配置 | 少量 | 接 Supabase Auth |
| `activities` | 活动日志 | 中量 | 时间线展示 |
| `business_events` | 业务事件 | 中量 | 与 activities 功能重叠 |
| `chat_messages` | WhatsApp 聊天 | - | 未使用 |
| `customers` | 客户 | - | 未使用 |
| `projects` | 项目 | - | 未使用 |
| `quotes` | 报价 | 少量 | 功能未完成 |

### 3.2 leads 表问题 — ⚠️ 严重宽表反模式

`leads` 表当前有 **70+ 列**，包括:

```
基本字段: id, source, quality, stage, customer_name, phone, email, property_type, 
          property_size_sqm, location, budget_range, service_needs, notes

AI 字段: ai_summary, ai_tags, ai_quality

CRM v2 字段: lead_status, win_probability, stage_changed_at, decision_maker, 
             decision_date, competitor, last_contact_date, next_followup_date,
             next_action, followup_count, lost_reason, lost_at

归因字段 (20列): source_platform, source_channel, campaign_id, campaign_name,
                 adset_id, adset_name, ad_id, ad_name, creative_id, creative_name,
                 form_id, form_name, utm_source~term, fbclid, gclid,
                 landing_page, referrer, first_touch_at, last_touch_at

管理字段: recovery_candidate, transfer_candidate, sales_manager_review, hold_since,
         disqualified_candidate, quotation_value, assigned_to, owner, sales_manager

重复字段: stage/stage_old, funnel_stage/stage (已修复),
         followup_count/follow_up_count (二义性)

UUID 冗余: assigned_to(Text)/assigned_to_uuid(UUID), owner(Text)/owner_uuid(UUID)
```

### 3.3 迁移历史杂乱

6 次迁移文件显示 schema 演化失控:
- 20260601000000: Phase 1 init (281行)
- 20260602000000: CRM v2 columns 添加
- 20260602010000: MVP final (添加业务事件表 + 20+归因列)
- 20260602020000: Hotfix (owner 列, 开放 RLS)
- 20260603000000: 第三次添加冗余字段 (有语法错误 "ALTER TABLE TABLE")
- 20260604000000: Schema fix (重命名 stage, 添加 UUID 列, 修复历史)

### 3.4 缺少的 Schema 设计要点

- **无归一化**: attribution 数据应独立为 `lead_attributions` 表
- **无枚举类型**: stage, status 等使用 TEXT CHECK, 应使用自定义枚举
- **无软删除**: 没有 deleted_at 字段
- **列二义性**: `followup_count` vs `follow_up_count` 矛盾
- **数据类型不一致**: 部分字段 DATE 部分 TIMESTAMPTZ

---

## 4. 安全性 (Security) — ⚠️ 严重问题

### 4.1 认证体系风险

| 问题 | 严重程度 | 说明 |
|------|---------|------|
| **手动 localStorage 认证** | 🔴 **CRITICAL** | 登录页直接 POST 到 Supabase Auth REST API, 后将 token 存 localStorage |
| **Supabase anon key 硬编码** | 🔴 **CRITICAL** | 在 `supabase.ts` 和 `login/page.tsx` 中明文写死 |
| **Service Role Key 在客户端可达** | 🔴 **CRITICAL** | `/api/hermes/generate-quote` 使用 Service Role Key 绕过所有 RLS |
| **Service Key 写在 .env.local** | 🟡 HIGH | `SUPABASE_SERVICE_ROLE_KEY` 明文在文件系统 |
| **Supabase PAT 在 .env.local** | 🟡 HIGH | 个人访问令牌不应存在于代码环境 |
| **无中间件认证检查** | 🟡 HIGH | `proxy.ts` 是空函数, 无 token 验证, 无路由保护 |
| **RLS 已完全失效** | 🔴 **CRITICAL** | `be_anon_insert/select/update` 策略对 public 开放 |
| **CORS 未配置** | 🟡 MEDIUM | next.config.ts 为空 |

### 4.2 认证流程分析

当前认证流程:
```
用户输入邮箱密码
  → 前端直接 POST 到 https://vfopmpxlhwzpxqegayew.supabase.co/auth/v1/token?grant_type=password
  → 拿到 access_token + refresh_token
  → 存入 localStorage key: "sb-vfopmpxlhwzpxqegayew-auth-token"
  → 后续请求从 localStorage 读取并 setSession()
```

**问题**:
1. 不使用 Supabase Auth UI 库或 SSR cookie 方案
2. localStorage 易受 XSS 攻击
3. 无 token 刷新逻辑 (autoRefreshToken: false)
4. 首次加载无认证检查 — 直接访问 /leads 应重定向到登录页, 但无中间件保护

### 4.3 RLS 名存实亡

```
20260602020000 热修复后:
  be_anon_insert ON business_events FOR INSERT TO public WITH CHECK (true);
  be_anon_select ON business_events FOR SELECT TO public USING (true);
  be_anon_update ON business_events FOR UPDATE TO public USING (true);
```

这意味着 **任何知道 Supabase URL 的人** 都可以读取/写入 business_events 表。

### 4.4 环境变量泄露

- `.env.local` 包含 `SUPABASE_PAT=sbp_bbaf7ebe1a9a262efc5e52d3ad74341b17f1267e`
- `SUPABASE_SERVICE_ROLE_KEY=eyJhbG...` 有权限绕过所有 RLS
- 这些文件被 git 跟踪的可能性 (需检查 .gitignore)

---

## 5. 性能 (Performance)

### 5.1 数据查询模式

| 页面 | 查询 | 问题 |
|------|------|------|
| Dashboard | `SELECT * FROM leads LIMIT 500` | 全表扫描, 70列拉取 |
| Leads Board | `SELECT * FROM leads ORDER BY updated_at DESC LIMIT 500` | 同上 |
| Lead Detail | `SELECT * FROM leads WHERE id = ?` (+activities + events) | 单个页面3次查询 |
| Ads | `SELECT * FROM leads ORDER BY created_at DESC LIMIT 500` | 全表扫描 |
| Pipeline | `SELECT * FROM leads LIMIT 500` | 全表扫描 |

### 5.2 性能风险

1. **无分页**: 所有页面 limit 500, 数据增长后性能下降
2. **无选择性列**: 全部使用 `select("*")", 70 列传输
3. **客户端过滤/计算**: 所有统计(漏斗、归因、KPI) 在 JavaScript 中完成, 无数据库聚合
4. **无数据库视图复用**: 虽然创建了 `lead_alerts` 和 `pipeline_summary` 视图, 但前端未使用
5. **重复查询**: leads 数据在 Dashboard(1次), Leads Board(1次), Ads(1次), Pipeline(1次) 各拉一次
6. **无缓存策略**: 无 SWR/React Query, 每次挂载重新拉取

### 5.3 索引覆盖情况

✅ **良好**: 迁移文件创建了大量的索引 (stage, status, probability, dates, flags)
⚠️ **缺失**: 暂无 `(stage, updated_at DESC)` 或者 `(assigned_to, stage)` 复合索引
⚠️ **缺失**: `business_events(lead_id, created_at DESC)` 覆盖查询

---

## 6. 总体评估和建议

### 综合评分

| 维度 | 评分 | 趋势 |
|------|------|------|
| 代码架构 | ⭐⭐⭐ (3/5) | 快速 MVP, 架构简洁但扩展性差 |
| 数据流 | ⭐⭐ (2/5) | 重复提取、无实时性、Meta CAPI 断连 |
| Schema 设计 | ⭐⭐ (2/5) | 宽表反模式、列重复、命名冲突 |
| 安全性 | ⭐ (1/5) | **严重漏洞**: localStorage + 硬编码 key + RLS 失效 |
| 性能 | ⭐⭐⭐ (3/5) | 当前可用, 规模扩展会出问题 |

### 紧急修复 (P0)

1. **🔴 认证重构**: 使用 Supabase SSR cookie 方案替代 localStorage
2. **🔴 Service Key 保护**: 移除 .env.local 中的敏感 key, 使用受限的 Supabase 令牌
3. **🔴 RLS 修复**: 撤销 public 策略, 恢复真实 RLS
4. **🔴 中间件认证**: 实现 Next.js middleware 验证 session

### 高优先级 (P1)

1. **Meta CAPI 接入 Supabase**: 完成 TODO 代码
2. **列清理**: 移除 `stage_old`, `followup_count`(保留一个), `assigned_to`(Text), `owner`(Text)
3. **Schema 归一化**: 将 attribution 字段拆分到 `lead_attributions` 表
4. **数据查询优化**: 使用参数化查询、分页、选择性列

### 中优先级 (P2)

1. **React Query/SWR 集成**: 添加缓存层
2. **数据库视图使用**: 前端改用 `pipeline_summary` 和 `lead_alerts` 视图
3. **全局状态管理**: 考虑 Zustand 或 Jotai 管理 UI 状态
4. **报价/项目/消息**: 完成占位页面

### 改进建议

| 类别 | 建议 |
|------|------|
| 架构 | 拆分巨无霸 `leads/page.tsx` (627行+), 将 kanban 组件化 |
| 数据 | 采用 Supabase Realtime 订阅实现实时更新 |
| Schema | 创建 `lead_attributions` 表, 将 20 个归因列迁移出去 |
| 安全 | 添加 CSP headers, 实施真正的 JWT 验证 |
| 测试 | 当前无任何测试代码, 需引入 Vitest + Playwright |

---

*审计生成工具: Hermes Agent (深度审查模式)*  
*架构图: `/home/ubuntu/newme-platform/architecture.excalidraw`*
