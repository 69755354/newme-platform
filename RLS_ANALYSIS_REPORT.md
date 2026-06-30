# NewMe CRM — RLS SQL 源码完整分析报告

> 生成时间: 2026-06-12 | 分析范围: `supabase/migrations/*.sql` (28个文件)

---

## 1. 每个表的 RLS 状态

| # | 表名 | RLS 启用 | 来源迁移文件 |
|---|------|---------|-------------|
| 1 | leads | ✅ ENABLE | init.sql / v22_complete.sql |
| 2 | customers | ✅ ENABLE | init.sql / v22_complete.sql |
| 3 | activities | ✅ ENABLE | init.sql / v22_complete.sql |
| 4 | profiles | ✅ ENABLE | init.sql / v22_complete.sql |
| 5 | projects | ✅ ENABLE | init.sql / v22_complete.sql |
| 6 | chat_messages | ✅ ENABLE | init.sql |
| 7 | quotes (旧表) | ✅ ENABLE | init.sql |
| 8 | business_events | ✅ ENABLE | crm_mvp_final.sql / v22_complete.sql |
| 9 | products | ✅ ENABLE | v22_complete.sql / fix_products_leads_rls.sql |
| 10 | quotations | ✅ ENABLE | v22_complete.sql |
| 11 | contracts | ✅ ENABLE | v22_complete.sql |
| 12 | installment_plans | ✅ ENABLE | v22_complete.sql |
| 13 | payments | ✅ ENABLE | v22_complete.sql |
| 14 | kpi_targets | ✅ ENABLE | create_kpi_targets.sql |
| 15 | lead_workflow_stages | ✅ ENABLE | workflow_stages.sql |
| 16 | notifications | ✅ ENABLE | create_notifications.sql |
| 17 | ad_spend | ✅ ENABLE | ad_spend.sql |
| 18 | activity_logs | ✅ ENABLE | activity_tracking.sql |
| 19 | user_session_daily | ✅ ENABLE | activity_tracking.sql |

**全部 19 张表均已启用 RLS。** 无遗漏。

---

## 2. 每个 POLICY 详情

> **说明**: 迁移中大量使用 `DROP POLICY IF EXISTS` + `CREATE POLICY`，因此同一张表上同一策略名可能被多个迁移修改。以下以最终有效的版本为准（按迁移文件时间顺序，最新覆盖）。

### 2.1 leads (6个有效策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| leads_admin_all | admin/boss/operator | SELECT | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator'))` | — |
| leads_sales_see | sales | SELECT | `assigned_to = auth.uid()` | — |
| leads_sales_insert | sales | INSERT | — | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales')` |
| sales_create_leads | sales/admin/boss | INSERT | — | `auth.uid() = assigned_to OR assigned_to IS NULL OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` |
| leads_sales_update | sales | UPDATE | `assigned_to = auth.uid()` | `assigned_to = auth.uid()` |
| leads_admin_update | admin/boss | UPDATE | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` | — |
| leads_delete_admin_boss | admin/boss | DELETE | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` | — |

> ⚠️ **注意**: init.sql 中还有 `admin_all` (FOR ALL) 策略，在 v22_complete.sql 中被 DROP。但审计注释中提到 `"Allow all inserts"` 和 `"leads_auth"` 策略在数据库中可能仍然存在（CREATE 语句未在迁移文件中找到，疑似手动创建或更早创建）。

### 2.2 customers (2个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| customers_admin_all | admin/boss/operator | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator'))` | 同 USING |
| customers_sales_see | sales | SELECT | `assigned_sales_id = auth.uid()` | — |

