# NewMe CRM Round 5 安全审计报告

**审计日期**: 2026-06-15  
**审计范围**: 安全 + 性能 + 代码质量  
**审计人**: 自动审计 (Round 5)  
**工作目录**: `/home/ubuntu/newme-platform`  
**技术栈**: Next.js 14 (App Router) + Supabase + TypeScript  

---

## 审计发现汇总

| 级别 | 安全 | 性能 | 代码质量 | 合计 |
|------|------|------|----------|------|
| P0   | 3    | 0    | 0        | 3    |
| P1   | 3    | 2    | 0        | 5    |
| P2   | 2    | 4    | 3        | 9    |
| P3   | 0    | 0    | 2        | 2    |
| **合计** | **8** | **6** | **5** | **19** |

---

## 一、安全审计

### [P0] S-01: Meta CAPI Webhook 端点在密钥未配置时完全开放

**文件**: `src/app/api/leads/meta-capi/route.ts:26-33`

**问题描述**:  
Webhook 认证逻辑使用 `if (webhookSecret)` 条件判断，当环境变量 `META_CAPI_WEBHOOK_SECRET` 未设置时，整个认证被跳过。攻击者可无认证调用此端点，通过 `supabaseAdmin`（service_role key）向 leads 表注入伪造线索数据。

```typescript
// 第 26-33 行
const webhookSecret = process.env.META_CAPI_WEBHOOK_SECRET;
if (webhookSecret) {  // ← 如果 env 未设置，整个认证被跳过！
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== webhookSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
```

**建议修复**:  
将 webhook secret 设为必填，未配置时拒绝请求：
```typescript
if (!webhookSecret) {
  console.error("META_CAPI_WEBHOOK_SECRET not configured");
  return NextResponse.json({ error: "Server misconfigured" }, { status: 503 });
}
```

---

### [P0] S-02: 代码引用的表缺少 RLS 策略 — 可能全表暴露或全部拒绝

**文件**: 
- `src/app/(dashboard)/leads/page.tsx:159` — `transfer_history`
- `src/app/(dashboard)/leads/[id]/page.tsx:222` — `transfer_history`
- `src/app/api/hermes/knx-design/route.ts:81` — `lead_files`
- `src/app/api/hermes/knx-design/route.ts:210` — `knx_designs`
- `src/app/api/meta/oauth-callback/route.ts:22` — `meta_tokens`

**问题描述**:  
上述 4 张表 (`transfer_history`, `lead_files`, `knx_designs`, `meta_tokens`) 在代码中被引用，但在 `supabase/migrations/` 中没有找到任何 `CREATE TABLE` 语句。这意味着：
- 如果这些表是手动创建或通过 Supabase Dashboard 创建，RLS 可能未启用 → **全表数据暴露**
- 如果 RLS 已启用但没有 policy → **所有查询返回空集**（功能故障）
- `20260613220000_rls_auto_protection.sql` 的自动保护脚本仅对已有表生效，新建表可能遗漏

**建议修复**:  
为每张表添加迁移文件，显式创建表、启用 RLS 并定义 policy。

---

### [P0] S-03: `audit_log` 表名与迁移不匹配 — 审计日志静默丢失

**文件**: `src/proxy.ts:59`

**问题描述**:  
Proxy 中间件写入 `audit_log`（单数），但迁移文件 `supabase/migrations/20260613000000_audit_logs.sql` 创建的是 `audit_logs`（复数）。写入操作将静默失败，导致所有通过代理的 API 请求不被记录，安全审计追踪链断裂。

```typescript
// proxy.ts:59 — 写入 audit_log（单数）
supabase.from("audit_log").insert({
```

```sql
-- 迁移创建的是 audit_logs（复数）
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
```

**建议修复**:  
将 `proxy.ts:59` 的 `"audit_log"` 改为 `"audit_logs"`。

---

### [P1] S-04: 无 Next.js 中间件层认证 — 新路由可能裸奔

**文件**: 项目根目录（无 `src/middleware.ts`）

**问题描述**:  
项目中不存在导出 `middleware` 函数的 `middleware.ts` 文件（`src/proxy.ts` 不导出 middleware 函数）。所有 API 路由依赖各自手动调用 `supabase.auth.getUser()` 进行认证。任何新增路由如果开发者遗忘添加认证检查，将完全暴露。当前发现以下端点确实缺少认证：

