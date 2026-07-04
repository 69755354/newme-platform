# P3 销售运营闭环 — 开发计划

> **生成时间**: 2026-07-04 23:45  
> **基于**: 完整代码审计 + 数据库 schema 审计 + API 审计  
> **前置**: PRD-sales-ops-p3.md（业务需求）

---

## 0、架构现状摘要（与 SPEC.md §六.A 同步）

**P3 起步前必须遵守的 BFF/Client Supabase 规则（详见 SPEC.md §六.A）：**

### Read Side — 已落地，不得回退

| 页面 | 当前 BFF API | 状态 |
|------|-------------|------|
| `/dashboard` | `/api/dashboard/summary` | ✅ P1-C |
| `/leads` | `/api/leads/list` | ✅ P1-D |
| `/analytics` | `/api/analytics/summary` | ✅ P1-E |
| `/workbench` | `/api/workbench` | ✅ P1-F |
| `/pipeline` `/contracts` `/settings` `/tasks` `/team` `/payments` | 各页 BFF API | ✅ P2 reads |

**铁律**：P3 dashboard/leads/analytics 工作不得在页面层重新引入 Supabase read client。

### Write Side — 已批准的低频直写可保留

| 页面 | 当前实现 | 状态 |
|------|---------|------|
| `/team` `/payments` `/tasks` `/pipeline` `/contracts` `/settings` | server actions (`src/app/actions/*.ts`) | ✅ P2 mutations |
| follow_up_logs / quality 等低频表单 | client Supabase 可保留 | ⚠️ 需 RLS 覆盖 |

### Performance Baseline 不可动

- **`/products`** — P1-B 移除 client Supabase 后成为 baseline，**未经 SAM 明确批准不得改动**（初始 bundle 收益 -224KB）

### 执行顺序（修订版，task_P3_0_spec_sync 已 DONE）

0. ✅ `task_P3_0_spec_sync` — 同步 SPEC.md + DEV-PLAN.md（本文档）
1. `task_P3_1b_alertpanel` — AlertPanel 默认收起
2. `task_P3_1_won_at` — leads.won_at 字段 + trigger
3. `task_P3_2_first_contact_trigger` — follow_up_logs → lead_milestones.first_contact
4. `task_P3_5_dashboard_summary_api` — 改造 /api/dashboard/summary
5. `task_P3_6_dashboard_month_filter` — Dashboard 月份筛选 UI
6. `task_P3_3_quality_api` — POST /api/leads/[id]/quality
7. `task_P3_7_leads_contact_quality_ui` — Leads 详情页 UI
8. `task_P3_8_weekly_review` — WeeklyReview 组件
9. `task_P3_4_deprecate_redirect` — /command-center + /quotations 废弃
10. `task_P3_9_smoke_acceptance` — Smoke + 验收矩阵

---

## 一、当前事实结论（已从代码/schema确认）

### 数据库现状

**leads 表：**
- ✅ `quality` (pending/poor/normal/good) — `supabase/migrations/20260601000000_init.sql:43`
- ✅ `poor_reason` — `supabase/migrations/20260701000011_add_missing_columns_and_fks.sql:5`
- ✅ `stage` — `supabase/migrations/20260601000000_init.sql:44`
- ✅ `stage_changed_at` — `supabase/migrations/20260602000000_crm_v2_columns.sql`
- ✅ `assigned_to` — `supabase/migrations/20260601000000_init.sql:62`
- ✅ `created_at` — `supabase/migrations/20260601000000_init.sql:68`
- ❌ `won_at` — **不存在**（PRD §五.2 要求）
- ✅ `lost_at` — `supabase/migrations/20260601000000_init.sql:66`
- ✅ `final_status` (won/lost) — `supabase/migrations/20260602000000_crm_v2_columns.sql`

**follow_up_logs 表：**
- ✅ `lead_id` — `supabase/migrations/20260623000000_crm_v3_stage_to_milestone_mapping.sql`（推断）
- ✅ `contact_type` — `supabase/migrations/20260701000011_add_missing_columns_and_fks.sql`
- ⚠️ `summary` (不是 notes) — **字段名不一致**（PRD 写 notes，实际是 summary）
- ✅ `created_by` — `supabase/migrations/20260701000011_add_missing_columns_and_fks.sql:2`
- ✅ `created_at` — 推断存在
- ✅ `next_action` — 存在（触发自动建任务）

**lead_milestones 表：**
- ✅ 表存在 — `supabase/migrations/20260624000001_fix_milestone_order.sql`
- ✅ `milestone_key` 字段（如 first_contact）— `src/lib/milestones.ts:3`
- ✅ RLS 7 policies — `supabase/migrations/20260701000000_non_core_tables_rls_fix.sql:243-280`
- ⚠️ CREATE TABLE 语句在代码中找不到（可能在其他 migration 或手动创建）

