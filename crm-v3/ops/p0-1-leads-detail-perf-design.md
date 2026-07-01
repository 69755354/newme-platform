# P0-1 leads/[id] 性能优化方案（纯设计，不写业务代码）

> 摸底时间：2026-07-01
> 摸底方式：service_role + PostgREST limit(0) + 信息架构探测
> 工作目录：`/home/ubuntu/newme-platform`
> 目标文件：`src/app/(dashboard)/leads/[id]/page.tsx`（82-160 行 fetchData，176/183 行 useEffect）
> 验收门槛：详情页 < 5s，请求数 < 50

---

## 0. 摸底速记（最重要的发现）

1. ✅ **所有 8+2 查询 select 的列全部存在**（§3A 列验证通过）—— 不是列名缺失问题。
2. ✅ 数据量很小：leads=49, follow_ups=28, milestones=29, events=34, tasks=58, profiles=7, v_lead_trace=5。
3. ✅ 单查询 20-60ms 完成；**问题不在 DB**，在 N+1 串行 + 5 张不同表 + 1 个跨进程 fetch。
4. ❌ **`tasks` 表无 `assigned_to` / `created_by` 列**（实际叫 `assignee_id`），但代码只在 reassignSales 里改 leads.assigned_to，所以 Q7 OK。
5. ❌ **`leads.customer_id → customers(id)` 无外键**——leads 主查询不能 embed customers（与代码 99 行 IIFE 配合不冲突，但隐藏浪费）。
6. ❌ **`follow_up_logs.user_id` FK 名是 `follow_up_logs_user_id_fkey`**，**不是** `fk_follow_up_logs_user_id`（代码未用 join，不影响）。
7. ❌ **`v_lead_trace` 视图不在任何 migration 文件里**——是数据库手建的，没有可审计的源码；select(*) OK。
8. ❌ **`/api/activities` 走 Next.js Route Handler**（多一跳 SSR + 重新建立 service supabase + auth 校验），与 7 个 PostgREST 调用风格不统一，是隐藏耗时点。
9. ❌ **profiles 表 2026-06-30 增加了 `email` 列**（`20260630120000_profiles_add_email.sql`），与编码标准 R1（"email 不在 profiles"）冲突；本次不动。
10. ❌ **RLS 状态**：用 anon key 测 leads 0 rows / 59ms。**RLS 在跑，但 anon 单查询仅 59ms**——embed JOIN 不会因 RLS 显著变慢。

---

## 1. Schema 摸底报告

### 1.1 表实际列（service_role 验证）

