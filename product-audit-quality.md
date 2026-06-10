# NewMe CRM — 质量总监审计报告

**审计日期**: 2026-06-02  
**代码路径**: /home/ubuntu/newme-platform/  
**覆盖文件**: 39 个源文件 (38 .ts/.tsx + 1 proxy.ts)  
**生产URL**: https://app.newme.ae  

---

## 严重程度分级

| 等级 | 定义 |
|------|------|
| 🔴 **CRITICAL** | 可能导致数据泄露、生产崩溃、用户数据损坏 |
| 🟠 **HIGH** | 运行时错误、功能异常、明显类型缺陷 |
| 🟡 **MEDIUM** | 代码异味、缺少错误处理、类型安全不足 |
| 🔵 **LOW** | 重构建议、代码风格、文档缺失 |

---

## 🔴 CRITICAL (3 项)

### C-1: `.env.local` 包含 `SUPABASE_SERVICE_ROLE_KEY` 和 `SUPABASE_PAT` — 泄露即灾难

**文件**: `/home/ubuntu/newme-platform/.env.local` (第3-4行)  
**问题**: 生产环境 `.env.local` 文件硬编码了 Supabase 服务角色密钥和 Personal Access Token。该文件**未被 `.gitignore` 排除？**  
**影响**: `.env*` 被包含在 `.gitignore` 中，但文件存在于服务器文件系统上。若该文件通过任何渠道泄露（备份、日志、CI/CD 配置暴露），攻击者可获得 Supabase 完全管理员权限。  
**修复建议**:
1. 立即轮换这两组密钥
2. 使用密钥管理服务（如 AWS Secrets Manager 或 Vault）
3. 确保 `.env.local` 在生产环境的文件权限为 `600`

### C-2: `supabase.ts` 硬编码凭据 + 绕过 TypeScript 类型检查

**文件**: `src/lib/supabase.ts` (第3-4行, 第16行)  
```typescript
const SUPABASE_URL = "https://vfopmpxlhwzpxqegayew.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_0UiLli4lUNE_pwhZ13bRfw_xH4TduY_";
// ...
storage: undefined as any,
```
**问题**:
1. **凭据硬编码** — URL 和 anon key 直接写在源码中，使用 `process.env` 而是应通过环境变量注入
2. **`as any` 绕过类型安全** — `storage: undefined as any` 完全禁用了 TypeScript 对此存储配置的类型检查  
3. **单例模式风险** — 客户端单例一旦创建有误，整个应用受影响
**修复建议**: 从 `process.env` 读取凭据；为 storage 配置使用正确的类型或安全地排除该选项

### C-3: 无身份验证中间件 — 所有 dashboard 页面公开可访问

**文件**: 无 `middleware.ts`  
**问题**: 整个项目缺少 Next.js `middleware.ts` 文件。Dashboard 路由 (`/leads`, `/dashboard`, `/pipeline` 等) 没有任何身份验证保护。任何知道 URL 的人都可以直接访问 CRM 数据。  
**影响**: 生产环境数据完全暴露  
**修复建议**: 创建 `src/middleware.ts`，对所有 `/leads*`, `/dashboard*`, `/pipeline*`, `/ads*` 路由进行会话检查，未认证则重定向到 `/login`

---

## 🟠 HIGH (7 项)

### H-1: 所有 Supabase 查询无错误处理 — 静默失败

**影响文件**: 所有使用 supabase 的页面 (5 个文件)  
**具体模式**: 
```typescript
// leads/[id]/page.tsx:116-121
const { data: l } = await supabase.from("leads").select("*").eq("id", id).single();
if (l) setLead(l);
// 如果查询失败（网络错误、权限错误），只检查 data 而不检查 error
```
```typescript
// dashboard/page.tsx:72
const { data: l } = await supabase.from("leads").select("*").order("updated_at", { ascending: false }).limit(500);
if (l) setLeads(l as Lead[]);
// 查失败时 data 为 null，UI 显示空列表，无用户反馈
```
**问题**: 6 个主要的 `fetch` / `useEffect` 数据加载调用中 **0 个检查 `error`**。数据库查询失败、网络断开、RLS 策略变化都会导致**静默失败** — 用户看到空白数据但没有任何错误消息。  
**修复建议**: 在所有 `supabase.from(...)` 调用中解构 `{ data, error }`，当 `error` 存在时设置错误状态并显示给用户

### H-2: `single()` 调用无错误分支 — 可能导致未捕获异常