| 端点 | 文件 | 风险 |
|------|------|------|
| `/api/monitoring/report` | `src/app/api/monitoring/report/route.ts` | 接受任何人 POST 错误报告，可注入日志 |
| `/api/leads/meta-capi` | `src/app/api/leads/meta-capi/route.ts` | 见 S-01 |
| `/api/meta/oauth-callback` | `src/app/api/meta/oauth-callback/route.ts` | OAuth 回调，可接受（但无 state 参数验证） |
| `/api/health` | `src/app/api/health/route.ts` | 健康检查，可接受 |

**建议修复**:  
1. 添加 `src/middleware.ts`，对所有 `/api/*` 路由（排除 health/webhook/oauth）进行统一认证
2. `/api/monitoring/report` 添加认证或限制为同源请求

---

### [P1] S-05: 缺少 Content-Security-Policy 安全头

**文件**: `next.config.ts:6-23`

**问题描述**:  
`next.config.ts` 配置了 CORS、X-Frame-Options、X-Content-Type-Options 等安全头，但缺少 **Content-Security-Policy (CSP)** 头。没有 CSP，浏览器无法阻止 XSS 注入的内联脚本、外部资源加载等攻击。

**当前安全头清单**:
- ✅ Access-Control-Allow-Origin（限制为 app.newme.ae）
- ✅ X-Content-Type-Options: nosniff
- ✅ X-Frame-Options: DENY
- ✅ X-XSS-Protection: 1; mode=block
- ✅ Referrer-Policy: strict-origin-when-cross-origin
- ✅ Permissions-Policy: camera=(), microphone=(), geolocation=()
- ❌ Content-Security-Policy — **缺失**
- ❌ Strict-Transport-Security (HSTS) — **缺失**

**建议修复**:  
```typescript
{ key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; ..." },
{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
```

---

### [P1] S-06: 开发环境硬编码凭证

**文件**: `src/app/api/dev/setup/route.ts:17`

**问题描述**:  
开发设置路由中硬编码了开发账号密码 `dev123456`。虽然该路由在 `NODE_ENV !== "production"` 且 `NEXT_PUBLIC_DEV_MODE === "true"` 时才可访问，但：
1. 密码 `dev123456` 极度脆弱
2. 如果误配置 `NEXT_PUBLIC_DEV_MODE=true` 部署到生产环境，该端点直接暴露
3. 凭证在版本控制中永久留存

```typescript
const DEV_EMAIL = "dev@newme.ae";
const DEV_PASSWORD = "dev123456";  // ← 硬编码弱密码
```

**建议修复**:  
将密码移至环境变量 `DEV_SEED_PASSWORD`，生产环境永远不设置该变量。

---

### [P2] S-07: OAuth 回调缺少 state 参数验证 (CSRF)

**文件**: `src/app/api/meta/oauth-callback/route.ts:45-91`

**问题描述**:  
Meta OAuth 回调端点接收 `code` 参数后直接交换 token，未验证 OAuth `state` 参数。攻击者可构造 CSRF 攻击，诱导管理员授权攻击者的 Meta 应用。

**建议修复**:  
在发起 OAuth 流程时生成随机 `state` 并存入 cookie/session，回调时验证。

---

### [P2] S-08: service_role key 内联创建模式 — 10+ 处重复

**文件**: 多个路由文件（`meta-capi`, `oauth-callback`, `knx-design`, `generate-quote`, `quotations/generate`, `quotations/export`, `users/[id]/password`, `products/import` 等）

**问题描述**:  
每处使用 service_role key 的路由各自内联调用 `createClient(url, key)`，而非复用 `src/lib/supabase-admin.ts` 中的集中化 `createAdminClient()`。这种分散模式：
1. 增加了 service_role key 被意外导入客户端 bundle 的风险
2. 无法集中监控和审计 service_role 的使用
3. 配置不一致（部分设置了 `autoRefreshToken: false`，部分没有）

**已确认**: 无 `NEXT_PUBLIC_` 前缀泄露（`SUPABASE_SERVICE_ROLE_KEY` 始终使用 `process.env` 服务端访问）。

**建议修复**:  
统一使用 `@/lib/supabase-admin` 的 `createAdminClient()`，删除路由内的内联 `createClient` 调用。

---

## 二、性能审计