### 2.3 activities (5个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| activities_admin_all | admin/boss/operator | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator'))` | 同 USING |
| activities_sales_select | sales | SELECT | `lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()) OR contract_id IN (...) OR quotation_id IN (...) OR project_id IN (...)` | — |
| activities_sales_insert | sales | INSERT | — | `user_id = auth.uid() AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales')` |
| activity_sales_create_on_lead | sales/admin/boss | INSERT | — | `lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()) OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` |
| activities_sales_update | sales | UPDATE | `user_id = auth.uid()` | — |
| Authenticated users can insert activities | authenticated | INSERT | — | `true` ⚠️ |
| Users can view activities | authenticated | SELECT | `true` ⚠️ | — |

### 2.4 profiles (3个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| profiles_select | 全部 | SELECT | `true` | — |
| profiles_update_self | 本人 | UPDATE | `id = auth.uid()` | `id = auth.uid()` |
| profiles_admin_all | admin/boss | ALL | `EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','boss'))` | 同 USING |

### 2.5 projects (2个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| projects_admin_operator_all | admin/boss/operator | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator'))` | 同 USING |
| projects_sales_see | sales | SELECT | `assigned_to = auth.uid() OR sales_id = auth.uid() OR project_manager = auth.uid()` | — |

### 2.6 chat_messages (1个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| chat_access | 有lead权限者 | SELECT | `EXISTS (SELECT 1 FROM leads l WHERE l.id = chat_messages.lead_id AND (l.assigned_to = auth.uid() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager'))))` | — |

### 2.7 business_events (3个最终有效策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| be_admin_all | admin/boss | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` | 同 USING |
| be_relevant_select | sales/operator/finance | SELECT | `lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()) OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('operator','finance'))` | — |
| be_anon_insert | public (匿名) | INSERT | — | `true` |

> ⚠️ be_anon_insert 使用 `TO public`（含匿名用户），且 WITH CHECK = true。

### 2.8 products (4个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| products_select_all | authenticated | SELECT | `auth.role() = 'authenticated'` | — |
| products_insert_admin_boss | admin/boss | INSERT | — | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` |
| products_update_admin_boss | admin/boss | UPDATE | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` | 同 USING |
| products_delete_admin_boss | admin/boss | DELETE | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` | — |

> 注: v22_complete.sql 中的 `products_auth_all` 被 fix_products_leads_rls.sql 替换。

### 2.9 quotations (4个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| quotations_admin_all | admin/boss/operator | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator'))` | 同 USING |
| quotations_sales_select | sales | SELECT | `EXISTS (SELECT 1 FROM leads l WHERE l.id = quotations.lead_id AND l.assigned_to = auth.uid())` | — |
| quotations_sales_insert | sales | INSERT | — | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales')` |
| quotations_sales_update | sales (创建者) | UPDATE | `created_by = auth.uid()` | — |

### 2.10 contracts (3个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| contracts_admin_all | admin/boss/operator | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator'))` | 同 USING |
| contracts_sales_select | sales | SELECT | `sales_id = auth.uid()` | — |
| contracts_finance_select | finance | SELECT | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance')` | — |

### 2.11 installment_plans (2个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| ip_admin_all | admin/boss/operator/finance | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance'))` | 同 USING |
| ip_sales_select | sales | SELECT | `EXISTS (SELECT 1 FROM contracts c WHERE c.id = installment_plans.contract_id AND c.sales_id = auth.uid())` | — |

### 2.12 payments (2个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| payments_admin_all | admin/boss/operator/finance | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance'))` | 同 USING |
| payments_sales_select | sales | SELECT | `EXISTS (SELECT 1 FROM contracts c WHERE c.id = payments.contract_id AND c.sales_id = auth.uid())` | — |

### 2.13 kpi_targets (2个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| kpi_admin_all | admin/boss | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` | 同 USING |
| kpi_sales_read_own | sales | SELECT | `assigned_to = auth.uid() OR assigned_to IS NULL` | — |

