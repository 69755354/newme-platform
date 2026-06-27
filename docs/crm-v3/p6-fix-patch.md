# P6 修复补丁

> 目标文件：`src/app/api/quotations/generate/route.ts`
> 缺陷类型：IDOR（不安全直接对象引用）+ service_role 滥用
> 原则：删除 `getSupabaseAdmin()`，全部改用已认证用户上下文的 `supabase` 客户端，并在写库前加入归属校验。**不改动任何业务逻辑（报价计算、编号生成、activity/event 写入语义保持原样）。**

---

## RLS 策略检查结果

> 策略最终态以 `supabase/migrations/` 按文件名字典序依次执行后的结果为准。下述"有效策略"是所有未被后续迁移 DROP 的存活策略之并集（Postgres RLS 同表多策略为 OR 关系）。
> 注意：`profiles.role` 在 `20260605000000_newme_crm_v22_complete.sql:173-175` 已收紧为
> `('admin','boss','sales','designer','operator','finance')`，并执行 `UPDATE profiles SET role='admin' WHERE role='manager'`。
> **`manager` 已不是合法角色** —— 代码里的 `MANAGEMENT_ROLES` 含 `manager` 属无害死代码（为与 `timeline/route.ts` 模式对称而保留）。

### quotations INSERT —— ✅ 角色可用，但策略过松（不校验归属）
有效策略（`20260605000000_newme_crm_v22_complete.sql:62-70`，后续无覆盖）：
- `quotations_admin_all` `FOR ALL`：`role IN ('admin','boss','operator')` → admin/boss/operator 可 INSERT ✅
- `quotations_sales_insert` `FOR INSERT`：`WITH CHECK (role = 'sales')` → sales 可 INSERT ✅

**结论**：sales/admin/boss/operator 都能 INSERT。
**⚠️ 风险点**：`quotations_sales_insert` **不校验 `created_by = auth.uid()`、也不校验 lead 归属**，仅凭 `role='sales'` 即放行。也就是说 RLS 本身无法阻止一个 sales 用户给**别人的 lead** 插报价。这正是本次 **应用层归属校验** 必须兜底的原因（应用层为第一道闸，RLS 为最后兜底）。

### activities INSERT —— ✅ 任意已认证用户可插
有效策略（最终以 `20260611000000_fix_activities_rls.sql` 为准，晚于 v22）：
- `Authenticated users can insert activities` `FOR INSERT TO authenticated WITH CHECK (true)` → **任意已认证用户** ✅

**结论**：sales 写 activity（`user_id = user.id`）不受 RLS 阻断。（策略偏松，但功能不阻断。）

### business_events INSERT —— ❌ sales 会被拒绝（潜在功能回归）
有效策略（`20260603000000_add_crm_fields.sql:83-93` 创建，后续无 DROP）：
- `business_events_admin_all` `FOR ALL`：`role IN ('admin','manager')` → `manager` 失效，实际仅 `admin`
- `business_events_sales_create` `FOR INSERT`：`WITH CHECK (created_by = auth.uid() AND lead_id IN (...自己 lead))`
- `be_admin_all` `FOR ALL`（v22:316）：`role IN ('admin','boss')`

**问题**：`business_events_sales_create` 要求 `created_by = auth.uid()`，但本路由写入时只设了 **`user_id`，没有设 `created_by`**（`generate/route.ts:149-160`）。因此 sales 用户的 INSERT **会被 RLS 拒绝**（`created_by` 为 NULL ≠ `auth.uid()`）。

**当前之所以"能用"**，纯粹是因为 `getSupabaseAdmin()`（service_role）**绕过了全部 RLS**。一旦改用用户上下文客户端，**sales 生成报价时 business_event 写入会静默失败**（代码里 `eventErr` 只 `console.error` 不抛错，主报价仍返回 200，但事件丢失）。

**配套修复（二选一）**：
- 方案 A（**推荐，零代码改动**）：补一条 RLS INSERT 策略，按代码实际写入的 `user_id` 校验：
  ```sql
  CREATE POLICY "be_sales_insert_by_user" ON business_events FOR INSERT
    WITH CHECK (
      user_id = auth.uid()
      AND lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
    );
  ```