**business_events 表：**
- ✅ 表存在（两个 DDL 版本）— `supabase/migrations/20260602010000_crm_mvp_final.sql:7`, `supabase/migrations/20260603000000_add_crm_fields.sql:57`
- ✅ `event_type` — 两个版本都有
- ✅ `event_data` (JSONB) — 两个版本都有
- ✅ `lead_id` — 两个版本都有
- ⚠️ `created_by` / `user_id` — 两个版本字段名不同（crm_mvp_final 用 user_id，add_crm_fields 用 created_by）
- ✅ `created_at` — 两个版本都有

**contracts 表：**
- ✅ `contract_amount` — `supabase/migrations/20260605000000_newme_crm_v22_complete.sql:81`
- ✅ `created_at` — 推断存在
- ✅ `status` — `supabase/migrations/20260605000000_newme_crm_v22_complete.sql:81`
- ✅ `lead_id` — `supabase/migrations/20260605000000_newme_crm_v22_complete.sql:81`

**payments 表：**
- ✅ `payment_date` — `supabase/migrations/20260605000000_newme_crm_v22_complete.sql:145`
- ✅ `amount` — `supabase/migrations/20260605000000_newme_crm_v22_complete.sql:145`
- ✅ `contract_id` — `supabase/migrations/20260605000000_newme_crm_v22_complete.sql:145`

**kpi_targets 表：**
- ✅ `period` 字段 — `src/app/api/dashboard/summary/route.ts:82`

**tasks 表：**
- ✅ 自动 trigger 从 follow_up_logs.next_action 创建 — `supabase/migrations/20260623000000_crm_v3_stage_to_milestone_mapping.sql`（推断）

### API 现状

- ✅ `/api/leads/[id]/follow-up` — `src/app/api/leads/[id]/follow-up/route.ts`
- ❌ update quality API — **不存在**
- ✅ `/api/dashboard/summary` 的 period 参数 — 只用于 kpi_targets（`src/app/api/dashboard/summary/route.ts:81-82`）
- ✅ `/api/leads/list` — 不按 period 过滤（`src/app/api/leads/list/route.ts:42-47`）

### 页面现状

- `/dashboard` — 需要检查月份状态
- `/leads/[id]` — 需要检查 quality 区域
- `/command-center` — 在侧栏，需要废弃
- `/quotations` — 不在侧栏，已经是孤儿页面

### RLS 现状

- ✅ lead_milestones 有 7 个 RLS policies — 配置完善
- ⚠️ trigger 是否需要 SECURITY DEFINER — 未确认

### 测试/部署现状

- ✅ 有 e2e 测试 (playwright) — `e2e/` 目录
- ✅ 有 deploy.sh, check-smoke.sh 等脚本 — `scripts/` 目录
- ✅ 工作树干净 — 只有 2 个未跟踪文件

---

## 二、P0 阻塞项（会导致不能开工或上线事故）

### P0-1: won_at 字段缺失 — ✅ 已裁决（方案 B）
- **问题**: leads 表没有 won_at 字段
- **裁决**: GPT 5.5 选方案 B — 加 migration 添加 won_at 字段 + backfill
- **规则**:
  - 新增 won_at timestamptz nullable
  - 当 final_status 从非 won → won 时写入 won_at
  - 已 won 再编辑不覆盖 won_at
  - 历史 backfill: final_status='won' AND won_at IS NULL → won_at = updated_at
- **验证**: PRD §5.2.4 已更新

### P0-2: follow_up_logs 字段名 — ✅ 已裁决
- **问题**: PRD 写 notes，实际字段是 summary
- **裁决**: 统一用 summary，UI 显示 Notes，落库写 summary
- **验证**: PRD 需 patch（待执行）

### P0-3: lead_milestones 表 — ✅ 已确认存在
- **结论**: 线上表存在，代码 7 处读写，RLS 7 policies，trigger check_milestone_order 存在
- **证据**:
  - `src/app/api/command-center/route.ts:78` — .from('lead_milestones')
  - `src/app/api/leads/[id]/milestone/route.ts:52,81` — 读写里程碑
  - `src/app/api/leads/[id]/timeline/route.ts:50` — 查询里程碑
  - `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts:400,414` — 前端写入
  - `src/app/(dashboard)/quotes/quotes-client.tsx:285` — 报价关联
  - `supabase/migrations/20260701000000_non_core_tables_rls_fix.sql:243-280` — 7 个 RLS policies
  - `supabase/migrations/20260624000001_fix_milestone_order.sql` — BEFORE INSERT trigger (SECURITY DEFINER)
- **CREATE TABLE 缺失**: 所有 67 个 migration 文件无 CREATE TABLE lead_milestones — 推断为 Supabase Dashboard 手动创建
- **影响**: 不影响 P3 开发，但建议补 baseline migration 对齐
- **P3 行动**: 不补 CREATE TABLE（避免冲突），只加 trg_auto_first_contact trigger

---

## 三、P1 必须先修项（会导致统计失真、权限错误）

### P1-1: business_events 表两个 DDL 版本冲突
- **问题**: 
  - `20260602010000_crm_mvp_final.sql` 用 user_id 字段
  - `20260603000000_add_crm_fields.sql` 用 created_by 字段