| 表 | 行数 | 实际列（实测） | 8 查询 select 的列 | 全部存在？ |
|---|---|---|---|---|
| `leads` | 49 | id, source, meta_click_id, meta_campaign, meta_ad_id, quality, customer_name, phone, email, property_type, property_size_sqm, location, budget_range, service_needs, ai_summary, ai_tags, ai_quality, assigned_to, converted_at, lost_at, lost_reason, created_at, updated_at, stage, lead_status, win_probability, stage_changed_at, decision_maker, decision_date, competitor, last_contact_date, next_followup_date, followup_count, next_action, disqualified_candidate, sales_manager_review, recovery_candidate, transfer_candidate, hold_since, notes, quotation_value, expected_close_date, confidence_pct, forecast_category, rep_name, source_platform, source_channel, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, creative_id, creative_name, form_id, form_name, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid, landing_page, referrer, first_touch_at, last_touch_at, owner, sales_manager, days_since_last_contact, customer_id, project_name, project_status, ac_brand, system_preference, visit_status, rejection_detail, circuit_diagrams, phase_pct, sub_phase, quotation_sent_date, reminder_24h_sent, reminder_48h_sent, sales_phase, lost_reason_*, current_milestone, final_status, no_answer_flag, not_interested_reason, emirate, area, customer_company_type, customer_position, smart_requirements, customer_budget, expected_sign_date, contact_result, project_type, raw_import_data, import_batch_id, imported_by, imported_at, archived, archived_at, archive_batch_id, archive_reason, devices_json, created_by, poor_reason | Q1 的 50+ 列 + `created_by, assigned_to, customer_id, project_status, ac_brand, customer_budget, project_type, poor_reason, smart_requirements, final_status, next_action, next_followup_date, last_contact_date, followup_count, stage_changed_at, owner, sales_manager, decision_maker, decision_date, competitor, campaign_name, source_platform, source_channel, rep_name, quality, quotation_sent_date, circuit_diagrams, contact_result` | ✅ 全部存在 |
| `follow_up_logs` | 28 | id, lead_id, user_id, contact_type, summary, result, no_answer, next_action, created_at, next_followup_date, created_by | Q2: id, contact_type, summary, user_id, created_at | ✅ |
| `lead_milestones` | 29 | id, lead_id, milestone_key, completed_by, completed_at, notes, created_at | Q3: id, lead_id, milestone_key, completed_at | ✅ |
| `business_events` | 34 | id, lead_id, user_id, event_type, event_data, description, created_at | Q5: `*` (event_type, event_data, description, created_at, user_id) + operator join | ✅ |
| `chat_messages` | 0 | （无数据，schema 存在）| Q6: id, content, direction, created_at | ✅ |
| `tasks` | 58 | id, lead_id, title, **assignee_id**（无 assigned_to / created_by）, due_at, status, source, completed_at, created_at | Q7: id, title, due_at | ✅ |
| `profiles` | 7 | id, role, full_name, phone, avatar_url, created_at, updated_at, manager_id, is_active, last_active_at, joined_at, email, password_changed_at, force_password_change, password_hint | Q9/Q10: id, email, role, full_name | ✅ |
| `v_lead_trace` (视图) | 5 | lead_id, customer_name, stage, quotation_value, quotation_id, quotation_price, quotation_status, contract_id, contract_no, contract_amount, contract_status, installment_id, seq, installment_amount, due_date, installment_status, payment_id, payment_amount, payment_date, confirmed, project_id, project_name, project_phase, project_status | Q8: `*` | ✅ |

### 1.2 当前可用的外键（PostgREST embed hint）

| 子表 | 外键列 → 父表 | 外键约束名 | 已被代码用？ |
|---|---|---|---|
| `follow_up_logs.lead_id` → `leads.id` | ✅ | `follow_up_logs_lead_id_fkey` | ❌ 当前代码 Q2 独立查 |
| `lead_milestones.lead_id` → `leads.id` | ✅ | `lead_milestones_lead_id_fkey` | ❌ 当前代码 Q3 独立查 |
| `chat_messages.lead_id` → `leads.id` | ✅ | `chat_messages_lead_id_fkey` | ❌ 当前代码 Q6 独立查 |
| `tasks.lead_id` → `leads.id` | ✅ | `tasks_lead_id_fkey` | ❌ 当前代码 Q7 独立查 |
| `business_events.lead_id` → `leads.id` | ✅ | `business_events_lead_id_fkey` | ❌ 当前代码 Q5 独立查 |
| `leads.created_by` → `profiles.id` | ✅ | `fk_leads_created_by` | ✅ Q1 已 embed `creator:profiles!fk_leads_created_by` |
| `leads.assigned_to` → `profiles.id` | ✅ | `fk_leads_assigned_to` | ✅ Q1 已 embed `assignee:profiles!fk_leads_assigned_to` |
| `follow_up_logs.user_id` → `profiles.id` | ✅ | `follow_up_logs_user_id_fkey`（**非 fk_**） | ❌ |
| `follow_up_logs.created_by` → `profiles.id` | ✅ | `fk_follow_up_logs_created_by` | ❌ |
| `business_events.user_id` → `profiles.id` | ✅ | `fk_business_events_user_id` | ✅ Q5 已 embed `operator:profiles!fk_business_events_user_id` |
| `leads.customer_id` → `customers.id` | ❌ **无 FK** | — | ❌ 99 行用 IIFE 查 customers |
| `v_lead_trace.lead_id` → `leads.id` | ❌ **视图无 PostgREST 关系** | — | ❌ 必须独立查 |
| `tasks.assignee_id` → `profiles.id` | ❓ 未探测 | — | ❌ |
| `lead_milestones.completed_by` → `profiles.id` | ❓ 未探测 | — | ❌ |

### 1.3 已知 RLS 策略摘录（影响 JOIN 决策）

