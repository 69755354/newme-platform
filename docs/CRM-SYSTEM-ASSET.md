# NewMe CRM 系统资产文档

> **生成日期**: 2026-06-15 | **维护者**: Hermes Agent | **BUILD_ID**: QgTc3GDT6mTj1bwI7wnAR
> 这份文档是 CRM 系统的权威资产——架构、数据模型、RLS 全表、关键坑、审计结论。
> 每次重大变更后更新。不是一次性报告，是活文档。

---

## 1. 概览

| 项 | 值 |
|---|---|
| 技术栈 | Next.js 14 (App Router) + Supabase (Postgres + Auth) + TypeScript |
| UI | Tailwind + Radix UI / Base UI + lucide-react |
| 监控 | Sentry (`@sentry/nextjs`) + PostHog |
| 部署 | systemd unit `newme-platform.service`，`npm run start -- -p 3001`，`NODE_ENV=production` |
| 工作目录 | `/home/ubuntu/newme-platform` |
| 端口 | 3001（内部），经 nginx 反代到 `app.newme.ae` |
| 数据库 | Supabase project `vfopmpxlhwzpxqegayew`（ref），region 见 dashboard |
| 健康检查 | `GET /api/health` → `{status, version, checks:{database, supabase_api, memory, disk}}` |
| 当前状态 | ✅ active，database UP，supabase_api UP，内存 ~154MB |

**服务管理**:
```bash
sudo systemctl restart newme-platform.service   # NOPASSWD 已配置（ubuntu 用户）
sudo systemctl status newme-platform.service
curl -s http://localhost:3001/api/health | jq .
```

**迁移管理**: Supabase 迁移在 `supabase/migrations/`（37 个 SQL 文件）。
线上库通过 Supabase Management API 或 dashboard 部署，**不是** `supabase db push`（无本地 CLI 链路）。

---

## 2. 数据模型（27 张表）

### 核心业务流（线索 → 合同 → 回款）
- **leads** — 线索主表（客户姓名/电话/来源/阶段 lead_status/归属 assigned_to/质量 quality）
- **customers** — 客户实体（与 leads 一对一或独立）
- **lead_workflow_stages** — 线索阶段工作流（requirement/design/quotation/negotiation/handover，权重 20/30/50/60/80）
- **lead_assignment_state** — 线索轮转（round-robin 分配）状态机
- **transfer_history** — 线索转交历史记录
- **lead_files** — 线索附件（DWG/PDF 等，供 KNX 设计消费）*[2026-06-15 新建]*

### 报价与合同
- **quotations** — 报价单（含 devices_json 设备清单）
- **quotes** — 旧报价表（**遗留**，仅 admin 可见，逐步弃用）
- **contracts** — 合同主表（contract_no/sales_id/status）
- **contract_approvals** — 合同审批流（boss/finance 审批）
- **installment_plans** — 分期计划（seq/amount/due_date/status: pending/partial/paid/overdue）
- **payments** — 实际回款记录
- **payment_allocations** — 回款分配到分期

### 产品与设计
- **products** — 产品库（KNX 设备/SKU/价格）
- **knx_designs** — KNX 设计方案（关联 lead_files，异步生成）*[2026-06-15 新建]*

### 人员与绩效
- **profiles** — 用户档案（auth.users 一对一，含 role/is_active）
- **kpi_targets** — KPI 目标设定

### 协作与通知
- **notifications** — 站内信（type/user_id/read）
- **activities** — 销售活动/跟进记录（含 due_at 到期、type 类型）
- **business_events** — 业务事件流（lead_assigned/lead_stale_detected/lead_reassigned 等，供仪表盘）
- **chat_messages** — 站内消息
- **activity_logs** — 用户活动日志（登录/操作埋点）
- **user_session_daily** — 每日会话聚合（在线时长统计）

### 营销与外部集成
- **ad_spend** — 广告投放花费记录
- **marketing_campaigns** — 营销活动（**仅 1 条 policy，基本未启用**）
- **meta_tokens** — Meta(Facebook) OAuth token 存储（Ads 集成）

### 审计与安全
- **audit_logs** — 管理员操作审计日志（actor_id/action/details）*[2026-06-13 新建，2026-06-15 修 RLS]*

### 运维辅助表
- **projects** — 项目（交付阶段，关联 leads）

---

## 3. 认证与角色模型

### 角色集合（最终 CHECK 约束，来自 `20260605000000_newme_crm_v22_complete.sql`）
```
admin, boss, sales, designer, operator, finance
```

**默认值**: `sales`。

### 🔴 坑：角色命名历史分裂（务必注意）

这个系统经历过角色重命名，**旧的 `manager` 和新的 `boss` 在不同 migration 里混用**：

