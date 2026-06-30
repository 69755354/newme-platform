# RLS Policy Live Database Report
**Task 4.2 + 4.3: 权限测试 + RLS 策略验证**  
**Generated:** 2026-06-30  
**Database:** vfopmpxlhwzpxqegayew (Supabase Live)  
**Method:** Direct database query via `supabase db query --linked`

---

## Executive Summary

🔴 **CRITICAL FINDINGS:**
1. **18 FOR ALL policies detected** - Hard rule violation (should be 0)
2. **pipeline_stages table MISSING** - Not found in database
3. **90% naming convention violations** - Non-standard policy names
4. **Multiple duplicate policies** - Redundant and conflicting rules

✅ **Positive:**
- All 13 expected tables have RLS enabled
- Basic role-based access control implemented
- Most tables have at least SELECT policies

---

## 1. Core Table Status

### Table Existence Check

| # | Expected Table | Status | RLS Enabled | Total Policies |
|---|----------------|--------|-------------|----------------|
| 1 | profiles | ✅ EXISTS | ✅ Yes | 3 |
| 2 | leads | ✅ EXISTS | ✅ Yes | 5 |
| 3 | customers | ✅ EXISTS | ✅ Yes | 3 |
| 4 | contracts | ✅ EXISTS | ✅ Yes | 3 |
| 5 | tasks | ✅ EXISTS | ✅ Yes | 3 |
| 6 | follow_up_logs | ✅ EXISTS | ✅ Yes | 5 |
| 7 | **pipeline_stages** | ❌ **MISSING** | N/A | 0 |
| 8 | payments | ✅ EXISTS | ✅ Yes | 2 |
| 9 | quotations | ✅ EXISTS | ✅ Yes | 6 |
| 10 | products | ✅ EXISTS | ✅ Yes | 6 |
| 11 | projects | ✅ EXISTS | ✅ Yes | 4 |
| 12 | activities | ✅ EXISTS | ✅ Yes | 3 |
| 13 | notifications | ✅ EXISTS | ✅ Yes | 4 |
| 14 | ad_spend | ✅ EXISTS | ✅ Yes | 2 |

**Total Tables:** 13/14 exist (93%)  
**Missing:** pipeline_stages (critical - defined in migration but not deployed)

---

## 2. Policy Count by Operation

| Table | SELECT | INSERT | UPDATE | DELETE | ALL | Total | Status |
|-------|--------|--------|--------|--------|-----|-------|--------|
| profiles | 1 | 0 | 1 | 0 | 1 | 3 | ❌ Has FOR ALL |
| leads | 1 | 1 | 1 | 1 | 1 | 5 | ❌ Has FOR ALL |
| customers | 1 | 0 | 0 | 0 | 2 | 3 | ❌ Has 2× FOR ALL |
| contracts | 2 | 0 | 0 | 0 | 1 | 3 | ❌ Has FOR ALL |
| tasks | 0 | 0 | 0 | 0 | 3 | 3 | ❌ Has 3× FOR ALL |
| follow_up_logs | 1 | 1 | 1 | 1 | 1 | 5 | ⚠️ Has "Default deny all" |
| payments | 1 | 0 | 0 | 0 | 1 | 2 | ❌ Has FOR ALL |
| quotations | 1 | 1 | 1 | 1 | 2 | 6 | ❌ Has 2× FOR ALL |
| products | 2 | 1 | 1 | 1 | 1 | 6 | ❌ Has FOR ALL |
| projects | 1 | 0 | 0 | 0 | 3 | 4 | ❌ Has 3× FOR ALL |
| activities | 1 | 0 | 0 | 0 | 2 | 3 | ❌ Has 2× FOR ALL |
| notifications | 2 | 1 | 1 | 0 | 0 | 4 | ✅ No FOR ALL |
| ad_spend | 1 | 1 | 0 | 0 | 0 | 2 | ✅ No FOR ALL |
| **TOTAL** | **16** | **7** | **6** | **4** | **18** | **51** | ❌ |

**Key Observations:**
- Only 2 tables (notifications, ad_spend) have NO FOR ALL policies ✅
- 11 tables have at least 1 FOR ALL policy ❌
- tasks has 0 SELECT/INSERT/UPDATE/DELETE policies (only FOR ALL)
- customers, contracts, payments missing INSERT/UPDATE/DELETE for non-admin roles

---

## 3. FOR ALL Policy Violations (CRITICAL)

### Complete List of 18 FOR ALL Policies