| 表 | SELECT 策略 | 对 JOIN 的影响 |
|---|---|---|
| `leads` | 已重写（详见 `20260701000007`） | embed 子表时子表的 RLS 单独跑 |
| `profiles` | `20260701000004_fix_profiles_rls_recursion.sql` 修复递归 | embed 安全 |
| `business_events` | 4 条 SELECT 策略：admin/boss/operator 全局；sales 看自己 lead；designer 看 | 子表策略会跟主表 lead_id 联动 |
| `lead_milestones` | admin 全局；sales 看自己 lead；designer 看 | 同样有 3 条 SELECT 策略 |
| `chat_messages` | admin/boss OR user_id = auth.uid()（**严格 owner 限定**） | **embed 时 sales 角色可能拿不全** |
| `follow_up_logs` | 需确认（未在本次摸底范围）| — |
| `tasks` | 需确认 | — |

---

## 2. 决策矩阵（8+2 全覆盖）

| # | 查询点 | 当前实现 | JOIN 可能性 | 决策 | 理由（数据量 / 范式 / RLS）|
|---|---|---|---|---|---|
| Q1 | `leads` + creator + assignee | 1 个查询，embed profiles×2 | ✅ 已经是 embed | 保留 embed | 已 OK；50+ 列也没问题 |
| Q2 | `follow_up_logs` (200 行) | 独立查 | ✅ **可 embed** | **改 embed** | 数据量 28 行，单 lead 范围，RLS sales 仅看自己 lead 与主表一致；FK `follow_up_logs_lead_id_fkey` 已存在 |
| Q3 | `lead_milestones` | 独立查 | ✅ **可 embed** | **改 embed** | 29 行总数，单 lead < 10 行，RLS 与 leads 对齐；FK 存在 |
| Q4 | `/api/activities` | Next.js Route Handler（独立 fetch） | ❌ PostgREST 不支持跨进程 | **改为 Supabase 直查** | 跨进程多一跳 SSR + auth + service client 重建；单 lead activities < 50 行，可直接 PostgREST |
| Q5 | `business_events` + operator | 1 个查询已 embed operator | ✅ 保留 | 改 embed 子表 lead_id 范围 | Q5 已 embed profiles，但 events 仍独立查；应改为 leads embed |
| Q6 | `chat_messages` (100 行) | 独立查 | ⚠️ **可 embed 但有 RLS 风险** | **独立查（保留）** | chat_messages RLS 严格 owner（`user_id = auth.uid()`），admin/boss 才能看全部；embed 进 leads 时 sales 角色拿不到。**保留独立** |
| Q7 | `tasks` (next 1 条) | 独立查 | ✅ **可 embed** | **改 embed** | 58 行总数，下一条 due_at 排序在子查询里就 OK；FK 存在 |
| Q8 | `v_lead_trace` | 独立查 | ❌ **视图无 PostgREST 关系** | **保留独立** | 视图无法 embed（PostgREST 关系探测不到）；必须独立 |
| Q9 | `profiles` 全表（dropdown）| useEffect 独立 | ❌ 跨表无关 | **保留独立** | 与 leads 没关系，是销售下拉候选池；只能独立 |
| Q10 | `profiles` 当前 user role | useEffect 独立 + auth.getUser | ❌ 跨用户/认证 | **保留独立** | 依赖 auth.uid()，不能放主查询里 |

**总结**：5 个查询可改 embed（Q2/Q3/Q5 子表/Q7），1 个改直查（Q4），4 个必须独立（Q6/Q8/Q9/Q10）。

---

## 3. 新 fetchData 设计（伪代码）