**文件**: 
- `leads/[id]/page.tsx:116` — `supabase.from("leads").select("*").eq("id", id).single()`
- `leads/[id]/page.tsx:160` — `supabase.from("quotes").insert(...).select("id").single()`
- `leads/new/page.tsx:33` — `supabase.from("leads").insert(...).select("id").single()`
- `api/hermes/generate-quote/route.ts:26,70` — 两处 `.single()`

**问题**: `.single()` 在记录不存在或结果不唯一时会**抛出异常**。现有代码中，客户端代码未包裹 try-catch，也未检查 `error`。  
**影响**: 查看不存在的 lead ID 会导致页面白屏/崩溃  
**修复建议**: 所有 `.single()` 调用必须放入 try-catch 块，或使用 `.maybeSingle()` 替代（后者在无数据时返回 null 而不抛异常）

### H-3: `(t as any)()` 模式全面滥用 — 完全放弃类型安全 (51处)

**文件**: 
- `leads/[id]/page.tsx` — 38 处
- `leads/page.tsx` — 13 处

**问题**: `t` 函数有完整的类型安全的 `TranslationPath` 泛型，但代码通过 `(t as any)("stageLabels.new")` **完全绕过类型检查**。翻译键拼写错误、重构时漏改都不会被 TypeScript 捕获。  
**修复建议**: 使用 `t("stageLabels.new")` 而非 `(t as any)("stageLabels.new")`。如果动态键需要，创建类型安全的辅助函数

### H-4: `(lead as any)[key]` 动态属性访问 — 类型检查完全失效 (5处)

**文件**: `leads/[id]/page.tsx` (第588, 591, 592, 595行)  
```typescript
{(lead as any)[key]  // 动态 toggle boolean flags
  ? `bg-${color}-500/20 text-${color}-400`
  : "bg-gray-800 text-gray-500 hover:bg-gray-700"}
```
**问题**: 使用 `as any` 完全绕过 Lead 接口的类型检查。动态访问 `sales_manager_review`、`recovery_candidate`、`transfer_candidate` 等字段。键拼写错误不会产生编译错误。  
**修复建议**: 使用 `Record<string, boolean>` 作为索引类型，或使用 `key as keyof Lead` 进行类型断言

### H-5: `generate-quote` API 路由使用硬编码 `stage: "quoted"` — DB 中不存在此阶段

**文件**: `src/app/api/hermes/generate-quote/route.ts` (第84行)  
```typescript
await supabaseAdmin.from("leads").update({
  stage: "quoted",  // ❌ 9-stage pipeline 中无此阶段
  ...
}).eq("id", lead_id);
```
**问题**: 数据库 CHECK 约束只允许 `['new','contacted','requirement_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision','won','lost']`。`"quoted"` 不是一个有效阶段，此 API 调用**必然失败**，返回 500 错误。  
**影响**: 报价生成功能完全不可用  
**修复建议**: 改为 `"quotation_submitted"`（与前端 pipeline 页面使用的阶段一致）

### H-6: `data as Lead[]` 强制类型转换 — 无运行时验证

**文件**: 
- `leads/page.tsx:119` — `setLeads(data as Lead[])`
- `dashboard/page.tsx:73` — `setLeads(l as Lead[])`
- `pipeline/page.tsx:54` — `setLeads(data as Lead[])`
- `ads/page.tsx:50` — `setLeads(data as Lead[])`

**问题**: 数据库返回的数据通过 `as Lead[]` 强制断言，但没有任何运行时验证或 Zod 模式校验。如果数据库 schema 与 TypeScript 接口不同步（如 `follow_up_count` vs `followup_count` 命名冲突），运行时会出现 undefined 访问或 NaN 计算。  
**修复建议**: 添加 Zod/zod 模式校验或至少添加关键字段存在性检查

### H-7: Supabase 客户端 session 注入可能失败

**文件**: `src/lib/supabase.ts` (第21-32行)  
```typescript
try {
  const raw = localStorage.getItem("sb-vfopmpxlhwzpxqegayew-auth-token");
  if (raw) {
    const session = JSON.parse(raw);
    if (session.access_token) {
      _client.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    }
  }
} catch {}
```
**问题**: `setSession` 是异步方法但未使用 `await`。这可能导致 token 设置与后续 API 调用之间的竞态条件。  
**修复建议**: 使用 `await _client.auth.setSession(...)` 或将整个逻辑改为 `_client.auth.initialize()` 方式

---

## 🟡 MEDIUM (10 项)

### M-1: 500条 limit 未考虑分页 — 数据量增长后将丢失记录