- **影响**: 插入 business_events 时字段名不一致
- **解决方案**: 
  1. 检查实际表结构（用 psql 或 supabase db dump）
  2. 统一用一个字段名
  3. 如有必要，添加 migration 统一字段
- **验证**: `supabase db dump --schema public | grep -A 10 'CREATE TABLE business_events'`

### P1-2: trigger 是否需要 SECURITY DEFINER
- **问题**: lead_milestones 有 RLS，但 trigger 写入可能被 RLS 阻断
- **影响**: first_contact trigger 可能失败
- **解决方案**: 
  1. 检查现有 trigger 是否有 SECURITY DEFINER
  2. 如果没有，添加 SECURITY DEFINER
- **验证**: `grep -rn 'SECURITY DEFINER' supabase/migrations/ | grep -i milestone`

### P1-3: update quality API 缺失
- **问题**: 没有专门的 API 更新 quality + 写 business_events
- **影响**: 无法实现"销售必须选 quality"的强制逻辑
- **解决方案**: 新增 `/api/leads/[id]/quality` API
- **验证**: `find src/app/api/leads -name '*quality*'`

---

## 四、P3 实施拆分（最小可部署单元）

### Task 1: DB Migration — won_at 字段 + stage 变更 trigger
**文件**: `supabase/migrations/20260706_add_won_at_field.sql`

**实现步骤**:
1. 创建 migration 文件：
   ```sql
   -- 1. 添加 won_at 字段
   ALTER TABLE leads ADD COLUMN IF NOT EXISTS won_at TIMESTAMPTZ;
   
   -- 2. 历史 backfill（只处理 won 但 won_at 为空的）
   UPDATE leads 
   SET won_at = updated_at 
   WHERE final_status = 'won' AND won_at IS NULL;
   
   -- 3. Stage 变更 trigger：final_status 从非 won → won 时写入 won_at
   CREATE OR REPLACE FUNCTION trg_set_won_at()
   RETURNS trigger AS $$
   BEGIN
     -- 只有从非 won 变为 won 时才写入
     IF NEW.final_status = 'won' AND (OLD.final_status IS DISTINCT FROM 'won' OR OLD.won_at IS NULL) THEN
       NEW.won_at := NOW();
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql;
   
   CREATE TRIGGER trg_leads_set_won_at
   BEFORE UPDATE ON leads
   FOR EACH ROW
   WHEN (NEW.final_status = 'won')
   EXECUTE FUNCTION trg_set_won_at();
   ```

2. 推送 migration：
   ```bash
   cd /home/ubuntu/newme-platform
   npx supabase db push
   ```

3. 验证：
   ```sql
   -- 检查字段存在
   SELECT column_name FROM information_schema.columns 
   WHERE table_name = 'leads' AND column_name = 'won_at';
   -- 应返回 1 行
   
   -- 检查 backfill
   SELECT COUNT(*) FROM leads 
   WHERE final_status = 'won' AND won_at IS NULL;
   -- 应返回 0
   
   -- 检查 trigger 存在
   SELECT tgname FROM pg_trigger 
   WHERE tgname = 'trg_leads_set_won_at';
   -- 应返回 1 行
   ```

4. 测试 trigger：
   ```sql
   -- 创建一个测试 lead
   INSERT INTO leads (customer_name, assigned_to) 
   VALUES ('Test Lead', (SELECT id FROM profiles LIMIT 1));
   
   -- 更新为 won
   UPDATE leads SET final_status = 'won' 
   WHERE customer_name = 'Test Lead';
   
   -- 检查 won_at 是否自动填入
   SELECT won_at FROM leads WHERE customer_name = 'Test Lead';
   -- 应返回当前时间（非 NULL）
   
   -- 清理
   DELETE FROM leads WHERE customer_name = 'Test Lead';
   ```

**依赖**: 无
**风险**: 低
**验收**: 
- `supabase db push` 成功
- `SELECT column_name FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'won_at'` 返回 1 行
- trigger 测试通过
**审计**: 不需要

### Task 2: DB Migration — first_contact trigger
**文件**: `supabase/migrations/20260706_auto_first_contact_trigger.sql`

**实现步骤**:
1. 创建 migration 文件：
   ```sql
   -- first_contact 自动派生 trigger
   -- 当 follow_up_logs 插入时，自动在 lead_milestones 中创建 first_contact
   
   CREATE OR REPLACE FUNCTION trg_auto_first_contact()
   RETURNS trigger AS $$
   BEGIN
     INSERT INTO lead_milestones (lead_id, milestone_key, completed_at, completed_by, source)
     VALUES (NEW.lead_id, 'first_contact', NEW.created_at, COALESCE(NEW.created_by, NEW.user_id), 'follow_up_log')
     ON CONFLICT (lead_id, milestone_key) DO NOTHING;
     
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql SECURITY DEFINER;
   
   -- 删除旧 trigger（如果存在）
   DROP TRIGGER IF EXISTS trg_after_followup_insert ON follow_up_logs;
   
   CREATE TRIGGER trg_after_followup_insert
   AFTER INSERT ON follow_up_logs
   FOR EACH ROW EXECUTE FUNCTION trg_auto_first_contact();
   ```

   **关键点**:
   - `SECURITY DEFINER` — trigger 以函数 owner 身份执行，绕过 RLS
   - `ON CONFLICT DO NOTHING` — 重复插入不报错
   - `source = 'follow_up_log'` — 标记来源，区别于手动勾选
   - `COALESCE(NEW.created_by, NEW.user_id)` — 兼容两种字段名