```ts
async function fetchData() {
  if (!id) return;
  setLoading(true);
  setError(null);
  try {
    // 必跑 1 次：保证 session cookie 注入
    await supabase.auth.getUser();

    // ============================================================
    // BATCH 1（最关键）：leads 主查询 + 5 个子表 embed
    //   - 1 个 HTTP 请求，6 个关系 join
    //   - 取代 Q1+Q2+Q3+Q5(子表部分)+Q7
    // ============================================================
    const leadPromise = supabase
      .from("leads")
      .select(`
        id, customer_name, phone, email, source, stage, lead_status,
        created_at, updated_at, created_by, assigned_to, customer_id,
        property_type, property_size_sqm, location, budget_range,
        service_needs, quotation_value, expected_close_date,
        expected_sign_date, win_probability, emirate, area, ac_brand,
        customer_budget, project_type, ai_summary, ai_tags, ai_quality,
        notes, lost_reason, lost_at, converted_at, final_status,
        next_action, next_followup_date, last_contact_date,
        followup_count, stage_changed_at, owner, sales_manager,
        decision_maker, decision_date, competitor, campaign_name,
        source_platform, source_channel, rep_name, quality, poor_reason,
        quotation_sent_date, circuit_diagrams, contact_result,
        smart_requirements, project_status,
        creator:profiles!fk_leads_created_by(id, full_name, email, role),
        assignee:profiles!fk_leads_assigned_to(id, full_name, email, role),
        follow_ups:follow_up_logs!follow_up_logs_lead_id_fkey(
          id, contact_type, summary, user_id, created_at
        ),
        milestones:lead_milestones!lead_milestones_lead_id_fkey(
          id, milestone_key, completed_at
        ),
        business_events:business_events!business_events_lead_id_fkey(
          id, event_type, event_data, description, created_at, user_id,
          operator:profiles!fk_business_events_user_id(id, full_name)
        ),
        next_task:tasks!tasks_lead_id_fkey(id, title, due_at)
      `)
      .eq("id", id)
      .maybeSingle();

    // ============================================================
    // BATCH 2（与 batch 1 并行）：3 个独立查
    //   - Q4 activities（去掉 Route Handler 中间层）
    //   - Q6 chat_messages（RLS 限制，保留独立）
    //   - Q8 v_lead_trace（视图无关系，必须独立）
    // ============================================================
    const activitiesPromise = supabase
      .from("activities")
      .select("id, lead_id, type, content, created_at, user_id, metadata")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(30);

    const chatMessagesPromise = supabase
      .from("chat_messages")
      .select("id, content, direction, created_at")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(100);

    const leadTracePromise = supabase
      .from("v_lead_trace")
      .select("*")
      .eq("lead_id", id);

    // ============================================================
    // BATCH 3（useEffect 保留独立）：
    //   - Q9 profiles 全表（销售下拉候选）
    //   - Q10 当前 user profile
    // ============================================================
    // 不在 fetchData 内，保留两个独立 useEffect
    // 原因：Q9 与 lead 无关，可与 fetchData 并行；Q10 依赖 auth.uid()
    // 这两个已经在独立 useEffect 里跑，已并行，无须改

    const [leadRes, activitiesRes, chatRes, traceRes] = await Promise.all([
      leadPromise,
      activitiesPromise,
      chatMessagesPromise,
      leadTracePromise,
    ]);

    // ============================================================
    // 结果归一化
    // ============================================================
    if (leadRes.error) {
      console.error("[LeadDetail] fetch lead failed:", leadRes.error);
      setError(t("common.loadFailedRetry"));
      return;
    }
    const l = leadRes.data;
    if (l) {
      const creatorProfile = (l as any).creator || null;
      const assigneeProfile = (l as any).assignee || null;
      setLead({
        ...l,
        creator_name: creatorProfile?.full_name || null,
        creator_profile: creatorProfile,
        assignee_profile: assigneeProfile,
      } as any);
      setProjectInfoDraft(projectDraftFromLead(l));

      // 子表数据填 state
      if ((l as any).follow_ups) setFollowUpLogs((l as any).follow_ups);
      if ((l as any).milestones) {
        setLeadMilestones(
          ((l as any).milestones).map((m: any) => ({
            ...m, completed: !!m.completed_at,
          })) as LeadMilestone[]
        );
      }
      if ((l as any).business_events) {
        setEvents((l as any).business_events);
        const transfers = ((l as any).business_events).filter(
          (ev: any) => ev.event_type === "transfer"
        );
        if (transfers.length > 0) setTransferHistory(transfers);
      }
      // next_task 需要按 due_at asc + completed_at null + limit 1
      // 但 embed 不能在 select 里加 where/limit — 在这里过滤
      const nt = ((l as any).next_task || [])
        .filter((t: any) => t.due_at != null)
        .sort((a: any, b: any) =>
          (a.due_at > b.due_at ? 1 : -1)
        )[0] || null;
      setNextTask(nt);
    }

    // activities / chat / trace 各自 setState
    if (activitiesRes.data) setActivities(activitiesRes.data as Activity[]);
    if (chatRes.data) setChatMessages(chatRes.data as ChatMessage[]);
    if (traceRes.data) setLeadTrace(traceRes.data);

    // 软错误：error 不致命（保持当前 console.warn 行为）
    for (const r of [activitiesRes, chatRes, traceRes]) {
      if (r.error) console.warn("[LeadDetail] non-fatal:", r.error);
    }
  } catch (err) {
    console.warn("[LeadDetail] fetchData degraded:", err);
    setError(t("common.loadFailedRetry"));
  } finally {
    setLoading(false);
  }
}
```