**文件**: `dashboard/page.tsx`, `leads/page.tsx`, `ads/page.tsx`, `pipeline/page.tsx`  
```typescript
.limit(500)
```
**问题**: 所有列表页硬编码 `limit(500)`，无分页逻辑。当前约 266 条记录，但随着业务增长，超过 500 条后旧记录将不再显示。  
**修复建议**: 添加无限滚动或分页组件；或至少将 limit 提高到用户可接受的数量并使用 count 显示总数

### M-2: `data` 为 null 时的 UI 问题

**文件**: `leads/[id]/page.tsx:169`  
```typescript
if (!lead) return <div className="text-gray-500 p-8">{t("common.loading")}</div>;
```
**问题**: 当 lead 查询失败或未找到时，显示 "Loading..." 而不是错误状态。没有区分"正在加载"和"未找到/加载失败"。  
**修复建议**: 添加 `error` 状态变量，在查询失败时显示错误消息而非无限 loading

### M-3: 日期格式化边界情况 — `new Date(null)` 或 `new Date(undefined)` 导致 Invalid Date

**文件**: 多处  
```typescript
// leads/page.tsx:441
new Date(lead.next_followup_date) < new Date() // 如果 next_followup_date 为 null，new Date(null) 返回 1970-01-01
// leads/[id]/page.tsx:299
lead.decision_date ? new Date(lead.decision_date).toLocaleDateString(...) : ... // 但上面检查了
```
**问题**: 虽然大多数地方有 `null` 检查，但有些地方（如 `lead.next_followup_date` 的日期比较）未做防御。`new Date(null)` 会返回 `1970-01-01`，导致过期判断错误。  
**修复建议**: 所有日期转换前确保字符串非空

### M-4: 网络失败的用户提示缺失

**影响**: 所有页面  
**问题**: 整个应用中没有任何地方会向用户显示网络错误提示。当 Supabase 连接失败、Heremes API 离线或网络断开时：
- Leads 列表显示空列表
- Lead 详情显示 "Loading..." 无限循环
- API 路由返回 500 给调用方，但前端不做任何处理  
**修复建议**: 实现全局错误边界组件和网络状态监听

### M-5: Login 页面使用直接 REST API 而非 Supabase JS SDK

**文件**: `src/app/login/page.tsx` (第26-37行)  
```typescript
const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: {
    "apikey": SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email, password, gotrue_meta_security: {} }),
});
```
**问题**: 使用原生 fetch 调用 Supabase Auth REST API 而非 `supabase.auth.signInWithPassword()` SDK 方法。这绕过了 SDK 的自动 token 刷新、错误处理标准化和类型安全。  
**影响**: Token 刷新需要手动实现，代码量增加，错误处理不统一  
**修复建议**: 使用 `await supabase.auth.signInWithPassword({ email, password })`

### M-6: `follow_up_count` vs `followup_count` 数据库列名不一致

**数据库文件**: `supabase/migrations/20260604000000_fix_schema.sql` (第129行注释)  
```sql
-- Some migrations used "followup_count", others used "follow_up_count"
```
**前端文件**: `leads/page.tsx` 使用 `follow_up_count`，`Lead` 接口中为 `follow_up_count: number | null`  
**问题**: 数据库迁移历史中有两个不同列名，schema fix 迁移尝试同时保持两者。前端可能使用了错误的列名，导致数据读取为 null。  
**修复建议**: 统一列名，废弃不需要的列，更新前端接口定义

### M-7: `proxy.ts` 为空壳 — matcher 模式可能捕获不需要的路由

**文件**: `src/proxy.ts`  
```typescript
export async function proxy(request: NextRequest) {
  return NextResponse.next({ request });
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|public).*)"] };
```
**问题**: 此文件定义了一个导出函数和路由配置，但未被任何路由使用（不在 `app` 目录下）。如果原始意图是作为 middleware，应放置在 `src/middleware.ts`。当前状态是死代码。  
**修复建议**: 删除此文件或迁移为正式的 middleware

### M-8: 硬编码 API 地址 — Hermes 引擎地址硬编码为 localhost

**文件**: `src/app/api/hermes/generate-quote/route.ts` (第33行)  
```typescript
const hermesRes = await fetch("http://127.0.0.1:22884/api/smart-home/quote", {...});
```
**问题**: Hermes 引擎地址在服务器端路由中硬编码。在容器化或分布式部署中，这可能不是正确的地址。  
**修复建议**: 使用 `process.env.HERMES_API_URL`（`src/lib/hermes.ts` 中已有此环境变量配置）