### [P1] P-01: 批量转移线索 N+1 查询 — 循环内多次 await

**文件**: `src/app/(dashboard)/leads/page.tsx:155-161`

**问题描述**:  
`bulkTransfer` 函数在循环中对每个选中的 lead 执行 **4 次数据库写入 + 3 次 `getUser()` 调用**（共 7 次 await）。对于批量选择 50 个 lead，将产生 **350 次串行网络请求**，每次约 50-100ms，总耗时可达 17-35 秒。

```typescript
for (const leadId of ids) {
  await supabase.from("leads").update(...).eq("id", leadId);       // 1次
  await supabase.from("transfer_history").insert(...);              // 1次
  await supabase.from("activities").insert(...);                    // 1次
  await supabase.from("business_events").insert(...);               // 1次
  // 内含 3× supabase.auth.getUser() → 额外 3 次网络调用
}
```

**建议修复**:  
1. 循环外调用一次 `getUser()` 缓存 user.id
2. 使用批量 `update` + `insert` (Supabase 支持数组批量插入)
3. 或封装为 PostgreSQL RPC 函数，单次调用完成

---

### [P1] P-02: Rebalance 端点 N+1 循环更新

**文件**: `src/app/api/dashboard/sales-load/rebalance/route.ts:110-114`

**问题描述**:  
线索再平衡逻辑在循环中逐条 `await` 更新 leads 表。如果 `transferable` 列表很大（如 200 条），将产生 200 次串行 UPDATE 请求。

```typescript
for (const update of updates) {
  await supabase
    .from("leads")
    .update({ assigned_to: update.assigned_to })
    .eq("id", update.id);
}
```

**建议修复**:  
使用 PostgreSQL RPC 或批量 upsert 一次完成所有更新。

---

### [P2] P-03: 20 处 `select("*")` 全列查询 — 潜在大字段传输

**文件**: 多个文件，典型位置：
- `src/app/(dashboard)/leads/page.tsx:177`
- `src/app/(dashboard)/leads/[id]/page.tsx:177,183,187`
- `src/app/(dashboard)/dashboard/page.tsx:130`
- `src/app/(dashboard)/pipeline/page.tsx:250`
- `src/app/(dashboard)/ads/page.tsx:66`
- `src/app/api/payments/route.ts:129`
- `src/app/api/notifications/route.ts:39`
- 等 20 处

**问题描述**:  
多个查询使用 `select("*")` 获取所有列，包括可能的大型 JSON 字段（如 `devices_json`, `event_data` 等）。尤其列表页面只需展示部分字段时，传输冗余数据增加网络延迟和内存消耗。

**建议修复**:  
替换为显式列名，如 `.select("id, customer_name, phone, stage, lead_status, assigned_to, updated_at")`。

---

### [P2] P-04: 缺失索引 — notifications, installment_plans, payments, quotations

**文件**: `supabase/migrations/`

**问题描述**:  
对比迁移中的索引定义和实际查询模式，以下高频查询列缺少索引：

| 表名 | 缺失索引列 | 查询位置 |
|------|-----------|---------|
| `notifications` | `(user_id, read)` | `api/notifications/route.ts:39` 同时按 user_id 和 read 筛选 |
| `installment_plans` | `(status, due_date)` | `api/cron/check-overdue-installments/route.ts` 查询逾期分期 |
| `payments` | `(lead_id)`, `(contract_id)` | `payments/route.ts:129` 按合同查询付款 |
| `quotations` | `(lead_id)` | `api/hermes/generate-quote/route.ts:161` 按线索查询报价 |
| `activities` | `(user_id)` | `api/activities/route.ts` 按用户查询活动 |
| `activity_logs` | `(user_id, date)` | `api/activity/daily-report/route.ts` 按用户日期查询 |
| `leads` | `(lead_status, assigned_to)` | 多处组合查询 |

**建议修复**:  
添加相应索引迁移：
```sql
CREATE INDEX idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX idx_installments_status_due ON installment_plans(status, due_date);
CREATE INDEX idx_payments_contract ON payments(contract_id);
CREATE INDEX idx_quotations_lead ON quotations(lead_id);
```

---

### [P2] P-05: 列表查询无分页 — 一次性加载 500 条

**文件**:
- `src/app/(dashboard)/leads/page.tsx:179` — `.limit(500)`
- `src/app/(dashboard)/pipeline/page.tsx:250` — `.limit(500)`
- `src/app/(dashboard)/ads/page.tsx:66` — `.limit(500)`