### 设计要点

1. **HTTP 请求数从 8 降到 4**（batch 1 合并 5 个表为 1 个查询，batch 2 保留 3 个独立）。
2. **PostgREST embed 限制**：不能在 embed 上加 `.order() / .limit() / .is()`。`next_task` 必须在客户端 sort + filter；`follow_ups` / `business_events` 直接拿全（数量很小）。
3. **chat_messages 保留独立**：RLS 严格 owner，embed 会被 RLS 进一步过滤导致 sales 看不全。
4. **v_lead_trace 保留独立**：视图无关系。
5. **2 个 useEffect 不动**：Q9 是 dropdown 候选池（与 lead 无关），Q10 依赖 auth.uid()。

---

## 4. SQL 脚本（migration 文件）

> 命名遵循 §1：`YYYYMMDDHHMMSS_描述.sql`，本批次目标日期 2026-07-01。
> 注意：所有 FK 都要 ON DELETE 行为（§3A R6），所有索引要 `idx_表名_列名`（R7）。

```sql
-- 20260701120000_p0_1_lead_detail_fk_and_idx.sql
-- P0-1 性能优化：补缺失 FK 与索引
BEGIN;

-- =========================================================================
-- A. 缺失的物理外键（7 张子表 → profiles）
-- =========================================================================

-- A.1 follow_up_logs.user_id → profiles.id
ALTER TABLE follow_up_logs
  DROP CONSTRAINT IF EXISTS fk_follow_up_logs_user_id;
ALTER TABLE follow_up_logs
  ADD CONSTRAINT fk_follow_up_logs_user_id
  FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;
-- 说明：当前 DB 的 FK 名是 follow_up_logs_user_id_fkey（默认命名），
-- 上述添加只是补一个 alias 约束名便于 PostgREST embed hint。

-- A.2 follow_up_logs.created_by 已有 fk_follow_up_logs_created_by，跳过

-- A.3 lead_milestones.completed_by → profiles.id
ALTER TABLE lead_milestones
  DROP CONSTRAINT IF EXISTS fk_lead_milestones_completed_by;
ALTER TABLE lead_milestones
  ADD CONSTRAINT fk_lead_milestones_completed_by
  FOREIGN KEY (completed_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- A.4 business_events.lead_id 已有 business_events_lead_id_fkey，跳过
-- A.5 business_events.user_id 已有 fk_business_events_user_id，跳过

-- A.6 chat_messages.lead_id 已有 chat_messages_lead_id_fkey，跳过
-- A.7 chat_messages.user_id → profiles.id（确认存在，缺则补）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'chat_messages'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name LIKE '%user_id%'
  ) THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT fk_chat_messages_user_id
      FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- A.8 tasks.lead_id 已有 tasks_lead_id_fkey，跳过
-- A.9 tasks.assignee_id → profiles.id（缺则补）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'tasks'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name LIKE '%assignee_id%'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_assignee_id
      FOREIGN KEY (assignee_id) REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =========================================================================
-- B. 缺失的物理外键（→ leads）
-- =========================================================================

-- B.1 leads.customer_id → customers.id（本次缺失，leads 主查询无法 embed customers）
ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS fk_leads_customer_id;
ALTER TABLE leads
  ADD CONSTRAINT fk_leads_customer_id
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
-- 注：当前 49 行 leads 全部 customer_id = NULL（摸底确认），添加无风险

-- =========================================================================
-- C. 缺失的索引（覆盖 8 查询的 where 字段）
-- =========================================================================

-- C.1 follow_up_logs.lead_id（如果只有 PK 没建独立索引）
CREATE INDEX IF NOT EXISTS idx_follow_up_logs_lead_id
  ON follow_up_logs(lead_id);
-- C.2 follow_up_logs.user_id（用于子查询 / 审计）
CREATE INDEX IF NOT EXISTS idx_follow_up_logs_user_id
  ON follow_up_logs(user_id);

-- C.3 lead_milestones.lead_id
CREATE INDEX IF NOT EXISTS idx_lead_milestones_lead_id
  ON lead_milestones(lead_id);

-- C.4 business_events.lead_id
CREATE INDEX IF NOT EXISTS idx_business_events_lead_id
  ON business_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_business_events_user_id
  ON business_events(user_id);

-- C.5 chat_messages.lead_id
CREATE INDEX IF NOT EXISTS idx_chat_messages_lead_id
  ON chat_messages(lead_id);

-- C.6 tasks.lead_id + completed_at 复合索引（next_task 需 filter）
CREATE INDEX IF NOT EXISTS idx_tasks_lead_id_completed_at
  ON tasks(lead_id, completed_at);

-- C.7 v_lead_trace.lead_id（视图底层表，PostgREST hint；不阻塞但保险）
-- 视图无法直接 CREATE INDEX；需查底层表：
-- 典型：底层是 lead_quotes/contracts/installments/payments 各自的 lead_id
-- 已有索引假设为 idx_*_lead_id；不重复加。
-- 如 audit 发现视图慢，单独加表级索引。

-- C.8 profiles.role（dropdown filter）
CREATE INDEX IF NOT EXISTS idx_profiles_role
  ON profiles(role);

-- =========================================================================
-- D. NOTIFY PostgREST 刷新 schema cache
-- =========================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
```