| Migration 时期 | 角色名 | 影响范围 |
|---|---|---|
| `20260601000000_init.sql` | `admin, manager, sales, designer` | 初版建表 + 初版 policy |
| `20260602010000_crm_mvp_final.sql` | `admin, manager` | MVP policy |
| `20260604000000_fix_lead_insert_rls.sql` 起 | 引入 `boss` | 后续所有新 policy |
| `20260605000000_v22_complete.sql` | `admin, boss, sales, designer, operator, finance` | **最终 CHECK 约束** |

**后果**：线上 DB 的 CHECK 只接受 `boss`，不接 `manager`。但 RLS policy 里**仍有 8 条引用 `manager`**（见下文 RLS 矩阵标注 `[⚠️含 manager]` 的行：leads/activities/business_events/chat_messages/customers/profiles/projects/quotes 各 1 条）。这些 policy 的 `manager` 分支**永远不命中**——靠它们授权的操作实际依赖同表的 `boss` 版 policy 兜底。功能没全坏是因为多数表有重复 policy，但这是定时炸弹：哪张表只有 `manager` policy 没有对应 `boss` policy，那操作就静默被拒。

**建议**: 统一所有 policy 为 `boss`，删除 `manager` 残留，或确认是否有历史账户 role 值仍为 `manager`（需查 DB）。

### 认证链路
1. Supabase Auth（JWT），前端 `@supabase/ssr` 管 session
2. 后端每个 API route 手动 `supabase.auth.getUser()` 校验（**无全局 middleware 统一拦截** — 见坑 C-02）
3. service_role 操作走 `src/lib/supabase-admin.ts` 的 `createAdminClient()`（绕过 RLS）

### 辅助函数
- **`get_my_role()`** — `SECURITY DEFINER`，查 `profiles.role WHERE id = auth.uid()`。SELECT policy 中做角色判断的推荐方式（JWT 里 role 恒为 `authenticated`，拿不到业务角色）。

---

## 4. RLS 全表矩阵

**总计**: 26 张受保护表 / 90 条 policy。所有 `public.*` 表已 `ENABLE ROW LEVEL SECURITY`。

**图例**: `FOR {SELECT|INSERT|UPDATE|DELETE|ALL}` | `U`=USING | `C`=WITH CHECK | `[⚠️]`=引用了已失效的 `manager` 角色

### 核心业务
**leads** (10 policy)
- `admin_all` ALL U `[⚠️含 manager]` ← 旧，可能失效
- `leads_admin_all` SELECT U `admin,boss,operator`
- `leads_admin_update` UPDATE U `admin,boss`
- `leads_delete_admin_boss` DELETE U `admin,boss`
- `leads_sales_insert` INSERT C `sales`
- `leads_sales_see` SELECT U (ownership: assigned_to=uid)
- `leads_sales_update` UPDATE UC (ownership)
- `sales_create_leads` INSERT UC `admin,boss`
- `sales_own_leads` SELECT U (ownership)
- `sales_update_own` UPDATE U (ownership)

**lead_workflow_stages** (4): `wf_admin_all` ALL `admin,boss,operator` / `wf_sales_insert` INSERT C / `wf_sales_select` SELECT / `wf_sales_update` UPDATE

**lead_files** (3) *[新建]*: `lead_files_admin_all` ALL / `lead_files_insert_staff` INSERT C / `lead_files_select_assigned` SELECT（ownership）

**transfer_history** (3): `transfer_admin_all` ALL / `transfer_sales_insert` INSERT C / `transfer_sales_select` SELECT

**lead_assignment_state**: 由 `assign_new_lead` RPC 管理（SECURITY DEFINER）

### 报价合同回款
**quotations** (4): `quotations_admin_all` ALL `admin,boss,operator` / `quotations_sales_insert` INSERT C `sales` / select/update ownership

**contracts** (3): `contracts_admin_all` ALL `admin,boss,operator` / `contracts_finance_select` `finance` / `contracts_sales_select` ownership

**contract_approvals** (2): `ca_admin_all` ALL / `ca_sales_select` SELECT

**installment_plans** (2): `ip_admin_all` ALL `admin,boss,finance,operator` / `ip_sales_select` SELECT

**payments** (2): `payments_admin_all` ALL `admin,boss,finance,operator` / `payments_sales_select` SELECT

**payment_allocations** (2): `pa_admin_all` ALL / `pa_sales_select` SELECT

### 产品设计
**products** (7): `products_admin_all` ALL UC `admin,boss` / `products_auth_all` ALL（所有认证用户读）/ insert/update/delete `admin,boss` / `products_sales_select` SELECT

**knx_designs** (2) *[新建]*: `knx_designs_admin_all` ALL / `knx_designs_select_assigned` SELECT