### 2.14 lead_workflow_stages (4个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| wf_admin_all | admin/boss/operator | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator'))` | 同 USING |
| wf_sales_select | sales | SELECT | `EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_workflow_stages.lead_id AND l.assigned_to = auth.uid())` | — |
| wf_sales_insert | sales | INSERT | — | `EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id AND l.assigned_to = auth.uid())` |
| wf_sales_update | sales | UPDATE | `EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_workflow_stages.lead_id AND l.assigned_to = auth.uid())` | — |

### 2.15 notifications (4个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| notifications_user_read | 本人 | SELECT | `user_id = auth.uid()` | — |
| notifications_admin_read_all | admin/boss | SELECT | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))` | — |
| notifications_user_update | 本人 | UPDATE | `user_id = auth.uid()` | `user_id = auth.uid()` |
| notifications_service_insert | 任何人 | INSERT | — | `true` ⚠️ |

### 2.16 ad_spend (2个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| boss_admin_read_ad_spend | boss/admin | SELECT | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('boss','admin'))` | — |
| boss_admin_insert_ad_spend | boss/admin | INSERT | — | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('boss','admin'))` |

### 2.17 activity_logs (2个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| boss_admin_see_all_activity | boss/admin | SELECT | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('boss','admin'))` | — |
| sales_see_own_activity | 本人 | SELECT | `user_id = auth.uid()` | — |

### 2.18 user_session_daily (2个策略)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| boss_admin_see_all_sessions | boss/admin | SELECT | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('boss','admin'))` | — |
| sales_see_own_sessions | 本人 | SELECT | `user_id = auth.uid()` | — |

### 2.19 chat_messages (未更新)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| chat_access | 有lead权限者 | SELECT | `EXISTS (SELECT 1 FROM leads l WHERE l.id = chat_messages.lead_id AND (l.assigned_to = auth.uid() OR role IN ('admin','manager')))` | — |

> ⚠️ 此策略仍使用旧的 `manager` 角色，但 v22 已将 manager → admin。

### 2.20 quotes (旧表，仅init)

| 策略名 | 目标角色 | 操作 | USING 子句 | WITH CHECK 子句 |
|--------|---------|------|-----------|----------------|
| quote_admin | admin/manager | ALL | `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager'))` | — |

> ⚠️ 旧的 quotes 表策略仍使用 `manager` 角色。

---

## 3. 按角色分组汇总

### 3.1 admin 角色

| 表 | SELECT | INSERT | UPDATE | DELETE |
|----|--------|--------|--------|--------|
| leads | ✅ 全部 | ✅ | ✅ | ✅ (仅admin/boss) |
| customers | ✅ 全部 | ✅ | ✅ | ✅ |
| activities | ✅ 全部 | ✅ | ✅ | ✅ |
| profiles | ✅ 全部 (true) | ✅ | ✅ | ✅ |
| projects | ✅ 全部 | ✅ | ✅ | ✅ |
| chat_messages | ✅ | — | — | — |
| business_events | ✅ 全部 | ✅ | ✅ | ✅ |
| products | ✅ | — | ✅ | ✅ |
| quotations | ✅ 全部 | ✅ | ✅ | ✅ |
| contracts | ✅ 全部 | ✅ | ✅ | ✅ |
| installment_plans | ✅ 全部 | ✅ | ✅ | ✅ |
| payments | ✅ 全部 | ✅ | ✅ | ✅ |
| kpi_targets | ✅ 全部 | ✅ | ✅ | ✅ |
| lead_workflow_stages | ✅ 全部 | ✅ | ✅ | ✅ |
| notifications | ✅ 全部 | — | — | — |
| ad_spend | ✅ | ✅ | — | — |
| activity_logs | ✅ 全部 | — | — | — |
| user_session_daily | ✅ 全部 | — | — | — |

### 3.2 boss 角色