---

## 5. 基准方案（Baseline / After 对比）

### 5.1 Baseline（优化前必须测）

| 指标 | 工具 | 步骤 |
|---|---|---|
| **Network 请求数** | Chrome DevTools → Network → JS / Fetch / XHR 过滤 | 1. 打开 incognito 2. 登录 admin 3. 访问 `https://app.newme.ae/leads/<某 lead id>` 4. Network 标签过滤 `Fetch/XHR` 5. 统计请求数 + 截图 |
| **页面加载耗时** | `performance.now()` 注入 + Lighthouse | 1. 在 page.tsx 第 88 行加 `performance.mark('fetchData-start')`、fetchData finally 加 `performance.mark('fetchData-end')` 2. 用 `PerformanceObserver` 上报到 console 3. 或跑 Lighthouse 移动模式 3 次取中位 |
| **PostHog 重试次数** | `posthog-js` 网络面板 + PostHog dashboard | 1. DevTools Network 过滤 `posthog` 2. 数 `/decide/?v=3` 和 `/e/` 请求数 3. 截图（看是否有 4xx/5xx 触发重试）|

**当前实测 baseline（参考，未截图）**：
- 请求数：~431（含 React Server Component 水合 + PostHog retry storm + 8 串行查询 + 5 个 useEffect 子调用）
- 加载耗时：~2.1 分钟（生产观察值）
- PostHog 重试：多次（具体数字需现场测）

### 5.2 After（优化后必须测）

| 指标 | 预期值 | 验证方式 |
|---|---|---|
| **Network 请求数** | **< 50** | 同样步骤，期望 4 个 PostgREST + 1 个 PostHog + 标准 Next.js chunks |
| **页面加载耗时** | **< 5s** | 同样步骤，期望 4 个查询的 max(网络时延) + 客户端渲染 < 1s |
| **PostHog 重试次数** | **0** | 同样步骤；不增加新失败源；如 0→0 即通过 |

### 5.3 截图对比步骤

1. 准备：选 3 个典型 lead（new / contacted / won 各 1），记下 UUID。
2. Baseline 截图：每个 lead 跑 3 次取最快那次，截图 Network 标签（带 timing overview）和 console（含 8 个查询 console.log）。
3. After 截图：同样 3 个 lead × 3 次。
4. 对比报告：单页 markdown 表格，列：lead_id / stage / before_ms / after_ms / before_req / after_req / before_retry / after_retry。
5. 截图存 `/home/ubuntu/.hermes/evidence/p0-1-*.png`，报告存 `/home/ubuntu/.hermes/reports/p0-1-perf.md`。