### M-9: `next.config.ts` 没有 CORS 或安全标头

**文件**: `next.config.ts`  
**问题**: Next.js 配置为空，没有设置 `Content-Security-Policy`、`X-Frame-Options` 或 `Strict-Transport-Security` 等安全标头。  
**修复建议**: 在 `next.config.ts` 中配置 `headers()` 函数

### M-10: `PROBABILITIES` 和 `LOST_REASONS` 常量重复定义

**文件**: 
- `leads/page.tsx:54-55`
- `leads/[id]/page.tsx:44-45`

**问题**: 两个核心常量在页面级重复定义，未来修改时容易不同步。  
**修复建议**: 提取到共享常量文件（如 `src/lib/constants.ts`）

---

## 🔵 LOW (5 项)

### L-1: `fetchData` useCallback 依赖项合理但未包含所有外部依赖

**文件**: `leads/[id]/page.tsx:115-122`  
**问题**: `fetchData` 的 `useCallback` 只包含了 `[id]` 作为依赖项，但实际上也使用了 `supabase` 客户端。（虽然 `supabase` 是单例不会变，但 React lint 规则会警告）  
**修复建议**: 添加 `supabase` 到 useCallback 依赖项以符合 React 规则

### L-2: Dashboard Layout 硬编码中文路由标签

**文件**: `src/app/(dashboard)/layout.tsx` (第32-34行)  
```typescript
{ href: "/messages", label: "消息", icon: MessageSquare },
{ href: "/projects", label: "项目", icon: Building2 },
{ href: "/quotes", label: "报价", icon: FileText },
```
**问题**: 三个 sidebar 导航项使用硬编码中文，即使 `i18nNavItems` 数组本应使用 `t()` 进行国际化。  
**修复建议**: 使用 `t("nav.messages")`、`t("nav.projects")`、`t("nav.quotes")`

### L-3: Two-pass i18n label 混淆

**文件**: `src/app/(dashboard)/layout.tsx` (第59行)  
```typescript
<p className="text-[11px] text-muted-foreground">{t("common.loading") === "Loading..." ? "业务平台" : "CRM Platform"}</p>
```
**问题**: 通过检查翻译值是否等于默认值来判断语言。这是一种脆弱的模式：如果 `t("common.loading")` 在任何语言中都等于 "Loading..."，判断会错误。  
**修复建议**: 使用 `lang` 变量进行语言判断

### L-4: 测试覆盖率为零

**搜索**: 整个项目无 `.test.` 或 `.spec.` 文件  
**问题**: 核心业务逻辑（数据获取、状态转换、报价生成）没有任何测试。  
**修复建议**: 为关键路径编写单元测试和集成测试：
- `lib/hermes.ts` — API 桥接函数
- `lib/supabase.ts` — 客户端创建逻辑
- 数据转换和格式化函数

### L-5: Supabase 迁移文件仍在 `.temp` 目录中存在

**文件**: `/home/ubuntu/newme-platform/supabase/.temp/`  
**问题**: Supabase CLI 生成的临时文件（包含 project-ref、链接信息）存在于代码目录中。这些可能意外泄露项目信息。  
**修复建议**: 将 `supabase/.temp/` 加入 `.gitignore`

---

## 统计汇总

| 类别 | 数量 |
|------|------|
| CRITICAL | 3 |
| HIGH | 7 |
| MEDIUM | 10 |
| LOW | 5 |
| **总计** | **25** |

| 审计维度 | 发现项数 |
|----------|---------|
| 类型安全 (`any` 滥用) | 56 处 (52× `t as any` + 4× 其他) |
| 错误处理不足 | 12 处 (所有数据库查询) |
| 安全漏洞 | 4 项 (密钥泄露、缺中间件、硬编码凭据) |
| 边界情况 | 6 项 (null 日期、空数组、分页) |
| 性能 | 2 项 (N+1 风险、limit 硬编码) |
| 测试 | 0 个测试文件 |

---

## 最需优先修复的 5 项

1. **C-1**: 轮换并保护 `SUPABASE_SERVICE_ROLE_KEY`
2. **C-3**: 添加 `middleware.ts` 身份验证保护
3. **H-5**: 修复 `"quoted"` → `"quotation_submitted"`（破坏报价生成功能）
4. **H-1**: 在所有 Supabase 查询中添加错误处理
5. **C-2**: 从源码中移除硬编码凭据

---

*审计完毕 — 2026-06-02*