| Table | Policy Name | Roles | Qual (USING clause) |
|-------|-------------|-------|---------------------|
| **activities** | `activities_admin_all` | authenticated | `get_my_role() IN ('admin','operator')` |
| **activities** | `activities_sales_own` | authenticated | `get_my_role()='sales' AND user_id=auth.uid()` |
| **contracts** | `contracts_admin_all` | authenticated | `get_my_role() IN ('admin','boss','operator')` |
| **customers** | `customers_admin_all` | authenticated | `get_my_role() IN ('admin','operator')` |
| **customers** | `customers_sales_own` | authenticated | `get_my_role()='sales' AND assigned_sales_id=auth.uid()` |
| **follow_up_logs** | `Default deny all` | public | `false` |
| **leads** | `leads_admin_boss_operator_all` | authenticated | `get_my_role() IN ('admin','boss','operator')` |
| **payments** | `payments_admin_all` | authenticated | `get_my_role() IN ('admin','boss','operator','finance')` |
| **products** | `products_admin_all` | authenticated | `get_my_role() IN ('admin','boss')` |
| **profiles** | `profiles_admin_all` | authenticated | `get_my_role() IN ('admin','boss')` |
| **projects** | `projects_admin_all` | authenticated | `get_my_role() IN ('admin','operator')` |
| **projects** | `projects_admin_operator_all` | authenticated | `get_my_role() IN ('admin','boss','operator')` |
| **projects** | `projects_sales_own` | authenticated | `get_my_role()='sales' AND sales_id=auth.uid()` |
| **quotations** | `quotations_admin_all` | authenticated | `get_my_role() IN ('admin','boss','operator')` |
| **quotations** | `quotations_sales_own` | authenticated | `get_my_role()='sales' AND created_by=auth.uid()` |
| **tasks** | `Default deny all` | public | `false` |
| **tasks** | `tasks_admin` | public | `get_my_role() IN ('admin','boss')` |
| **tasks** | `tasks_own` | public | `lead_id IN (SELECT id FROM leads WHERE assigned_to=auth.uid())` |

**Impact:**
- FOR ALL policies bypass granular permission control
- Harder to audit who can do what
- Violates security best practices
- Makes permission changes risky

---

## 4. Naming Convention Analysis

**Required Format:** `policy_表名_操作_角色`  
**Example:** `policy_pipeline_stages_select_admin`

### Compliance Rate: 0% (0/51 policies)

**No policies follow the standard naming convention.**

### Common Violations:

1. **Missing `policy_` prefix** (51 policies)
   - ❌ `profiles_admin_all` → should be `policy_profiles_all_admin`
   - ❌ `leads_sales_select` → should be `policy_leads_select_sales`

2. **Non-standard role suffixes** (18 policies)
   - ❌ `_admin_all` → should be `_all_admin`
   - ❌ `_sales_own` → should be `_all_sales`
   - ❌ `_admin_boss_operator_all` → too verbose

3. **Descriptive names** (12 policies)
   - ❌ `sales_create_leads` → should be `policy_leads_insert_sales`
   - ❌ `sales_update_own` → should be `policy_leads_update_sales`
   - ❌ `boss_admin_read_ad_spend` → should be `policy_ad_spend_select_admin`

4. **"Default deny all"** (2 policies)
   - ❌ `Default deny all` on tasks, follow_up_logs
   - These are auto-generated by event trigger

---

## 5. Role Permission Matrix

### Admin/Boss Role
**Access:** Full access via FOR ALL policies

| Table | SELECT | INSERT | UPDATE | DELETE | Method |
|-------|--------|--------|--------|--------|--------|
| profiles | ✅ | ✅ | ✅ | ✅ | `profiles_admin_all` (FOR ALL) |
| leads | ✅ | ✅ | ✅ | ✅ | `leads_admin_boss_operator_all` (FOR ALL) |
| customers | ✅ | ✅ | ✅ | ✅ | `customers_admin_all` (FOR ALL) |
| contracts | ✅ | ✅ | ✅ | ✅ | `contracts_admin_all` (FOR ALL) |
| tasks | ✅ | ✅ | ✅ | ✅ | `tasks_admin` (FOR ALL) |
| follow_up_logs | ✅ | ✅ | ❌ | ❌ | SELECT + INSERT only (immutable) |
| payments | ✅ | ✅ | ✅ | ✅ | `payments_admin_all` (FOR ALL) |
| quotations | ✅ | ✅ | ✅ | ✅ | `quotations_admin_all` (FOR ALL) |
| products | ✅ | ✅ | ✅ | ✅ | `products_admin_all` (FOR ALL) |
| projects | ✅ | ✅ | ✅ | ✅ | `projects_admin_operator_all` (FOR ALL) |
| activities | ✅ | ✅ | ✅ | ✅ | `activities_admin_all` (FOR ALL) |
| notifications | ✅ | ✅ | ✅ | ❌ | SELECT + INSERT + UPDATE |
| ad_spend | ✅ | ✅ | ❌ | ❌ | SELECT + INSERT only |