2. 推送 migration：
   ```bash
   npx supabase db push
   ```

3. 验证：
   ```sql
   -- 检查 trigger 存在
   SELECT tgname, tgisinternal FROM pg_trigger 
   WHERE tgname = 'trg_after_followup_insert';
   -- 应返回 1 行，tgisinternal = false
   
   -- 检查函数有 SECURITY DEFINER
   SELECT proname, prosecdef FROM pg_proc 
   WHERE proname = 'trg_auto_first_contact';
   -- 应返回 prosecdef = true
   ```

4. 功能测试：
   ```sql
   -- 创建测试 lead（无 follow_up_logs）
   INSERT INTO leads (customer_name, assigned_to) 
   VALUES ('Test FC Lead', (SELECT id FROM profiles LIMIT 1))
   RETURNING id; -- 记下 lead_id
   
   -- 检查 lead_milestones 无 first_contact
   SELECT * FROM lead_milestones 
   WHERE lead_id = '<lead_id>' AND milestone_key = 'first_contact';
   -- 应返回 0 行
   
   -- 插入一条 follow_up_logs
   INSERT INTO follow_up_logs (lead_id, contact_type, summary, created_by)
   VALUES ('<lead_id>', 'phone', 'Test contact', (SELECT id FROM profiles LIMIT 1));
   
   -- 再次检查 lead_milestones
   SELECT * FROM lead_milestones 
   WHERE lead_id = '<lead_id>' AND milestone_key = 'first_contact';
   -- 应返回 1 行，source = 'follow_up_log'
   
   -- 清理
   DELETE FROM follow_up_logs WHERE lead_id = '<lead_id>';
   DELETE FROM lead_milestones WHERE lead_id = '<lead_id>';
   DELETE FROM leads WHERE id = '<lead_id>';
   ```

**依赖**: Task 1（无硬依赖，但建议先完成）
**风险**: 中（trigger 可能被 RLS 阻断，但 SECURITY DEFINER 已缓解）
**验收**: 
- trigger 存在且 prosecdef = true
- 插入 follow_up_logs 后 lead_milestones 自动创建 first_contact
- source = 'follow_up_log'
**审计**: 需要（检查 SECURITY DEFINER 和 RLS 配置）

### Task 3: API — 更新 quality + 写 business_events
**文件**: `src/app/api/leads/[id]/quality/route.ts`

**实现步骤**:

1. 创建 API 文件：
   ```typescript
   import { createServerClient } from '@/lib/supabase/server'
   import { NextResponse } from 'next/server'
   import { z } from 'zod'
   
   const qualitySchema = z.object({
     quality: z.enum(['poor', 'normal', 'good']),
     poor_reason: z.string().optional()
   })
   
   export async function POST(
     req: Request,
     { params }: { params: { id: string } }
   ) {
     const supabase = createServerClient()
     const { data: { user } } = await supabase.auth.getUser()
     if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
     
     const body = await req.json()
     const parse = qualitySchema.safeParse(body)
     if (!parse.success) {
       return NextResponse.json({ error: parse.error.message }, { status: 400 })
     }
     
     const { quality, poor_reason } = parse.data
     
     // 校验：poor 必须带 poor_reason
     if (quality === 'poor' && !poor_reason) {
       return NextResponse.json(
         { error: 'poor_reason is required when quality is poor' },
         { status: 400 }
       )
     }
     
     // 1. 获取当前 lead（检查权限 + 获取旧 quality）
     const { data: lead, error: fetchErr } = await supabase
       .from('leads')
       .select('id, quality, assigned_to')
       .eq('id', params.id)
       .single()
     
     if (fetchErr || !lead) {
       return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
     }
     
     // 权限检查：销售只能改自己的
     const { data: profile } = await supabase
       .from('profiles')
       .select('role')
       .eq('id', user.id)
       .single()
     
     if (profile?.role === 'sales' && lead.assigned_to !== user.id) {
       return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
     }
     
     const oldQuality = lead.quality
     
     // 2. 更新 leads.quality
     const { error: updateErr } = await supabase
       .from('leads')
       .update({ 
         quality, 
         poor_reason: quality === 'poor' ? poor_reason : null 
       })
       .eq('id', params.id)
     
     if (updateErr) {
       return NextResponse.json({ error: updateErr.message }, { status: 500 })
     }
     
     // 3. 如果从 pending 变为 poor/normal/good，写 business_events
     let businessEventId: string | null = null
     if (oldQuality === 'pending' && quality !== 'pending') {
       const { data: event, error: eventErr } = await supabase
         .from('business_events')
         .insert({
           lead_id: params.id,
           event_type: 'quality_checked',
           event_data: {
             from: 'pending',
             to: quality,
             ui_label: quality === 'good' ? 'High' : quality === 'normal' ? 'Normal' : 'Poor',
             poor_reason: poor_reason || null,
             source: 'lead_detail_quality_check'
           },
           user_id: user.id  // business_events 表用 user_id（不是 created_by）
         })
         .select('id')
         .single()
       
       if (!eventErr && event) {
         businessEventId = event.id
       }
     }
     
     return NextResponse.json({
       success: true,
       quality,
       business_event_id: businessEventId
     })
   }
   ```