**问题描述**:  
多个列表页面使用 `.limit(500)` 一次性加载最多 500 条记录。当数据量增长后，这将传输大量数据到客户端，导致页面加载缓慢和内存压力。

**建议修复**:  
实现游标分页或偏移分页，每页 20-50 条，前端无限滚动或分页控件。

---

### [P2] P-06: `pipeline-funnel` 路由中 RPC 嵌套使用 — 非标准查询模式

**文件**: `src/app/api/dashboard/pipeline-funnel/route.ts:167`

**问题描述**:  
该行将 `.rpc()` 调用嵌套在 `.eq()` 过滤器中，这不是 Supabase JS 客户端的标准用法：

```typescript
eventsQuery = eventsQuery.eq("lead_id", supabase.rpc("get_user_leads_ids", { p_user_id: targetUserId }));
```

`.rpc()` 返回的是 Promise 而非标量值，将其直接传入 `.eq()` 不会产生预期的子查询过滤。这可能导致查询返回错误结果或全部数据。

**建议修复**:  
先 await RPC 获取 ID 列表，再使用 `.in("lead_id", ids)` 过滤。

---

## 三、代码质量审计

### [P2] Q-01: 大量 `any` 类型使用 — 50+ 处

**文件**: 遍布整个 `src/` 目录，典型文件：
- `src/app/(dashboard)/leads/page.tsx` — 5 处 `(u: any)`
- `src/app/(dashboard)/dashboard/page.tsx` — 12 处
- `src/app/(dashboard)/leads/[id]/page.tsx` — 4 处
- `src/app/api/leads/meta-capi/route.ts:179` — `catch (err: any)`
- `src/app/api/hermes/knx-design/status/route.ts:19,24,27,30` — `(global as any)`

**问题描述**:  
超过 50 处使用 `any` 类型，主要集中在：
1. catch 块的 `err: any` — 应使用 `unknown` 并进行类型守卫
2. 数据项的 `(item: any)` 类型标注 — 应定义接口类型
3. 全局变量 `(global as any).__hermesKnxTasks` — 应声明全局类型

**建议修复**:  
1. catch 块使用 `catch (err: unknown)` + `err instanceof Error` 守卫
2. 为数据模型定义 TypeScript 接口
3. 为全局变量声明 `declare global` 类型

---

### [P2] Q-02: 30+ 处 console.error/console.log 残留在生产代码中

**文件**: 多个组件和路由文件，典型位置：
- `src/app/(dashboard)/leads/page.tsx` — 13 处 `console.error`
- `src/app/api/leads/meta-capi/route.ts:146,163,180` — `console.error` 含错误详情
- `src/app/api/meta/oauth-callback/route.ts:34,36,52,71,80,86,103,113,124,127,148,157,161` — 大量 console 输出
- `src/app/(dashboard)/quotes/page.tsx:32` — `console.error` 在 server component

**问题描述**:  
1. **客户端组件**中的 `console.error` 会将错误详情暴露到浏览器控制台，可能泄露内部实现细节
2. **服务端路由**中的 `console.error` 可能输出包含敏感信息的错误对象
3. `oauth-callback/route.ts` 有条件地输出日志（`NODE_ENV !== "production"`），但大部分其他文件无条件输出

**注意**: 未发现 `console.log` 输出 service_role key 或密码等直接凭证泄露。

**建议修复**:  
1. 客户端组件：使用 toast/通知组件替代 console.error
2. 服务端路由：使用结构化日志库（如 pino）替代裸 console
3. 添加 ESLint 规则 `no-console` 在 CI 中拦截

---

### [P2] Q-03: 错误处理不一致 — 吞异常与不传播

**文件**: 多处，典型：
- `src/app/(dashboard)/leads/page.tsx:155-161` — `bulkTransfer` 循环中的 await 无 try-catch，单条失败不会中断后续但错误被静默吞掉
- `src/app/api/dashboard/sales-load/rebalance/route.ts:110-114` — 循环更新无错误检查，失败的更新不报告
- `src/app/(dashboard)/leads/page.tsx:262,360,410` — 写入 business_events/activities 的错误仅 console.error，不通知用户