### Sales Role
**Access:** Limited to own records

| Table | SELECT | INSERT | UPDATE | DELETE | Method |
|-------|--------|--------|--------|--------|--------|
| profiles | ✅ | ❌ | ✅ | ❌ | Self only |
| leads | ✅ | ✅ | ✅ | ✅ | `assigned_to=auth.uid()` |
| customers | ✅ | ❌ | ❌ | ❌ | `assigned_sales_id=auth.uid()` |
| contracts | ✅ | ❌ | ❌ | ❌ | `sales_id=auth.uid()` |
| tasks | ✅ | ✅ | ✅ | ✅ | Via lead assignment (FOR ALL) |
| follow_up_logs | ✅ | ✅ | ❌ | ❌ | Via lead assignment |
| payments | ✅ | ❌ | ❌ | ❌ | Via contract |
| quotations | ✅ | ✅ | ✅ | ✅ | `created_by=auth.uid()` |
| products | ✅ | ❌ | ❌ | ❌ | Read-only |
| projects | ✅ | ✅ | ✅ | ✅ | `sales_id=auth.uid()` (FOR ALL) |
| activities | ✅ | ✅ | ✅ | ✅ | `user_id=auth.uid()` (FOR ALL) |
| notifications | ✅ | ❌ | ✅ | ❌ | Self only |
| ad_spend | ❌ | ❌ | ❌ | ❌ | No access |

### Operator Role
**Access:** Similar to admin in most tables

| Table | SELECT | INSERT | UPDATE | DELETE | Method |
|-------|--------|--------|--------|--------|--------|
| leads | ✅ | ✅ | ✅ | ✅ | Via FOR ALL |
| customers | ✅ | ✅ | ✅ | ✅ | Via FOR ALL |
| contracts | ✅ | ✅ | ✅ | ✅ | Via FOR ALL |
| quotations | ✅ | ✅ | ✅ | ✅ | Via FOR ALL |
| products | ❌ | ❌ | ❌ | ❌ | No access |
| projects | ✅ | ✅ | ✅ | ✅ | Via FOR ALL |
| activities | ✅ | ✅ | ✅ | ✅ | Via FOR ALL |

### Designer Role
**Access:** ⚠️ **NOT DEFINED**

Designer role is mentioned in profiles table but has NO explicit policies on any table.

**Impact:** Designers cannot access any data unless they also have admin/boss/operator role.

### Manager Role
**Access:** ⚠️ **REMOVED**

Manager role was removed in migration `20260605000000` and replaced with 'admin'.

---

## 6. Critical Issues

### Issue 1: pipeline_stages Table Missing
**Severity:** 🔴 CRITICAL  
**Description:** Table defined in migration `20260630130000_pipeline_stages.sql` but not found in database  
**Impact:** Pipeline stage management broken  
**Fix:** Run pending migrations:
```bash
supabase db push
```

### Issue 2: 18 FOR ALL Policies
**Severity:** 🔴 CRITICAL  
**Description:** Hard rule violation - should be 0 FOR ALL policies  
**Impact:** Bypasses granular permissions, hard to audit  
**Fix:** Replace with explicit SELECT/INSERT/UPDATE/DELETE policies

### Issue 3: tasks Table Over-Permissive
**Severity:** 🟠 HIGH  
**Description:** 
- `tasks_admin` is FOR ALL to `{public}` role (should be `{authenticated}`)
- `tasks_own` is FOR ALL to `{public}` role
- No operation-specific policies

**Impact:** Anonymous users might have unintended access  
**Fix:** Restrict to `{authenticated}` and split into 4 operations

### Issue 4: follow_up_logs "Default deny all"
**Severity:** 🟡 MEDIUM  
**Description:** Auto-generated policy from event trigger blocks all access  
**Impact:** Conflicts with explicit policies  
**Fix:** Drop "Default deny all" policy

### Issue 5: Duplicate Policies
**Severity:** 🟡 MEDIUM  
**Description:** Multiple overlapping policies on same table

| Table | Duplicate Policies |
|-------|-------------------|
| customers | `customers_sales_own` (FOR ALL) + `customers_sales_see` (SELECT) |
| quotations | `quotations_sales_own` (FOR ALL) + `quotations_sales_select` (SELECT) |
| projects | `projects_admin_all` + `projects_admin_operator_all` (both FOR ALL) |
| products | `products_select_all` + `products_sales_select` (both SELECT) |