2. 权限验证：
   - 销售只能改自己分配的 leads
   - Admin/Manager 可以改所有
   - RLS 会自动过滤（`leads` 表有 RLS policy）

3. 测试：
   ```bash
   # 用 curl 测试（替换 token 和 lead_id）
   curl -X POST http://localhost:3000/api/leads/<lead_id>/quality \
     -H 'Content-Type: application/json' \
     -H 'Cookie: sb-auth-token=<token>' \
     -d '{"quality": "normal"}'
   
   # 验证返回
   # {"success": true, "quality": "normal", "business_event_id": "..."}
   
   # 检查数据库
   # SELECT quality FROM leads WHERE id = '<lead_id>';
   # SELECT * FROM business_events WHERE lead_id = '<lead_id>' AND event_type = 'quality_checked';
   ```

**依赖**: Task 1-2（无硬依赖，但建议按顺序）
**风险**: 低
**验收**: 
- POST 请求返回 `{ success: true, quality, business_event_id }`
- leads.quality 更新正确
- business_events 创建（仅当 pending → poor/normal/good）
- 销售无法改别人的 leads（403）
**审计**: 需要（检查权限和 RLS）

### Task 4: API — 修改 /api/dashboard/summary
**文件**: `src/app/api/dashboard/summary/route.ts`

**实现步骤**:

1. **当前问题**：API 只接受 period 参数用于 kpi_targets，不过滤其他数据

2. **新增返回字段**：
   ```typescript
   {
     leads: {...},           // 不过滤（pipeline 快照）
     periodLeads: {...},     // 按 created_at 过滤
     stageChanges: [...],    // 按 business_events.created_at 过滤
     finance: {...}          // 按 contracts.created_at + payments.payment_date 过滤
   }
   ```

3. **修改逻辑**：
   ```typescript
   export async function GET(req: Request) {
     const { searchParams } = new URL(req.url)
     const period = searchParams.get('period') // "2026-07" 格式
     
     // 计算 period_start 和 period_end
     let periodStart: string | null = null
     let periodEnd: string | null = null
     if (period) {
       const [year, month] = period.split('-').map(Number)
       periodStart = new Date(year, month - 1, 1).toISOString()
       periodEnd = new Date(year, month, 0, 23, 59, 59).toISOString()
     }
     
     const supabase = createServerClient()
     
     // 1. periodLeads — 本月新增 leads
     let periodLeadsQuery = supabase
       .from('leads')
       .select('id, quality, source, created_at')
     
     if (periodStart && periodEnd) {
       periodLeadsQuery = periodLeadsQuery
         .gte('created_at', periodStart)
         .lte('created_at', periodEnd)
     }
     
     const { data: periodLeads } = await periodLeadsQuery
     
     // 2. stageChanges — 本月 stage 变更（从 business_events）
     let stageChangesQuery = supabase
       .from('business_events')
       .select('lead_id, event_data, created_at')
       .eq('event_type', 'stage_changed')
     
     if (periodStart && periodEnd) {
       stageChangesQuery = stageChangesQuery
         .gte('created_at', periodStart)
         .lte('created_at', periodEnd)
     }
     
     const { data: stageChanges } = await stageChangesQuery
     
     // 3. finance — 签约额 + 回款额
     let contractsQuery = supabase
       .from('contracts')
       .select('id, contract_amount, created_at')
     
     let paymentsQuery = supabase
       .from('payments')
       .select('id, amount, payment_date')
     
     if (periodStart && periodEnd) {
       contractsQuery = contractsQuery
         .gte('created_at', periodStart)
         .lte('created_at', periodEnd)
       
       paymentsQuery = paymentsQuery
         .gte('payment_date', periodStart)
         .lte('payment_date', periodEnd)
     }
     
     const [{ data: contracts }, { data: payments }] = await Promise.all([
       contractsQuery,
       paymentsQuery
     ])
     
     const contractAmount = contracts?.reduce((sum, c) => sum + (c.contract_amount || 0), 0) || 0
     const paymentAmount = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0
     
     // 4. wonLeads — 本月成交（用 won_at）
     let wonLeadsQuery = supabase
       .from('leads')
       .select('id')
       .eq('final_status', 'won')
     
     if (periodStart && periodEnd) {
       wonLeadsQuery = wonLeadsQuery
         .gte('won_at', periodStart)
         .lte('won_at', periodEnd)
     }
     
     const { data: wonLeads } = await wonLeadsQuery
     
     return NextResponse.json({
       leads: {...},  // 现有逻辑不变
       periodLeads: {
         count: periodLeads?.length || 0,
         byQuality: groupBy(periodLeads, 'quality'),
         bySource: groupBy(periodLeads, 'source')
       },
       stageChanges: stageChanges || [],
       finance: {
         contractAmount,
         paymentAmount,
         wonCount: wonLeads?.length || 0
       },
       kpiTargets: {...}  // 现有逻辑不变
     })
   }
   ```