| 表 | SELECT | INSERT | UPDATE | DELETE |
|----|--------|--------|--------|--------|
| leads | ✅ 全部 | ✅ | ✅ | ✅ |
| customers | ✅ 全部 | ✅ | ✅ | ✅ |
| activities | ✅ 全部 | ✅ | ✅ | ✅ |
| profiles | ✅ 全部 | ✅ | ✅ | ✅ |
| projects | ✅ 全部 | ✅ | ✅ | ✅ |
| business_events | ✅ 全部 | ✅ | ✅ | ✅ |
| products | ✅ | ✅ | ✅ | ✅ |
| quotations | ✅ 全部 | ✅ | ✅ | ✅ |
| contracts | ✅ 全部 | ✅ | ✅ | ✅ |
| installment_plans | ✅ 全部 | ✅ | ✅ | ✅ |
| payments | ✅ 全部 | ✅ | ✅ | ✅ |
| kpi_targets | ✅ 全部 | ✅ | ✅ | ✅ |
| lead_workflow_stages | ✅ 全部 | ✅ | ✅ | ✅ |
| notifications | ✅ 全部 | — | — | — |
| ad_spend | ✅ | ✅ | — | — |
| activity_logs | ✅ 全部 | — | — | — |
| user_session_daily | ✅ 全部 | — | — | — |
| chat_messages | ❌ (仍用manager角色) | — | — | — |

### 3.3 operator 角色

| 表 | SELECT | INSERT | UPDATE | DELETE |
|----|--------|--------|--------|--------|
| leads | ✅ 全部 | — | — | — |
| customers | ✅ 全部 | ✅ | ✅ | ✅ |
| activities | ✅ 全部 | ✅ | ✅ | ✅ |
| projects | ✅ 全部 | ✅ | ✅ | ✅ |
| quotations | ✅ 全部 | ✅ | ✅ | ✅ |
| contracts | ✅ 全部 | ✅ | ✅ | ✅ |
| installment_plans | ✅ 全部 | ✅ | ✅ | ✅ |
| payments | ✅ 全部 | ✅ | ✅ | ✅ |
| lead_workflow_stages | ✅ 全部 | ✅ | ✅ | ✅ |
| business_events | ✅ (via operator clause) | — | — | — |
| profiles | ✅ (true) | — | ❌ | — |
| products | ❌ | ❌ | ❌ | ❌ |
| kpi_targets | ❌ | ❌ | ❌ | ❌ |
| notifications | ❌ | ❌ | ❌ | ❌ |
| ad_spend | ❌ | ❌ | ❌ | ❌ |
| activity_logs | ❌ | ❌ | ❌ | ❌ |
| user_session_daily | ❌ | ❌ | ❌ | ❌ |
| chat_messages | ❌ | — | — | — |

### 3.4 sales 角色

| 表 | SELECT | INSERT | UPDATE | DELETE |
|----|--------|--------|--------|--------|
| leads | ✅ 仅自己的 | ✅ (assigned_to=自己或NULL) | ✅ 仅自己的 | ❌ |
| customers | ✅ 仅自己的 | ❌ | ❌ | ❌ |
| activities | ✅ 关联lead/contract/quotation/project | ✅ | ✅ (仅自己的) | ❌ |
| profiles | ✅ (true) | — | ✅ 仅自己 | — |
| projects | ✅ (assigned_to/sales_id/pm=自己) | ❌ | ❌ | ❌ |
| chat_messages | ✅ (仅自己lead的) | — | — | — |
| business_events | ✅ (仅自己lead的) | — | — | — |
| products | ✅ (authenticated) | ❌ | ❌ | ❌ |
| quotations | ✅ (仅自己lead的) | ✅ | ✅ (仅created_by=自己) | ❌ |
| contracts | ✅ (sales_id=自己) | ❌ | ❌ | ❌ |
| installment_plans | ✅ (通过contract关联) | ❌ | ❌ | ❌ |
| payments | ✅ (通过contract关联) | ❌ | ❌ | ❌ |
| kpi_targets | ✅ (仅自己的) | ❌ | ❌ | ❌ |
| lead_workflow_stages | ✅ (仅自己lead的) | ✅ | ✅ | ❌ |
| notifications | ✅ (仅自己的) | ❌ | ✅ (仅自己的) | ❌ |
| ad_spend | ❌ | ❌ | ❌ | ❌ |
| activity_logs | ✅ (仅自己的) | — | — | — |
| user_session_daily | ✅ (仅自己的) | — | — | — |