### 人员通知
**profiles** (4): `profile_self` SELECT `[⚠️含 manager]` / `profiles_admin_all` ALL `admin,boss` / `profiles_select` SELECT / `profiles_update_self` UPDATE UC

**notifications** (4): `notifications_admin_read_all` SELECT `admin,boss` / `notifications_service_insert` INSERT C（service_role）/ `notifications_user_read`+`notifications_user_update` ownership

**kpi_targets** (2): `kpi_admin_all` ALL UC `admin,boss` / `kpi_sales_read_own` SELECT

**activities** (8): `activities_admin_all` ALL `admin,boss,operator` / `activities_sales_insert` INSERT C `sales` / select/update ownership / `activity_admin` ALL `[⚠️含 manager]` / `activity_sales_create*` 多条

**business_events** (10): `be_admin_all` ALL `admin,boss` / `be_anon_*` 多条（INSERT/SELECT/UPDATE，无角色过滤=所有认证用户）/ `be_relevant_select` `finance,operator` / `business_events_admin_all` ALL `[⚠️含 manager]` / sales create/own

### 审计活动
**audit_logs** (2): `boss_admin_see_all_audit` SELECT `admin,boss`（用 `get_my_role()`）/ INSERT policy 用 `auth.uid()` equality *[2026-06-15 修复]*

**activity_logs** (2): `boss_admin_see_all_activity` SELECT `admin,boss` / `sales_see_own_activity` SELECT

**user_session_daily** (2): `boss_admin_see_all_sessions` SELECT / `sales_see_own_sessions` SELECT

### 营销集成
**ad_spend** (2): `boss_admin_insert/read_ad_spend` `admin,boss`

**meta_tokens** (1): `meta_tokens_admin` ALL（admin）

**marketing_campaigns** (1): `mc_admin_all` ALL（基本未用）

### 遗留
**customers** (4): 含 `customer_admin` ALL `[⚠️含 manager]` + 新 `customers_admin_all` `admin,boss,operator`

**projects** (4): `project_admin` ALL `[⚠️含 manager]` + 新 `projects_admin_operator_all` `admin,boss,operator`

**quotes** (1): `quote_admin` ALL `[⚠️含 manager]`（遗留表）

**chat_messages** (1): `chat_access` SELECT `[⚠️含 manager]` ← **可能完全失效**

---

## 5. 关键坑（Pitfalls）— 排雷清单

### 🔴 C-01: RLS `auth.jwt() ->> 'role'` 在 INSERT WITH CHECK 中失效
**症状**: 用 `auth.jwt() ->> 'role'` 做 INSERT 的 WITH CHECK 判断，逻辑正确但写入被拒。
**根因**: 此 Supabase 实例的 JWT 里 `role` 字段在 RLS WITH CHECK 评估时取不到预期值（SELECT/USING 阶段能取到，WITH CHECK 阶段取不到）。
**验证**: `auth.uid()` 在 WITH CHECK 做等值判断**可靠**（lead_files INSERT 实测 201 通过）；`auth.role()` 在 WITH CHECK **返回 NULL**。
**规则**:
- INSERT/UPDATE 的 WITH CHECK → 用 `auth.uid()` 等值判断，或 service_role 写
- SELECT 的 USING → 用 `get_my_role()`（查 profiles 表）做角色判断
- **永远不要**在 WITH CHECK 里用 `auth.role()` 或 `auth.jwt() ->> 'role'`
**证据**: `supabase/migrations/20260613000000_audit_logs.sql` 顶部注释（2026-06-15 验证记录）

### 🔴 C-02: 无 Next.js middleware 统一认证层
**现状**: 所有 API route 各自手动 `getUser()`。新增路由若开发者遗忘 = 裸奔。
**已知裸奔端点**: `/api/monitoring/report`（接受任意 POST 错误报告）
**建议**: 加 `src/middleware.ts` 对 `/api/*` 统一鉴权（白名单 health/webhook/oauth）

### 🟠 C-03: `manager` 角色 policy 失效（见第 3 节）
8 条 policy 引用 `manager`（leads/activities/business_events/chat_messages/customers/profiles/projects/quotes 各 1 条），但 DB CHECK 只认 `boss`。其中 `chat_messages`、`quotes` 只有 manager policy 无 boss 兜底，**这两个表的权限实际可能完全失效**。其余 6 张表有 boss 版 policy 兜底，功能未坏但冗余。

### 🟠 C-04: service_role key 分散创建（10+ 处内联）
多个 route 各自 `createClient(url, key)` 而非复用 `@/lib/supabase-admin`。增加 key 泄露风险 + 无法集中审计。已确认无 `NEXT_PUBLIC_` 前缀泄露。