4. **验证**：
   ```bash
   # 不带 period（全量）
   curl http://localhost:3000/api/dashboard/summary
   
   # 带 period（本月）
   curl "http://localhost:3000/api/dashboard/summary?period=2026-07"
   
   # 检查返回
   # - periodLeads.count 应该是本月新增
   # - stageChanges 应该是本月变更
   # - finance.wonCount 应该是本月成交（用 won_at）
   ```

**依赖**: Task 1（won_at 字段）
**风险**: 中（查询逻辑复杂，需要测试不同 period）
**验收**: 
- 不带 period → 返回全量
- 带 period → periodLeads/stageChanges/finance 按时间过滤
- wonCount 用 won_at（不是 updated_at）
**审计**: 需要（检查查询性能，大数据量可能需要索引）

### Task 5: 前端 — Dashboard 月份筛选
**文件**: `src/app/(dashboard)/dashboard/page.tsx`

**实现步骤**:

1. **添加月份选择器状态**：
   ```typescript
   const [selectedMonth, setSelectedMonth] = useState(() => {
     const now = new Date()
     return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
   })
   ```

2. **添加月份选择器 UI**（在 Dashboard 顶部）：
   ```tsx
   <select
     value={selectedMonth}
     onChange={(e) => setSelectedMonth(e.target.value)}
     className="rounded border px-3 py-1 text-sm"
   >
     {generateMonthOptions().map(m => (
       <option key={m} value={m}>{formatMonth(m)}</option>
     ))}
   </select>
   ```

3. **调用 API 时传 period**：
   ```typescript
   const { data: summary } = useSWR(
     `/api/dashboard/summary?period=${selectedMonth}`,
     fetcher
   )
   ```

4. **用 periodLeads 替换 leads 渲染**：
   ```typescript
   // 删除
   const newLeadsThisMonth = leads.filter(l => 
     new Date(l.created_at).getMonth() === new Date().getMonth()
   ).length
   
   // 替换为
   const newLeadsThisMonth = summary?.periodLeads?.count || 0
   ```

5. **Leaderboard 跟随月份**：
   ```tsx
   <h3>Sales Leaderboard — {formatMonth(selectedMonth)}</h3>
   ```

6. **验证**：
   ```bash
   npm run dev
   # 打开 http://localhost:3000/dashboard
   # 切换月份 → KPI 数字变化
   # Leaderboard 标题变化
   ```

**依赖**: Task 4
**风险**: 低
**验收**: 
- 切换月份 → 本月新增 leads 变化
- 切换月份 → Leaderboard 标题显示所选月份
- 切换月份 → KPI 数字变化
**审计**: 不需要

### Task 6: 前端 — Leads 详情页联系记录 + quality 判断
**文件**: `src/app/(dashboard)/leads/[id]/page.tsx`

**实现步骤**:

1. **创建联系记录输入组件** `src/app/(dashboard)/leads/[id]/ContactLogSection.tsx`：
   ```tsx
   'use client'
   
   import { useState } from 'react'
   import { Button } from '@/components/ui/button'
   import { Input } from '@/components/ui/input'
   import { Select } from '@/components/ui/select'
   import { useLeadMutations } from '../_hooks/useLeadMutations'
   
   interface ContactEntry {
     contact_type: 'phone' | 'whatsapp' | 'note' | 'face-to-face'
     summary: string
   }
   
   export function ContactLogSection({ leadId, currentQuality }: { 
     leadId: string
     currentQuality: string 
   }) {
     const [entries, setEntries] = useState<ContactEntry[]>([
       { contact_type: 'phone', summary: '' },
       { contact_type: 'whatsapp', summary: '' },
       { contact_type: 'note', summary: '' }
     ])
     const [quality, setQuality] = useState<string>('')
     const [poorReason, setPoorReason] = useState('')
     const { addFollowUp, updateQuality } = useLeadMutations()
     
     const addEntry = () => {
       if (entries.length < 5) {
         setEntries([...entries, { contact_type: 'phone', summary: '' }])
       }
     }
     
     const updateEntry = (idx: number, field: keyof ContactEntry, value: string) => {
       const updated = [...entries]
       updated[idx] = { ...updated[idx], [field]: value }
       setEntries(updated)
     }
     
     const handleSubmit = async () => {
       // 1. 提交所有非空联系记录
       for (const entry of entries) {
         if (entry.summary.trim()) {
           await addFollowUp(leadId, {
             contact_type: entry.contact_type,
             summary: entry.summary
           })
         }
       }
       
       // 2. 提交 quality
       if (quality) {
         await updateQuality(leadId, {
           quality,
           poor_reason: quality === 'poor' ? poorReason : undefined
         })
       }
     }
     
     const canSubmit = quality && (quality !== 'poor' || poorReason)
     
     return (
       <div className="border rounded-lg p-4 space-y-4">
         <h3 className="font-semibold">联系记录</h3>
         
         {entries.map((entry, idx) => (
           <div key={idx} className="flex gap-2 items-start">
             <span className="text-sm text-gray-500 w-6">#{idx + 1}</span>
             <Select
               value={entry.contact_type}
               onChange={(e) => updateEntry(idx, 'contact_type', e.target.value)}
               className="w-32"
             >
               <option value="phone">📞 电话</option>
               <option value="whatsapp">💬 WSA</option>
               <option value="face-to-face">🤝 面谈</option>
               <option value="note">📝 备注</option>
             </Select>
             <Input
               placeholder="Notes"
               value={entry.summary}
               onChange={(e) => updateEntry(idx, 'summary', e.target.value)}
               className="flex-1"
             />
           </div>
         ))}
         
         {entries.length < 5 && (
           <Button variant="outline" size="sm" onClick={addEntry}>
             + 添加联系
           </Button>
         )}
         
         <div className="pt-4 border-t">
           <label className="block text-sm font-medium mb-2">
             质量判断 *
           </label>
           <div className="flex gap-4">
             <label className="flex items-center gap-2">
               <input
                 type="radio"
                 name="quality"
                 value="poor"
                 checked={quality === 'poor'}
                 onChange={(e) => setQuality(e.target.value)}
               />
               Poor
             </label>
             <label className="flex items-center gap-2">
               <input
                 type="radio"
                 name="quality"
                 value="normal"
                 checked={quality === 'normal'}
                 onChange={(e) => setQuality(e.target.value)}
               />
               Normal
             </label>
             <label className="flex items-center gap-2">
               <input
                 type="radio"
                 name="quality"
                 value="good"
                 checked={quality === 'good'}
                 onChange={(e) => setQuality(e.target.value)}
               />
               High
             </label>
           </div>
           
           {quality === 'poor' && (
             <div className="mt-2">
               <label className="block text-sm mb-1">原因 *</label>
               <Input
                 value={poorReason}
                 onChange={(e) => setPoorReason(e.target.value)}
                 placeholder="请输入原因"
               />
             </div>
           )}
         </div>
         
         <Button
           onClick={handleSubmit}
           disabled={!canSubmit}
           className="w-full"
         >
           保存并提交
         </Button>
       </div>
     )
   }
   ```

2. **在 leads/[id]/page.tsx 中引入**：
   ```tsx
   import { ContactLogSection } from './ContactLogSection'
   
   // 在基础信息之后、LeadSalesProcess 之前插入
   <ContactLogSection leadId={lead.id} currentQuality={lead.quality} />
   ```

3. **在 useLeadMutations 中添加 updateQuality**：
   ```typescript
   const updateQuality = async (leadId: string, data: { 
     quality: string
     poor_reason?: string 
   }) => {
     const res = await fetch(`/api/leads/${leadId}/quality`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(data)
     })
     if (!res.ok) throw new Error('Failed to update quality')
     return res.json()
   }
   ```

4. **验证**：
   ```bash
   npm run dev
   # 打开 http://localhost:3000/leads/<lead_id>
   # 输入联系记录
   # 选择 quality = Normal
   # 点击保存
   # 检查数据库：follow_up_logs 和 business_events
   ```

**依赖**: Task 2-3
**风险**: 中（UI 复杂，需要测试各种交互）
**验收**: 
- 联系记录可以添加多条（最多 5 条）
- quality 未选 → 提交按钮禁用
- quality = Poor → poor_reason 必填
- 提交后 follow_up_logs 和 business_events 正确创建
**审计**: 需要（检查 UI 和权限）

### Task 7: 前端 — WeeklyReview 组件
- **文件**: `src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx`
- **变更**: 
  1. 创建新组件
  2. 从 /api/dashboard/summary 获取 stageChanges
  3. 渲染公司汇总和销售拆分
- **依赖**: Task 4-5
- **风险**: 低
- **验收**: 
  1. 切换时间范围（本周/上周/本月）
  2. 检查数据是否正确
- **审计**: 不需要

### Task 8: 页面 — 废弃 /command-center 和 /quotations
- **文件**: 
  - `src/app/(dashboard)/command-center/page.tsx` — 添加 redirect
  - `src/app/(dashboard)/quotations/page.tsx` — 添加 redirect
  - `src/lib/nav.ts` — 移除 /command-center
- **变更**:
  ```typescript
  import { redirect } from 'next/navigation';
  export default function Page() {
    redirect('/dashboard');
  }
  ```