- 方案 B（改代码 1 行）：在 `business_events.insert({...})` 载荷里补 `created_by: user.id`，使现有 `business_events_sales_create` 策略通过。

> 见下文「必须配套的修复（2）」。

### leads UPDATE（改 stage）—— ✅ sales（自有）+ admin/boss；operator 被阻断
有效策略（`20260605000000_newme_crm_v22_complete.sql:283-288`）：
- `leads_sales_update` `FOR UPDATE`：`USING (assigned_to = auth.uid()) WITH CHECK (assigned_to = auth.uid())` → sales 改自己 lead ✅（本次只改 `stage`/`updated_at`，不动 `assigned_to`，WITH CHECK 通过）
- `leads_admin_update` `FOR UPDATE`：`role IN ('admin','boss')` → admin/boss ✅

**⚠️ 边界**：**operator** 不在 `leads_admin_update`（仅 admin/boss）内，若非 lead 归属人则无法 UPDATE → 该写会静默失败（`updateErr` 只记日志）。属于既有限制，非本次回归；sales 主路径不受影响。

---

## 代码修改（核心 diff）

仅改 `src/app/api/quotations/generate/route.ts` 一个文件：

```diff
--- a/src/app/api/quotations/generate/route.ts
+++ b/src/app/api/quotations/generate/route.ts
@@ -1,6 +1,5 @@
 import { NextRequest, NextResponse } from "next/server";
 import { revalidatePath } from "next/cache";
-import { createClient } from "@supabase/supabase-js";
 import { createServerSupabase } from "@/lib/supabase-server";
 import { calculateQuotation, CalculateResult } from "../../../../lib/quotation-engine";
 
@@ -12,21 +11,6 @@
  * Output: { status, quote_id, quote_no, total, valid_until }
  */
 
-function getSupabaseAdmin() {
-  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
-  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
-  if (!url || !key) {
-    throw new Error(
-      "SUPABASE_SERVICE_ROLE_KEY not configured — set it in production environment variables.",
-    );
-  }
-  return createClient(url, key);
-}
-
 /** Generate quote number: NM-YYYY-XXXX (sequential) */
 async function generateQuoteNo(supabase: any): Promise<string> {
   const year = new Date().getFullYear().toString();
@@ -88,16 +72,40 @@
       );
     }
 
-    const supabaseAdmin = getSupabaseAdmin();
-
-    // 2. Verify lead exists
-    const { data: lead, error: leadErr } = await supabaseAdmin
+    // 2. Authorization: fetch caller role + verify lead (RLS hides leads the
+    //    caller cannot see). Mirrors leads/[id]/timeline/route.ts and
+    //    quotations/export/route.ts ownership checks.
+    const { data: profile } = await supabase
+      .from("profiles")
+      .select("role")
+      .eq("id", user.id)
+      .single();
+    const MANAGEMENT_ROLES = ["admin", "boss", "operator", "manager"];
+    const isManagement = !!profile && MANAGEMENT_ROLES.includes(profile.role);
+
+    const { data: lead, error: leadErr } = await supabase
       .from("leads")
-      .select("id, customer_name")
+      .select("id, customer_name, assigned_to")
       .eq("id", lead_id)
       .single();
 
-    if (leadErr || !lead) {
-      console.error("[Quotation Generate] Lead not found:", leadErr);
-      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
+    // Management roles may quote any lead. Everyone else (e.g. sales) may only
+    // quote leads assigned_to them; RLS hides others' leads so a missing row
+    // for a non-manager is treated as 403 (not 404).
+    if (!isManagement) {
+      if (leadErr || !lead || !lead.assigned_to || lead.assigned_to !== user.id) {
+        return NextResponse.json(
+          { error: "Forbidden: not assigned to this lead" },
+          { status: 403 },
+        );
+      }
+    } else if (leadErr || !lead) {
+      console.error("[Quotation Generate] Lead not found:", leadErr);
+      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
     }
 
     // 3. Generate quote number
-    const quoteNo = await generateQuoteNo(supabaseAdmin);
+    const quoteNo = await generateQuoteNo(supabase);
 
     // 4. Save quotation to DB
-    const { data: quote, error: quoteErr } = await supabaseAdmin
+    const { data: quote, error: quoteErr } = await supabase
       .from("quotations")
       .insert({
         lead_id,
@@ -134,7 +142,7 @@
     }
 
     // 5. Create activity (quote_sent)
-    const { error: activityErr } = await supabaseAdmin.from("activities").insert({
+    const { error: activityErr } = await supabase.from("activities").insert({
       lead_id,
       type: "quote_sent",
       content: `报价已生成 #${quoteNo} (${calculation.currency} ${calculation.total.toLocaleString()})`,