### 3.5 finance 角色

| 表 | SELECT | INSERT | UPDATE | DELETE |
|----|--------|--------|--------|--------|
| contracts | ✅ 全部 | ❌ | ❌ | ❌ |
| installment_plans | ✅ 全部 | ✅ | ✅ | ✅ |
| payments | ✅ 全部 | ✅ | ✅ | ✅ |
| business_events | ✅ | — | — | — |
| profiles | ✅ (true) | — | ❌ | — |
| leads | ❌ | ❌ | ❌ | ❌ |
| customers | ❌ | ❌ | ❌ | ❌ |
| activities | ❌ (via override=true) | ✅ (via override=true) | ❌ | ❌ |
| 其他 | ❌ | ❌ | ❌ | ❌ |

---

## 4. 发现的潜在问题

### 🔴 严重问题 (CRITICAL)

| # | 问题 | 表 | 详情 | 影响 |
|---|------|-----|------|------|
| C1 | **activities INSERT 无条件放行** | activities | `20260611000000_fix_activities_rls.sql` 创建了 `WITH CHECK (true)` 的策略，任何已认证用户可插入任意 activity | 伪造活动记录、篡改审计轨迹 |
| C2 | **activities SELECT 无条件放行** | activities | 同一迁移中 `USING (true)` 让所有已认证用户看到全部 activities | 泄露所有销售线索动态、客户信息 |
| C3 | **business_events 匿名 INSERT** | business_events | `be_anon_insert` 策略 `TO public WITH CHECK (true)` — 未登录用户也能插入 | 注入虚假事件、污染数据 |
| C4 | **notifications INSERT 无限制** | notifications | `notifications_service_insert` 使用 `WITH CHECK (true)`，任何已认证用户可插入任意通知 | 伪造通知、钓鱼攻击 |
| C5 | **leads 可能存在幽灵策略** | leads | 审计注释提到 `"Allow all inserts"` (public, `with_check=true`) 和 `"leads_auth"` (authenticated ALL true) 策略可能在 DB 中仍然存在，但它们的 CREATE 语句未在迁移文件中找到 | 匿名用户可创建任意 lead；所有认证用户可读全部 leads |
| C6 | **profiles SELECT 全开放** | profiles | `profiles_select USING (true)` — 任何人（含匿名？）可看所有用户信息 | 泄露员工名单、角色、邮箱 |

### 🟠 高风险问题 (HIGH)

| # | 问题 | 表 | 详情 | 影响 |
|---|------|-----|------|------|
| H1 | **chat_messages 策略引用旧角色** | chat_messages | `chat_access` 策略检查 `role IN ('admin','manager')`，但 v22 已将 manager → admin | manager 角色已不存在，boss 无法查看聊天记录 |
| H2 | **旧 quotes 表策略引用旧角色** | quotes | `quote_admin` 策略检查 `role IN ('admin','manager')` | manager 已不存在，且该表已被 quotations 替代但未清理 |
| H3 | **leads 重复 INSERT 策略** | leads | `leads_sales_insert` 和 `sales_create_leads` 都允许 sales INSERT leads，但条件不同。`leads_sales_insert` 不检查 assigned_to，`sales_create_leads` 检查 | 行为不一致，可能导致 sales 将 lead 分配给他人 |
| H4 | **leads 无 admin INSERT 专用策略** | leads | `leads_admin_all` 仅覆盖 SELECT，admin/boss INSERT 依赖 `sales_create_leads` 的 EXISTS 子句 | 如果 `sales_create_leads` 被误删，admin 无法创建 leads |
| H5 | **sales 无法 INSERT/DELETE contracts** | contracts | sales 只有 SELECT 权限 | 前端如需创建合同，只能通过 RPC 或 service_role |