- **依赖**: Task 5（如果 /dashboard 需要先完成月份筛选）
- **风险**: 低
- **验收**: 
  1. 访问 /command-center，检查是否 redirect
  2. 访问 /quotations，检查是否 redirect
- **审计**: 不需要

### Task 9: Smoke 测试 + 验收
- **文件**: `scripts/check-smoke.sh`（或新增 `e2e/p3-sales-ops.spec.ts`）
- **变更**: 
  1. 添加 P3 验收用例
  2. 运行 smoke 测试
- **依赖**: Task 1-8
- **风险**: 低
- **验收**: 所有测试通过
- **审计**: 不需要

---

## 五、推荐执行顺序（按风险排序）

1. **Task 1**: DB Migration — won_at 字段（或修改 PRD 口径）
2. **Task 2**: DB Migration — first_contact trigger（高风险，需要先验证 RLS）
3. **Task 3**: API — 更新 quality（低风险，但 Task 2 依赖）
4. **Task 8**: 页面 — 废弃 /command-center 和 /quotations（低风险，可以先做）
5. **Task 4**: API — 修改 /api/dashboard/summary（中风险，复杂查询）
6. **Task 5**: 前端 — Dashboard 月份筛选（低风险，Task 4 依赖）
7. **Task 6**: 前端 — Leads 详情页（中风险，UI 复杂）
8. **Task 7**: 前端 — WeeklyReview 组件（低风险，Task 4-5 依赖）
9. **Task 9**: Smoke 测试 + 验收（低风险，最后做）

---

## 六、不做清单

- ❌ 不做 stage_history 表（PRD §九明确排除）
- ❌ 不解析 activities 文本做统计（PRD §十一.11 禁止）
- ❌ 不新建 dashboard 变体页面（PRD §六.3 禁止）
- ❌ 不放宽 RLS（PRD §十一.13 禁止）
- ❌ 不重构无关页面（PRD §十一.6 禁止）
- ❌ 不迁移 leads mutations 到 server actions，除非必须（避免破坏现有权限）

---

## 七、验收矩阵

| 场景 | 预期结果 | 验证方式 |
|------|----------|----------|
| Dashboard 切换月份 | KPI、WeeklyReview、Leaderboard 更新 | 手动测试 |
| 插入 follow_up_logs | lead_milestones 自动创建 first_contact | `SELECT * FROM lead_milestones` |
| 更新 quality = poor | leads.quality 更新 + business_events 创建 | `SELECT * FROM business_events` |
| 更新 quality = High | leads.quality = good（落库） | `SELECT quality FROM leads` |
| quality = poor 但没填 poor_reason | 提交失败 | 前端测试 |
| WeeklyReview 切换时间 | 数据更新 | 手动测试 |
| Leaderboard 跟随月份 | 数据更新 | 手动测试 |
| 签约额统计 | 用 contracts.created_at | `SELECT * FROM contracts` |
| 回款额统计 | 用 payments.payment_date | `SELECT * FROM payments` |
| 访问 /command-center | redirect 到 /dashboard | 浏览器测试 |
| 访问 /quotations | redirect 到 /quotes | 浏览器测试 |
| 销售查看 leads | 只能看自己的 | 用销售账号登录测试 |
| Tanya/SAM 查看 leads | 可以看全量 | 用 admin 账号登录测试 |
| build | 成功 | `npm run build` |
| smoke | 通过 | `scripts/check-smoke.sh` |
| journal | 0 error | `journalctl -u newme-platform --since '5 min ago' \| grep -i error` |

---

## 八、LLM 分工

| LLM | 任务 |
|-----|------|
| **Qwen（当前）** | 审计 + 开发计划（已完成） |
| **DS/Hermes** | 执行 Task 1-9、部署、smoke、journal 检查 |
| **GLM/CC** | 精准代码 patch（如 Task 4 的复杂查询） |
| **Codex/GPT** | git diff 安全终审（每个 Task 完成后） |
| **GPT** | 最终业务口径裁决（如 won_at 字段决策） |

---

## 九、风险总结

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| won_at 字段缺失 | 高 | 修改 PRD 口径（用 final_status + updated_at） |
| follow_up_logs.notes vs summary | 中 | 修改 PRD 用 summary |
| lead_milestones CREATE TABLE 缺失 | 中 | 检查其他 migration 或手动创建 |
| trigger 被 RLS 阻断 | 高 | 使用 SECURITY DEFINER |
| business_events 两个 DDL 冲突 | 中 | 统一字段名 |
| 查询性能 | 中 | 添加索引，限制返回条数 |

---

## 十、下一步

1. **GPT 裁决**: won_at 字段（方案 A vs B）
2. **DS 执行**: Task 1-9
3. **Codex 审计**: 每个 Task 完成后
4. **部署**: 所有 Task 完成后
5. **验收**: 按验收矩阵测试

---

**审计完成时间**: 2026-07-04 23:50  
**审计人**: Qwen  
**审核人**: GPT（待审核）