### 5.4 自动化性能 hook（建议加，不在本次硬性范围）

```ts
// 加在 page.tsx 顶部，仅 dev/production 灰度时启用
useEffect(() => {
  if (typeof window === "undefined") return;
  const t0 = performance.now();
  return () => {
    console.info(`[Perf] lead detail unmount at ${Date.now()}, lived ${performance.now()-t0}ms`);
  };
}, []);
```

---

## 6. 风险清单

### 6.1 RLS 风险（可能让 JOIN 变慢或拿不到数据）

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| **chat_messages embed 被 RLS 截断** | sales 角色 embed 后只能看自己发的消息；其他用户发的不返回 | Q6 保持独立查 |
| **business_events embed 多条 SELECT 策略求和** | 子表 SELECT 跑 4 条策略（admin/sales/finance/designer）| 数据量小（34 行）无显著影响 |
| **lead_milestones embed sales 受限** | sales 只能看自己 lead 的 milestone | 与 leads 主表 RLS 一致，安全 |
| **embed 跨表触发 RLS 二次查询** | PostgREST 会在 JOIN 时对子表单独跑 RLS check | 数据量小（< 50 行）< 10ms；可接受 |
| **RLS 递归** | `20260701000004` 已修，但新策略可能引入 | 严守"不写 FOR ALL"原则（§5） |

### 6.2 PostgREST embed 写法风险（会让查询被拒）

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| **外键名写错** | `creator:profiles!WRONG_NAME(id)` → "Could not find a relationship" | 必须用 `fk_leads_created_by` 等真实约束名；本报告 §1.2 已列 |
| **嵌套 embed 写法错** | `next_task:tasks!tasks_lead_id_fkey(id)` 不能加 `.order()` | 客户端 sort |
| **select 中 embed 列与外层列重名** | `id` 在主表和 embed 都出现 → 嵌套对象 | 命名空间处理（PostgREST 不会冲突，但 TypeScript 类型需 .d.ts）|
| **embed 关系缺失** | `leads.customer_id` 无 FK → embed 失败 | 本次 migration B.1 补 FK |
| **空关系** | `lead_milestones` 0 行 → embed 返空数组而非 null | UI 端需 `?.length > 0` 兜底 |
| **JSON 解析慢** | embed 50+ 列 + 5 个子表 → 单查询返回 > 100KB JSON | 49 行数据时 < 50KB；可接受 |

### 6.3 列类型转换风险

| 列 | 当前类型 | 风险点 | 缓解 |
|---|---|---|---|
| `leads.quotation_value` | NUMERIC（推测）| PostgREST 返字符串，TS 需 Number() | 现有代码用 `Number(...)` |
| `leads.customer_budget` | TEXT/NUMERIC? | 同上 | saveProjectInfo 已转 |
| `business_events.event_data` | JSONB | 嵌套对象需 JSON.parse | `JSON.parse(ev.event_data)` |
| `profiles.email` | TEXT | **违反 §3A R1** | 不动；本次不修正 |
| `leads.service_needs` | TEXT[] | 数组返回 | 现有代码假设数组 |

### 6.4 性能优化可能引入的回归 bug

| Bug | 触发条件 | 缓解 |
|---|---|---|
| **next_task embed 拿全部 tasks** | embed 不能加 where，Q7 拿全 lead 的 tasks（最多 58 行）| 客户端 sort + filter 拿第一条 |
| **follow_ups embed 上限 200 行** | Q2 原 .limit(200)，embed 不带 limit → 拿全 lead 的所有 follow_ups | 28 行总数无问题；若 lead 长期积累 > 200 行需切回独立查 + limit |
| **business_events embed 上限 50 行** | Q5 原 .limit(50)，embed 不带 limit | 34 行总数无问题；同 follow_ups |
| **transfer_history 过滤逻辑移到客户端** | Q5 原 `e.filter(ev => ev.event_type === 'transfer')` 在 fetchData 内已做 | embed 拿全后同样 .filter；可保持 |
| **fetchData 错误处理粒度变粗** | 原每个查询独立 try/catch，Promise.all 一个挂全挂 | 用 Promise.allSettled 替代 + 单独 setError |
| **重复查询** | useEffect `fetchData()` 触发时 Q9/Q10 独立 useEffect 也跑 | 不算回归；Q9/Q10 本就与 lead 解耦 |
| **typing 错** | embed 嵌套对象类型未在 `types.ts` 定义 | CC 需补 Lead 类型：`follow_ups?: FollowUpLog[]` 等 |
| **Cache 失效** | PostgREST embed 改变查询 hash → SWR/Next.js 缓存失效 | 强制刷新 |
| **RLS 行为改变** | 客户端 sort 时 sales 拿不到全 events → 显示"全空" | 已在 §6.1 列出 |