### 🟡 中等风险问题 (MEDIUM)

| # | 问题 | 表 | 详情 | 影响 |
|---|------|-----|------|------|
| M1 | **operator 看不到 products** | products | products 的 SELECT 策略仅检查 `auth.role() = 'authenticated'`（通过 fix），但 INSERT/UPDATE/DELETE 仅限 admin/boss | 如 operator 需要查看产品目录则受阻 |
| M2 | **ad_spend 缺少 UPDATE/DELETE** | ad_spend | 仅有 SELECT 和 INSERT，无 UPDATE/DELETE 策略 | boss/admin 无法修改或删除已录入的广告支出记录 |
| M3 | **activity_logs 缺少 INSERT 策略** | activity_logs | 仅有 SELECT 策略，INSERT 通过 SECURITY DEFINER RPC `log_activity()` 完成 | 若有人直接访问表（非 RPC）则无法插入，但这是设计意图。不过需确认无 service_role 旁路风险 |
| M4 | **user_session_daily 缺少 INSERT/UPDATE** | user_session_daily | 同上，通过 RPC 完成 | 同上 |
| M5 | **leads_sales_see 不含 NULL** | leads | v22 的 `leads_sales_see` 使用 `assigned_to = auth.uid()`（不含 `assigned_to IS NULL`），但 init.sql 的 `sales_own_leads` 含 NULL 检查 | 未分配的销售线索 sales 可能看不到 |
| M6 | **kpi_sales_read_own 含 NULL** | kpi_targets | `assigned_to = auth.uid() OR assigned_to IS NULL` — 所有 sales 可看到未分配的 KPI 目标 | 可能暴露管理层预算信息 |

### 🔵 低风险 / 建议优化

| # | 问题 | 表 | 详情 |
|---|------|-----|------|
| L1 | **chat_messages 仅有 SELECT** | chat_messages | 无 INSERT/UPDATE/DELETE 策略，需确认消息如何写入（可能是 service_role） |
| L2 | **旧 quotes 表未清理** | quotes | 已被 quotations 表替代，但旧表和策略仍在 |
| L3 | **finance 角色定义模糊** | 多表 | finance 仅在 contracts/installment_plans/payments 中有权限，但 profiles.role CHECK 中包含 finance |
| L4 | **重复策略累积** | activities | 经过多次修复，activities 表上可能有6+个策略同时生效，建议清理合并 |
| L5 | **get_my_role() 函数未在 RLS 中使用** | — | v22 定义了 `SECURITY DEFINER` 的 `get_my_role()` 函数用于避免 RLS 递归，但实际策略仍用子查询 `EXISTS (SELECT 1 FROM profiles...)` | 存在 RLS 递归性能风险 |

---

## 5. 建议优先修复清单

1. **立即修复 C1/C2**: 撤销 `fix_activities_rls.sql` 中的 `WITH CHECK (true)` / `USING (true)` 策略
2. **立即修复 C3**: 限制 `be_anon_insert` 到 `TO authenticated` 或加条件
3. **立即修复 C4**: 限制 `notifications_service_insert` 到 service_role
4. **排查 C5**: 在生产数据库执行 `\d leads` 确认是否存在幽灵策略
5. **修复 H1**: 更新 chat_messages 策略，将 `manager` 改为 `boss`
6. **清理 H3**: 合并 leads 的两个 INSERT 策略
7. **补充 H5**: 为 contracts 添加 sales INSERT 策略或确保通过 RPC 操作
8. **补充 M2**: 为 ad_spend 添加 UPDATE/DELETE 策略

---

*报告由 RLS 源码静态分析生成，建议结合生产数据库实际策略状态 (`SELECT * FROM pg_policies`) 交叉验证。*