### 🟠 C-05: 表名单复数历史不一致
`audit_log`（旧代码）vs `audit_logs`（迁移）。已修 `proxy.ts`。**教训**: 新表命名一律复数，加迁移时全局 grep 旧代码引用。

### 🟡 C-06: KNX 设计任务状态用内存存储
`global.__hermesKnxTasks`（Map），serverless/多实例下状态不共享、冷启动丢失。需迁到 DB/Redis。

### 🟡 C-07: 列表查询无分页（`.limit(500)`）
leads/pipeline/ads 列表一次性加载 500 条，数据量大后慢。需游标分页。

### 🟡 C-08: N+1 查询
`bulkTransfer`（每 lead 7 次 await）、`rebalance`（逐条 UPDATE）。50 条线索 = 350 次请求。需批量化或 RPC。

### 🟡 C-09: 缺失索引
notifications(user_id,read) / installment_plans(status,due_date) / payments(contract_id) / quotations(lead_id) / activities(user_id) / activity_logs(user_id,date) / leads(lead_status,assigned_to)

### 🟡 C-10: 开发凭证硬编码
`src/app/api/dev/setup/route.ts` 密码 `dev123456`。误配置 `NEXT_PUBLIC_DEV_MODE=true` 到生产即暴露。

---

## 6. 审计结论与修复状态

### Round 5 安全审计（2026-06-15，19 个发现）
**安全 P0 (3)** — 全部已修复 ✅
- S-01 Meta CAPI webhook 密钥可绕过 → ✅ 已修（`if (!webhookSecret) return 503`，已核实）
- S-02 4 张表缺 RLS（transfer_history/lead_files/knx_designs/meta_tokens）→ ✅ 已建迁移并部署
- S-03 audit_log 表名不匹配 → ✅ 已修（proxy.ts 改 `audit_logs`，已核实）

**安全 P1 (3)** — 待修
- S-04 无 middleware 统一认证（→ 坑 C-02）
- S-05 缺 CSP/HSTS 头
- S-06 开发凭证硬编码（→ 坑 C-10）

**安全 P2 (2)** — 待修: S-07 OAuth state 验证 / S-08 service_role 分散（→ 坑 C-04）

**性能 (6)**: P-01~P-06（N+1、select(*)、缺索引、无分页、RPC 嵌套误用）— 待修
**代码质量 (5)**: Q-01~Q-05（any 滥用、console 残留、错误吞、客户端重复、内存存储）— 待修

完整报告: `docs/crm-audit-round5-20260615.md`

### 6/14 线索轮转修复（8 类 Bug，已上线 ✅）
1. notifications.message → `body`
2. activities.activity_type → `type`
3. activities.scheduled_at → `due_at`
4. business_events 结构 `(entity_type,...)` → `(lead_id,user_id,event_type,event_data)`
5. RPC `assign_new_lead` 补 `next_action`/`next_followup_date` 参数
6. CHECK 默认值修正（quality `warm`→`pending`、source `manual`→`other`）
7. 事件类型约束补 `lead_assigned`/`lead_stale_detected`/`lead_reassigned`
8. 前端绕过 RPC 直插 → 改用 `assign_new_lead` RPC

完整报告: `docs/crm-audit-20260614.md`

### 修复优先级
- **本周**: C-02(middleware) / C-03(manager→boss 统一) / CSP+HSTS / C-10(开发凭证)
- **下迭代**: N+1 批量化 / 缺失索引 / 分页 / service_role 集中化 / any 清理

---

## 7. 运维

### Cron endpoints（`/api/cron/*`，均校验 `CRON_SECRET` header）
| 路径 | 功能 | 触发方 |
|---|---|---|
| `check-overdue-installments` | 标记逾期分期 + 通知 | Hermes cron（迪拜 09:02）|
| `check-overdue-followups` | 跟进逾期检查（**遗留，有 check-alerts 去重版，勿重复调**）| — |
| `check-alerts` | 告警检查（每小时，24h 去重）| Hermes cron |
| `cleanup-notifications` | 清理 90 天前通知 | Hermes cron |

**注意**: `~/.hermes/scripts/crm-daily-reminders.py` 曾因 token 占位符 bug 从未成功执行，已记录。触发器本身（overdue/cleanup）逻辑正常。

### 部署流程
```bash
cd /home/ubuntu/newme-platform
git pull
npm run build
sudo systemctl restart newme-platform.service
# 验证
curl -s http://localhost:3001/api/health | jq '.version,.checks'
```
DB 迁移走 Supabase Management API（需 SUPABASE_PROJECT_REF + service_role key）。

### 健康信号
- `/api/health` 四项 checks 全 UP
- Sentry 错误流
- PostHog 用户行为

---

*文档结束。变更本文件后请在 git commit message 注明「asset-doc update」。*