@@ -146,7 +154,7 @@
     }
 
     // 6. Create business event
-    const { error: eventErr } = await supabaseAdmin.from("business_events").insert({
+    const { error: eventErr } = await supabase.from("business_events").insert({
       lead_id,
       event_type: "quotation_sent",
       description: `报价 ${quoteNo} 已生成，金额 ${calculation.currency} ${calculation.total.toLocaleString()}`,
@@ -163,7 +171,7 @@
     }
 
     // 7. Update lead stage
-    const { error: updateErr } = await supabaseAdmin
+    const { error: updateErr } = await supabase
       .from("leads")
       .update({
         stage: "quotation_submitted",
```

要点：
1. 删除 `import { createClient }` 与 `getSupabaseAdmin()` 整块。
2. 删除 `const supabaseAdmin = getSupabaseAdmin();`，所有 `supabaseAdmin` → `supabase`（共 6 处）。
3. lead 查询 `select` 增加 `assigned_to`；新增 `profiles.role` 查询与归属校验，精确产出 `401 / 403 / 200 / 404`。
4. **未触碰**：`calculateQuotation`、`generateQuoteNo` 算法体、各 insert 字段、revalidate、返回结构。

---

## 必须配套的修复（否则有功能回归）

### （1）`generateQuoteNo` 在 RLS 下会产生重复 `quote_no` —— 🔴 高优先级
`generateQuoteNo`（`route.ts:27-50`）扫描全表 `quotations.quote_no`（`like 'NM-<year>-%'`）取最大序号 +1。`quote_no` 为 `TEXT NOT NULL UNIQUE`（`v22:36`）。

切到用户上下文客户端后：
- **admin/boss/operator**：`quotations_admin_all` 可见全部 → 序号正确 ✅
- **sales**：`quotations_sales_select` 仅可见**自己 lead** 的报价 → 看不全历史 → 算出的序号偏小 → **与既有 `quote_no` 唯一约束冲突 → INSERT 报错 → 500**。

> 注意：这与"不要改编号生成逻辑"存在客观冲突 —— 客户端"取 max+1"的算法本质上依赖全局可见性，与 sales 的 RLS 不兼容。保留算法不变的前提下，唯一稳妥解是把"取序号"这一步**上移到数据库**。

推荐（**保留客户端算法语义，仅把可见性问题交给 DB**）：新增一个 `SECURITY DEFINER` RPC，以服务身份（绕过 RLS）原子地返回下一个序号：

```sql
-- 新迁移：20260624000000_next_quote_no_rpc.sql
CREATE OR REPLACE FUNCTION next_quote_no()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year   TEXT := to_char(now(), 'YYYY');
  v_max    INT;
  v_next   INT;
BEGIN
  SELECT COALESCE MAX(
           CAST(split_part(quote_no, '-', 3) AS INT)
         ), 0)
    INTO v_max
    FROM quotations
   WHERE quote_no LIKE 'NM-' || v_year || '-%';
  v_next := v_max + 1;
  RETURN 'NM-' || v_year || '-' || lpad(v_next::text, 4, '0');
END;
$$;
GRANT EXECUTE ON FUNCTION next_quote_no() TO authenticated;
```

`generate/route.ts` 调用改为：
```ts
const { data: rpc, error: rpcErr } = await supabase.rpc("next_quote_no").single();
if (rpcErr || !rpc) { /* 500 */ }
const quoteNo: string = rpc as unknown as string;
```
（`generateQuoteNo` 函数体可保留作回退或删除，二选一；本补丁主 diff 暂保持原函数以遵循"最小改动"，**但生产前必须上 RPC**。）

> 备选（不推荐，违背"删除 service_role"指令）：保留一个**只读** service_role 客户端仅供 `generateQuoteNo` 读序号。

### （2）business_events INSERT 对 sales 失败 —— 🟡 中优先级（静默丢事件）
如「RLS 检查」所述，补一条按 `user_id` 校验的 INSERT 策略（推荐），或给 insert 载荷补 `created_by: user.id`（代码 1 行）。二选一，建议走 RLS（零代码改动、与现有 `business_events_sales_create` 同语义）。

### （3）可选硬化：`quotations_sales_insert` 不校验归属
当前策略 `WITH CHECK (role='sales')` 过松。可在迁移中改为：
```sql
DROP POLICY IF EXISTS "quotations_sales_insert" ON quotations;
CREATE POLICY "quotations_sales_insert" ON quotations FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM leads l
       WHERE l.id = quotations.lead_id
         AND l.assigned_to = auth.uid()
    )
  );
```
让 RLS 真正兜底归属（应用层仍为第一道闸）。本次可不改，但建议一并硬化。

---

## 验证步骤

1. **未登录**：不带 cookie 调 `POST /api/quotations/generate` → **401 Unauthorized**。
2. **sales 给别人的 lead**：`role=sales` 用户对 `assigned_to != self` 的 lead 调用 → **403 Forbidden: not assigned to this lead**（lead 经 RLS 不可见，归入 403 分支）。
3. **sales 给自己的 lead**：`role=sales` 用户对 `assigned_to === self` 的 lead 调用 → **200**，返回 `quote_id/quote_no/total/...`，且 `quotations/activities/business_events/leads` 均写入成功（需先落实配套修复 1、2）。
4. **admin 给任意 lead**：`role=admin` 对任意 lead 调用 → **200**。
5. `npx tsc --noEmit` 通过（无 `createClient`/`supabaseAdmin` 残留引用）。
6. `npm run build` 通过。

> 手工/脚本核查：`grep -n "supabaseAdmin\|getSupabaseAdmin\|createClient" src/app/api/quotations/generate/route.ts` 应无输出。

---

## 风险评估

- **改动范围**：仅 1 个文件（`src/app/api/quotations/generate/route.ts`），净增/减约 ±30 行；纯删除 `service_role` + 改客户端变量名 + 加归属校验，**无业务逻辑变更**。
- **受影响的业务路径**：报价生成（`POST /api/quotations/generate`）。该路由被「报价生成」按钮/页面调用。修复后 sales 仅能为自己负责的 lead 生成报价，admin/boss/operator 仍可任意 lead。
- **🔴 主要回归风险**：`generateQuoteNo` 全表取序号在 sales 的 RLS 下会算出重复号 → 唯一约束冲突 500。**必须配套修复（1）的 RPC**，否则 sales 路径在生产会偶发 500。
- **🟡 次要回归风险**：business_events 对 sales 的 INSERT 会被 RLS 拒绝 → 事件静默丢失（主报价仍成功）。**需配套修复（2）**。
- **🟢 边界**：operator 改他人 lead 的 stage 仍受 `leads_admin_update`（仅 admin/boss）阻断（既有问题，非本次引入；仅 `updateErr` 记日志）。
- **回退方式**：
  - 代码：`git revert` 该单文件提交即可（service_role 客户端恢复，IDOR 恢复但不影响功能）。
  - 配套迁移（RPC / business_events 策略）：提供对应 `DROP FUNCTION/POLICY` 的 down 迁移；本仓已有 `rollback_crm_v3.sql` 先例，可按同风格补 down。
- **安全收益**：彻底消除"任意已登录用户给任意 lead 生成报价/改 stage/写事件"的 IDOR；service_role 不再下放到该路由，收敛了越权面。