**问题描述**:  
1. 客户端批量操作中，单条失败不中断也不提示用户，导致数据不一致
2. 副作用写入（business_events, activities）失败时静默忽略，可能导致活动日志缺失
3. 服务端路由部分使用 `console.error` 后返回泛化错误，部分直接抛出

**建议修复**:  
1. 批量操作收集失败项，操作完成后报告
2. 副作用写入失败时记录到监控系统
3. 统一错误处理中间件

---

### [P3] Q-04: 重复的 Supabase 客户端创建逻辑

**文件**: 
- `src/app/api/leads/meta-capi/route.ts:12-21`
- `src/app/api/meta/oauth-callback/route.ts:8-15`
- `src/app/api/hermes/knx-design/route.ts:38-45`
- `src/app/api/hermes/generate-quote/route.ts:35-42`
- `src/app/api/quotations/generate/route.ts:14-21`
- `src/app/api/quotations/export/route.ts:9-16`
- `src/app/api/hermes/knx-design/status/route.ts:33-46`

**问题描述**:  
7 处路由文件各自定义了 `getSupabaseAdmin()` 函数，逻辑几乎完全相同（读取 URL + service_role key + createClient）。同时 `src/lib/supabase-admin.ts` 已有集中化实现。这种重复：
1. 维护负担 — 需同步修改多处
2. 配置漂移 — 部分设置 `autoRefreshToken: false`，部分没有
3. 无法集中添加监控/日志

**建议修复**:  
删除路由内联函数，统一使用 `import { createAdminClient } from "@/lib/supabase-admin"`。

---

### [P3] Q-05: knx-design 任务状态使用内存存储 — 不可扩展

**文件**: `src/app/api/hermes/knx-design/status/route.ts:19-31`

**问题描述**:  
KNX 设计任务状态使用 `global.__hermesKnxTasks` (内存 Map) 存储。代码注释也承认 "in production use Redis/DB"。在 Serverless 环境（如 Vercel）中：
1. 每个函数实例有独立的内存空间，任务状态不可跨实例共享
2. 函数冷启动后内存重置，任务状态丢失
3. 无法水平扩展

**建议修复**:  
将任务状态持久化到数据库或 Redis。

---

## 四、正面发现

以下是审计中发现的良好实践，值得保持：

1. ✅ **Cron 端点认证完善** — 所有 `/api/cron/*` 路由均验证 `CRON_SECRET`，且在密钥未设置时拒绝请求（与 meta-capi 形成对比）
2. ✅ **绝大多数 API 路由有认证检查** — contracts, payments, quotations, notifications, workflow, kpi, dashboard 等所有路由均有 `getUser()` + 角色检查
3. ✅ **无 `@ts-ignore` / `@ts-nocheck`** — TypeScript 编译没有绕过
4. ✅ **RLS 广泛覆盖** — 31 处 `ENABLE ROW LEVEL SECURITY` 覆盖了主要业务表
5. ✅ **CORS 配置合理** — Origin 限制为 `app.newme.ae`，未使用通配符
6. ✅ **SQL 注入防护** — `.rpc()` 调用使用参数化传入，meta-capi 路由对 email/phone 做了输入消毒
7. ✅ **自动 RLS 保护迁移** — `20260613220000_rls_auto_protection.sql` 尝试自动为新表启用 RLS
8. ✅ **service_role key 未泄露到客户端** — 无 `NEXT_PUBLIC_` 前缀的 service_role 变量

---

## 五、修复优先级建议

### 立即修复 (P0)
1. **S-01**: meta-capi webhook 强制要求密钥 → 改 1 行代码
2. **S-03**: `audit_log` → `audit_logs` 表名修正 → 改 1 行代码
3. **S-02**: 确认 transfer_history/lead_files/knx_designs/meta_tokens 表的 RLS 状态

### 本周修复 (P1)
4. **S-04**: 添加 middleware.ts 统一认证层
5. **P-01**: bulkTransfer N+1 → 批量化 + 缓存 user.id
6. **P-02**: rebalance N+1 → 批量更新
7. **S-05**: 添加 CSP + HSTS 头
8. **S-06**: 开发凭证移至环境变量

### 下个迭代 (P2/P3)
9. 添加缺失索引
10. select("*") → 显式列名
11. 列表分页
12. 清理 any 类型
13. 统一 Supabase admin 客户端创建
14. 清理 console.error

---

*报告结束*