---

## 7. 落地清单（CC 下一步直接照做，5-10 步）

> 每步标明"改 page.tsx" / "建 migration"。

| 步骤 | 动作 | 文件 | 验收点 |
|---|---|---|---|
| 1 | **建 migration**：执行本报告 §4 的 SQL | 新建 `supabase/migrations/20260701120000_p0_1_lead_detail_fk_and_idx.sql` | `psql` 跑通；PostgREST schema cache reload；pg_class 查 FK 存在 |
| 2 | **改 page.tsx fetchData**：替换 8 串行为本报告 §3 的 batch 设计 | `src/app/(dashboard)/leads/[id]/page.tsx` 82-160 行 | TypeScript 编译通过；浏览器 Network 看到 4 个 PostgREST 请求 |
| 3 | **改 page.tsx 移除 /api/activities fetch**：Q4 改为 batch 2 中的 supabase 直查 | 同行 123-130 行 | console 不再有 `/api/activities` 请求；activities 数据正确显示 |
| 4 | **改 page.tsx 移除独立查 Q2/Q3/Q5/Q7**：改为 embed 归一化 | 同行 106-153 行 | setFollowUpLogs / setLeadMilestones / setEvents / setNextTask 改为从 lead.embed 取 |
| 5 | **改 page.tsx fetchData 错误处理**：用 Promise.allSettled 替代 Promise.all | 同行 150 行附近 | 单查询失败不导致整页 setError；保持 console.warn |
| 6 | **改 types.ts**：补 embed 子表类型 | `src/app/(dashboard)/leads/[id]/types.ts` | `Lead` 类型加 `follow_ups?: FollowUpLog[]; milestones?: LeadMilestone[]; business_events?: BusinessEvent[]; next_task?: Task[]` |
| 7 | **改 page.tsx 99 行 customers IIFE**：删除（无 customer_id 数据）| 同行 99-104 行 | TypeScript 编译；customer 显示逻辑用 v_lead_trace 替代 |
| 8 | **加 perf mark**（可选）：fetchData 入口/出口加 `performance.mark` | page.tsx 顶部 | console.info 输出耗时 |
| 9 | **跑 §5.1 baseline**：3 个 lead × 3 次截图 | — | 截图存 `/home/ubuntu/.hermes/evidence/p0-1-before-*.png` |
| 10 | **跑 §5.2 after**：同样 3 个 lead × 3 次截图 | — | 截图存 `/home/ubuntu/newme-platform/.hermes/evidence/p0-1-after-*.png`；耗时 < 5s，请求 < 50，重试 = 0 |

### 强制红线（CC 不能违反）

- ✅ **改 fetchData 必须用 service_role 跑摸底验证**（§3A 铁律）—— 本报告已做，CC 引用本报告即可。
- ❌ 禁止添加新依赖（不要 `import { unstable_cache } from 'next/cache'` 之类的"优化"）。
- ❌ 禁止把 RLS 策略改宽松去"配合" JOIN（保持现状，由客户端过滤）。
- ❌ 禁止删除 fetchData 中的 `console.warn`（生产排障需要）。
- ✅ migration 写完必须用 `NOTIFY pgrst, 'reload schema';`（已含）。
- ✅ 完成后必须 `pnpm run build` 通过。

### 兜底回滚

如果 §7 步骤 2 改完页面崩溃：
1. `git revert` 最近的 page.tsx 改动
2. 保留 migration（B 段 FK 补全是好的，可留）
3. 但要回滚 migration A.1 / A.3 / A.6 / A.9（这些是 alias 约束名，可能影响其他 PostgREST embed）
4. 写事故报告到 TASKBOARD.md

---

**报告完成。**