**Impact:** Confusing, potential security holes  
**Fix:** Consolidate to single policy per operation per role

### Issue 6: Missing Designer Permissions
**Severity:** 🟡 MEDIUM  
**Description:** Designer role has no explicit access policies  
**Impact:** Designers cannot work  
**Fix:** Add SELECT policies for relevant tables (projects, quotations, etc.)

---

## 7. Remediation Plan

### Phase 1: Deploy Missing Table (Day 1)
1. Run `supabase db push` to deploy pipeline_stages
2. Verify table exists and has correct policies

### Phase 2: Fix Critical Tables (Week 1)
**Priority:** Tables with FOR ALL policies and missing operations

1. **tasks** - Replace 3 FOR ALL with 4 operation-specific policies
2. **customers** - Split 2 FOR ALL, add INSERT/UPDATE/DELETE
3. **contracts** - Split 1 FOR ALL, add INSERT/UPDATE/DELETE
4. **payments** - Split 1 FOR ALL, add INSERT/UPDATE/DELETE

### Phase 3: Fix Remaining Tables (Week 2)
1. **activities** - Split 2 FOR ALL
2. **quotations** - Split 2 FOR ALL, consolidate duplicates
3. **projects** - Split 3 FOR ALL, consolidate duplicates
4. **products** - Split 1 FOR ALL, consolidate SELECT policies

### Phase 4: Polish (Week 3)
1. **leads** - Split 1 FOR ALL, rename policies
2. **profiles** - Split 1 FOR ALL, rename policies
3. **follow_up_logs** - Drop "Default deny all"
4. Add designer role permissions
5. Rename all policies to standard format

---

## 8. Validation Queries

### Check FOR ALL Policies (Should Return 0 Rows)
```sql
SELECT tablename, policyname, cmd, roles::text
FROM pg_policies 
WHERE schemaname = 'public'
AND tablename IN ('profiles','leads','customers','contracts','tasks',
                  'follow_up_logs','pipeline_stages','payments','quotations',
                  'products','projects','activities','notifications','ad_spend')
AND cmd = 'ALL'
ORDER BY tablename, policyname;
```

### Check Naming Convention (Should All Show ✓)
```sql
SELECT 
    tablename,
    policyname,
    cmd,
    CASE 
        WHEN policyname ~* '^policy_[a-z_]+_(select|insert|update|delete)_[a-z]+$' 
        THEN '✓ OK'
        ELSE '❌ Non-standard'
    END AS naming_status
FROM pg_policies 
WHERE schemaname = 'public'
AND tablename IN ('profiles','leads','customers','contracts','tasks',
                  'follow_up_logs','pipeline_stages','payments','quotations',
                  'products','projects','activities','notifications','ad_spend')
ORDER BY tablename, policyname;
```

### Check Operation Coverage (Should Have All 4 Operations)
```sql
SELECT 
    tablename,
    COUNT(*) FILTER (WHERE cmd = 'SELECT') AS select_count,
    COUNT(*) FILTER (WHERE cmd = 'INSERT') AS insert_count,
    COUNT(*) FILTER (WHERE cmd = 'UPDATE') AS update_count,
    COUNT(*) FILTER (WHERE cmd = 'DELETE') AS delete_count,
    COUNT(*) FILTER (WHERE cmd = 'ALL') AS all_count
FROM pg_policies 
WHERE schemaname = 'public'
AND tablename IN ('profiles','leads','customers','contracts','tasks',
                  'follow_up_logs','pipeline_stages','payments','quotations',
                  'products','projects','activities','notifications','ad_spend')
GROUP BY tablename
ORDER BY tablename;
```

---

## 9. Conclusion

**Current State:** 🔴 **NOT PRODUCTION READY**

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| FOR ALL policies | 18 | 0 | ❌ |
| Naming compliance | 0% | 100% | ❌ |
| Missing tables | 1 | 0 | ❌ |
| Duplicate policies | 8+ | 0 | ❌ |
| Designer permissions | None | Defined | ❌ |

**Effort Estimate:** 2-3 weeks  
**Risk Level:** HIGH - Security and maintainability issues

**Immediate Actions:**
1. Deploy pipeline_stages table
2. Fix tasks table (public role issue)
3. Start replacing FOR ALL policies with operation-specific ones

**Reference:** Use `notifications` and `ad_spend` tables as examples of good implementation (no FOR ALL policies).

---

**Report Generated:** 2026-06-30  
**Method:** Live database query via `supabase db query --linked`  
**Database:** vfopmpxlhwzpxqegayew  
**Total Policies Analyzed:** 51  
**FOR ALL Violations:** 18
