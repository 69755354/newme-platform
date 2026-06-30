# RLS Policy Validation Report
**Task 4.2 + 4.3: 权限测试 + RLS 策略验证**  
**Generated:** 2026-06-30  
**Project:** newme-platform  
**Database:** vfopmpxlhwzpxqegayew (Supabase)

---

## Executive Summary

⚠️ **CRITICAL ISSUES FOUND:**
1. **Multiple FOR ALL policies detected** - Violates hard rule prohibiting FOR ALL
2. **Inconsistent naming conventions** - Many policies don't follow `policy_表名_操作_角色` pattern
3. **14 tables analyzed** instead of expected 13 core tables

✅ **Positive Findings:**
- All 13 core tables have RLS enabled
- Role-based access control implemented for admin/boss/manager/sales/designer
- Most tables have appropriate SELECT/INSERT/UPDATE/DELETE policies

---

## 1. Core Table RLS Policy Analysis

### Table: `profiles`
**Total Policies:** 3  
**Operations:** SELECT(1), UPDATE(1), ALL(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `profile_self` | SELECT | All authenticated | ⚠️ Old naming |
| `profiles_update_self` | UPDATE | Self only | ⚠️ Missing role suffix |
| `profiles_admin_all` | ALL | admin, boss | ❌ **FOR ALL violation** |

**Issues:**
- ❌ Uses FOR ALL policy (prohibited)
- ⚠️ Inconsistent naming (mix of old and new conventions)

---

### Table: `leads`
**Total Policies:** 7  
**Operations:** SELECT(2), INSERT(2), UPDATE(2), DELETE(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `leads_admin_all` | SELECT | admin, boss, operator | ⚠️ Misleading name (says "all" but is SELECT) |
| `leads_sales_see` | SELECT | Self (assigned_to) | ⚠️ Non-standard naming |
| `sales_own_leads` | SELECT | Self (assigned_to) | ⚠️ Old naming convention |
| `leads_sales_insert` | INSERT | sales | ✓ OK |
| `sales_create_leads` | INSERT | sales, admin, boss | ⚠️ Duplicate with above |
| `leads_sales_update` | UPDATE | Self (assigned_to) | ⚠️ Missing role suffix |
| `leads_admin_update` | UPDATE | admin, boss | ✓ OK |
| `leads_delete_admin_boss` | DELETE | admin, boss | ⚠️ Non-standard naming |

**Issues:**
- ⚠️ Multiple duplicate/overlapping SELECT policies
- ⚠️ Inconsistent naming conventions
- ✓ No FOR ALL violations (good)

---

### Table: `customers`
**Total Policies:** 4  
**Operations:** SELECT(2), ALL(2)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `customers_admin_all` | ALL | admin, boss, operator | ❌ **FOR ALL violation** |
| `customer_admin` | ALL | admin, manager | ❌ **FOR ALL violation** |
| `customers_sales_see` | SELECT | Self (assigned_sales_id) | ⚠️ Non-standard naming |
| `customer_sales` | SELECT | Self (lead assigned) | ⚠️ Duplicate with above |

**Issues:**
- ❌ **2 FOR ALL policies** (critical violation)
- ⚠️ Duplicate SELECT policies with different naming

---

### Table: `contracts`
**Total Policies:** 4  
**Operations:** SELECT(2), ALL(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `contracts_admin_all` | ALL | admin, boss, operator | ❌ **FOR ALL violation** |
| `contracts_sales_select` | SELECT | Self (sales_id) | ⚠️ Non-standard naming |
| `contracts_finance_select` | SELECT | finance | ⚠️ Non-standard naming |
| `contracts_manager_all` | ALL | manager | ❌ **FOR ALL violation** (dropped in later migration) |

**Issues:**
- ❌ **1 FOR ALL policy** (critical violation)
- ⚠️ Non-standard naming for SELECT policies

---

### Table: `tasks`
**Total Policies:** 2  
**Operations:** ALL(2)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `tasks_own` | ALL | Self (lead assigned) | ❌ **FOR ALL violation** |
| `tasks_admin` | ALL | admin, boss | ❌ **FOR ALL violation** |

**Issues:**
- ❌ **2 FOR ALL policies** (critical violation)
- ⚠️ Missing operation-specific policies

---

### Table: `follow_up_logs`
**Total Policies:** 4  
**Operations:** INSERT(1), SELECT(1), UPDATE(1), DELETE(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `follow_up_logs_insert` | INSERT | Self + admin/boss | ✓ OK |
| `follow_up_logs_select` | SELECT | Self + admin/boss | ✓ OK |
| `follow_up_logs_no_update` | UPDATE | false (deny all) | ✓ OK (immutable log) |
| `follow_up_logs_no_delete` | DELETE | false (deny all) | ✓ OK (immutable log) |

**Issues:**
- ⚠️ Naming doesn't include role suffix
- ✓ **No FOR ALL violations** (good)
- ✓ Correctly enforces immutability

---

### Table: `pipeline_stages`
**Total Policies:** 6  
**Operations:** SELECT(3), INSERT(1), UPDATE(1), DELETE(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `policy_pipeline_stages_select_admin` | SELECT | admin | ✓ **Perfect naming** |
| `policy_pipeline_stages_select_manager` | SELECT | manager | ✓ **Perfect naming** |
| `policy_pipeline_stages_select_sales` | SELECT | sales | ✓ **Perfect naming** |
| `policy_pipeline_stages_insert_admin` | INSERT | admin | ✓ **Perfect naming** |
| `policy_pipeline_stages_update_admin` | UPDATE | admin | ✓ **Perfect naming** |
| `policy_pipeline_stages_delete_admin` | DELETE | admin | ✓ **Perfect naming** |

**Issues:**
- ✅ **No issues - perfect implementation**
- ✓ Follows naming convention exactly
- ✓ No FOR ALL policies
- ✓ Clear role separation

---

### Table: `payments`
**Total Policies:** 2  
**Operations:** SELECT(1), ALL(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `payments_admin_all` | ALL | admin, boss, operator, finance | ❌ **FOR ALL violation** |
| `payments_sales_select` | SELECT | Self (contract sales_id) | ⚠️ Non-standard naming |

**Issues:**
- ❌ **1 FOR ALL policy** (critical violation)
- ⚠️ Non-standard naming

---

### Table: `quotations`
**Total Policies:** 5  
**Operations:** SELECT(1), INSERT(1), UPDATE(1), DELETE(1), ALL(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `quotations_admin_all` | ALL | admin, boss, operator | ❌ **FOR ALL violation** |
| `quotations_sales_select` | SELECT | Self (lead assigned) | ⚠️ Non-standard naming |
| `quotations_sales_insert` | INSERT | sales | ⚠️ Non-standard naming |
| `quotations_sales_update` | UPDATE | Self (created_by) | ⚠️ Non-standard naming |
| `quotations_creator_delete_own` | DELETE | Self (created_by) | ⚠️ Non-standard naming |

**Issues:**
- ❌ **1 FOR ALL policy** (critical violation)
- ⚠️ Non-standard naming for all policies

---

### Table: `products`
**Total Policies:** 5  
**Operations:** SELECT(1), INSERT(1), UPDATE(1), DELETE(1), ALL(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `products_auth_all` | ALL | All authenticated | ❌ **FOR ALL violation** |
| `products_select_all` | SELECT | All authenticated | ⚠️ Non-standard naming |
| `products_insert_admin_boss` | INSERT | admin, boss | ⚠️ Non-standard naming |
| `products_update_admin_boss` | UPDATE | admin, boss | ⚠️ Non-standard naming |
| `products_delete_admin_boss` | DELETE | admin, boss | ⚠️ Non-standard naming |

**Issues:**
- ❌ **1 FOR ALL policy** (critical violation)
- ⚠️ Redundant SELECT policy (products_auth_all already covers it)
- ⚠️ Non-standard naming

---

### Table: `projects`
**Total Policies:** 3  
**Operations:** SELECT(1), ALL(2)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `projects_admin_operator_all` | ALL | admin, boss, operator | ❌ **FOR ALL violation** |
| `project_admin` | ALL | admin, manager | ❌ **FOR ALL violation** |
| `projects_sales_see` | SELECT | Self (assigned/sales/manager) | ⚠️ Non-standard naming |

**Issues:**
- ❌ **2 FOR ALL policies** (critical violation)
- ⚠️ Duplicate ALL policies with different role names

---

### Table: `activities`
**Total Policies:** 6  
**Operations:** SELECT(3), INSERT(2), UPDATE(1), ALL(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `activities_admin_all` | ALL | admin, boss, operator | ❌ **FOR ALL violation** |
| `activity_admin` | ALL | admin, manager | ❌ **FOR ALL violation** |
| `activities_sales_select` | SELECT | Self (multiple conditions) | ⚠️ Non-standard naming |
| `activity_sales_see` | SELECT | Self (lead assigned) | ⚠️ Duplicate with above |
| `Users can view activities` | SELECT | All authenticated | ⚠️ Spaces in name, overly permissive |
| `activities_sales_insert` | INSERT | sales | ⚠️ Non-standard naming |
| `Authenticated users can insert activities` | INSERT | All authenticated | ⚠️ Spaces in name, overly permissive |
| `activity_sales_create` | INSERT | Self (user_id) | ⚠️ Duplicate with above |
| `activities_sales_update` | UPDATE | Self (user_id) | ⚠️ Non-standard naming |

**Issues:**
- ❌ **2 FOR ALL policies** (critical violation)
- ⚠️ Multiple duplicate/overlapping policies
- ⚠️ Policies with spaces in names
- ⚠️ Overly permissive policies (TO authenticated with USING true)

---

### Table: `notifications`
**Total Policies:** 4  
**Operations:** SELECT(2), UPDATE(1), INSERT(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `notifications_user_read` | SELECT | Self (user_id) | ⚠️ Non-standard naming |
| `notifications_admin_read_all` | SELECT | admin, boss | ⚠️ Non-standard naming |
| `notifications_user_update` | UPDATE | Self (user_id) | ⚠️ Non-standard naming |
| `notifications_service_insert` | INSERT | All authenticated | ⚠️ Non-standard naming |

**Issues:**
- ⚠️ Non-standard naming for all policies
- ✓ **No FOR ALL violations** (good)

---

### Table: `ad_spend`
**Total Policies:** 4  
**Operations:** SELECT(1), INSERT(1), UPDATE(1), DELETE(1)

| Policy Name | Operation | Roles | Status |
|------------|-----------|-------|--------|
| `ad_spend_admin_select` | SELECT | admin, boss | ✓ OK |
| `ad_spend_admin_insert` | INSERT | admin, boss | ✓ OK |
| `ad_spend_admin_update` | UPDATE | admin, boss | ✓ OK |
| `ad_spend_admin_delete` | DELETE | admin, boss | ✓ OK |

**Issues:**
- ⚠️ Naming doesn't follow `policy_表名_操作_角色` pattern exactly
- ✓ **No FOR ALL violations** (good)
- ✓ Clear role separation

---

## 2. Policy Count Summary

| Table | SELECT | INSERT | UPDATE | DELETE | ALL | Total | Status |
|-------|--------|--------|--------|--------|-----|-------|--------|
| profiles | 1 | 0 | 1 | 0 | 1 | 3 | ❌ Has FOR ALL |
| leads | 3 | 2 | 2 | 1 | 0 | 8 | ⚠️ Duplicates |
| customers | 2 | 0 | 0 | 0 | 2 | 4 | ❌ Has FOR ALL |
| contracts | 2 | 0 | 0 | 0 | 1 | 3 | ❌ Has FOR ALL |
| tasks | 0 | 0 | 0 | 0 | 2 | 2 | ❌ Has FOR ALL |
| follow_up_logs | 1 | 1 | 1 | 1 | 0 | 4 | ✅ Good |
| pipeline_stages | 3 | 1 | 1 | 1 | 0 | 6 | ✅ **Perfect** |
| payments | 1 | 0 | 0 | 0 | 1 | 2 | ❌ Has FOR ALL |
| quotations | 1 | 1 | 1 | 1 | 1 | 5 | ❌ Has FOR ALL |
| products | 1 | 1 | 1 | 1 | 1 | 5 | ❌ Has FOR ALL |
| projects | 1 | 0 | 0 | 0 | 2 | 3 | ❌ Has FOR ALL |
| activities | 3 | 3 | 1 | 0 | 2 | 9 | ❌ Has FOR ALL |
| notifications | 2 | 1 | 1 | 0 | 0 | 4 | ✅ Good |
| ad_spend | 1 | 1 | 1 | 1 | 0 | 4 | ✅ Good |

**Total Policies:** 62  
**Tables with FOR ALL:** 9 out of 14 (64%) ❌  
**Tables without FOR ALL:** 5 out of 14 (36%) ✅

---

## 3. FOR ALL Policy Violations (CRITICAL)

**Hard Rule:** No FOR ALL policies allowed - must use explicit SELECT/INSERT/UPDATE/DELETE

### Violations Found: 14 FOR ALL policies

| Table | Policy Name | Roles |
|-------|-------------|-------|
| profiles | `profiles_admin_all` | admin, boss |
| customers | `customers_admin_all` | admin, boss, operator |
| customers | `customer_admin` | admin, manager |
| contracts | `contracts_admin_all` | admin, boss, operator |
| tasks | `tasks_own` | Self |
| tasks | `tasks_admin` | admin, boss |
| payments | `payments_admin_all` | admin, boss, operator, finance |
| quotations | `quotations_admin_all` | admin, boss, operator |
| products | `products_auth_all` | All authenticated |
| projects | `projects_admin_operator_all` | admin, boss, operator |
| projects | `project_admin` | admin, manager |
| activities | `activities_admin_all` | admin, boss, operator |
| activities | `activity_admin` | admin, manager |

**Impact:** FOR ALL policies bypass granular permission control and make it harder to audit who can do what.

---

## 4. Naming Convention Violations

**Standard:** `policy_表名_操作_角色`  
**Example:** `policy_pipeline_stages_select_admin`

### Compliant Policies: 6 (10%)
All from `pipeline_stages` table:
- ✅ `policy_pipeline_stages_select_admin`
- ✅ `policy_pipeline_stages_select_manager`
- ✅ `policy_pipeline_stages_select_sales`
- ✅ `policy_pipeline_stages_insert_admin`
- ✅ `policy_pipeline_stages_update_admin`
- ✅ `policy_pipeline_stages_delete_admin`

### Non-Compliant Policies: 56 (90%)

**Common Issues:**
1. Missing `policy_` prefix
2. Missing role suffix (e.g., `_admin`, `_sales`)
3. Using descriptive names instead of structured format
4. Spaces in policy names
5. Mixing old and new naming conventions

**Examples of violations:**
- ❌ `profile_self` (missing prefix, no role)
- ❌ `leads_admin_all` (says "all" but is SELECT)
- ❌ `customers_admin_all` (FOR ALL violation + bad naming)
- ❌ `Users can view activities` (spaces, no structure)
- ❌ `ad_spend_admin_select` (close but missing `policy_` prefix)

---

## 5. Role Permission Matrix

### Admin Role
**Access:** Full access to all tables  
**Implementation:** Usually via `role IN ('admin', 'boss')` checks

### Boss Role
**Access:** Same as admin  
**Implementation:** Grouped with admin in most policies

### Manager Role
**Access:** Varies by table  
**Tables with access:**
- ✅ leads (SELECT, UPDATE)
- ✅ customers (SELECT via admin policy)
- ✅ contracts (SELECT via admin policy)
- ✅ activities (SELECT, INSERT)
- ⚠️ Inconsistent - sometimes grouped with admin, sometimes separate

### Sales Role
**Access:** Limited to own records  
**Tables with access:**
- ✅ leads (own records via assigned_to)
- ✅ customers (own records via assigned_sales_id or lead assignment)
- ✅ contracts (own records via sales_id)
- ✅ activities (own records via user_id)
- ✅ quotations (own records via created_by)
- ✅ products (SELECT only - read-only)
- ✅ pipeline_stages (SELECT only - read-only)

### Designer Role
**Access:** Not explicitly defined in most policies  
**Issue:** ⚠️ Designer role mentioned in profiles table but rarely granted access elsewhere

### Operator Role
**Access:** Similar to admin in many tables  
**Tables with access:**
- ✅ leads (SELECT, UPDATE)
- ✅ customers (ALL via admin policy)
- ✅ contracts (ALL via admin policy)
- ✅ activities (ALL via admin policy)
- ✅ payments (ALL via admin policy)
- ✅ quotations (ALL via admin policy)
- ✅ projects (ALL via admin policy)

### Finance Role
**Access:** Financial tables only  
**Tables with access:**
- ✅ contracts (SELECT)
- ✅ payments (ALL via admin policy)
- ✅ installment_plans (ALL via admin policy)

---

## 6. Recommendations

### Critical (Must Fix)

1. **Replace all FOR ALL policies** with explicit SELECT/INSERT/UPDATE/DELETE policies
   - 14 policies need to be split
   - Use `pipeline_stages` as the reference implementation

2. **Standardize naming convention** across all tables
   - Adopt `policy_表名_操作_角色` format
   - Rename all 56 non-compliant policies

3. **Remove duplicate policies**
   - `leads`: Multiple overlapping SELECT policies
   - `customers`: Duplicate admin policies
   - `activities`: Multiple overlapping policies with different names

### High Priority

4. **Fix overly permissive policies**
   - `Users can view activities` - USING(true) is too permissive
   - `Authenticated users can insert activities` - WITH CHECK(true) is too permissive
   - `products_auth_all` - FOR ALL to all authenticated users

5. **Clarify designer role permissions**
   - Currently undefined in most tables
   - Should have explicit SELECT access to relevant tables

6. **Remove policies with spaces in names**
   - Replace with underscored versions
   - Follow naming convention

### Medium Priority

7. **Add missing operation-specific policies**
   - `tasks`: Currently only has FOR ALL, needs SELECT/INSERT/UPDATE/DELETE
   - `payments`: Missing INSERT/UPDATE/DELETE for sales role

8. **Document role permissions**
   - Create a permissions matrix document
   - Clarify what each role can do on each table

9. **Consolidate role checks**
   - Create helper functions for common role checks
   - Reduce duplication in policy definitions

---

## 7. Migration Plan

### Phase 1: Fix Critical Tables (Week 1)
1. `profiles` - Split FOR ALL into 4 operations
2. `tasks` - Split FOR ALL into 4 operations
3. `leads` - Consolidate and rename policies
4. `customers` - Split FOR ALL and remove duplicates

### Phase 2: Fix Financial Tables (Week 2)
1. `contracts` - Split FOR ALL into 4 operations
2. `payments` - Split FOR ALL and add sales policies
3. `quotations` - Split FOR ALL and standardize naming

### Phase 3: Fix Remaining Tables (Week 3)
1. `activities` - Split FOR ALL, remove duplicates, fix permissive policies
2. `projects` - Split FOR ALL into 4 operations
3. `products` - Split FOR ALL and fix redundancy

### Phase 4: Polish (Week 4)
1. `notifications` - Standardize naming
2. `ad_spend` - Add `policy_` prefix
3. Test all policies with different roles
4. Document final permission matrix

---

## 8. Validation Script

Run this SQL to verify fixes:

```sql
-- Check for FOR ALL policies (should return 0 rows)
SELECT tablename, policyname, cmd
FROM pg_policies 
WHERE schemaname = 'public'
AND tablename IN ('profiles', 'leads', 'customers', 'contracts', 'tasks', 
                  'follow_up_logs', 'pipeline_stages', 'payments', 'quotations', 
                  'products', 'projects', 'activities', 'notifications', 'ad_spend')
AND cmd = 'ALL';

-- Check naming convention compliance
SELECT tablename, policyname, cmd,
    CASE 
        WHEN policyname ~* '^policy_[a-z_]+_(select|insert|update|delete)_[a-z]+$' 
        THEN '✓ OK'
        ELSE '❌ Non-standard'
    END AS naming_status
FROM pg_policies 
WHERE schemaname = 'public'
AND tablename IN ('profiles', 'leads', 'customers', 'contracts', 'tasks', 
                  'follow_up_logs', 'pipeline_stages', 'payments', 'quotations', 
                  'products', 'projects', 'activities', 'notifications', 'ad_spend')
ORDER BY tablename, policyname;
```

---

## 9. Conclusion

**Current State:** ❌ **Not Production Ready**
- 14 FOR ALL policy violations
- 90% naming convention violations
- Multiple duplicate/overlapping policies
- Inconsistent role permissions

**Target State:** ✅ **Production Ready**
- 0 FOR ALL policies
- 100% naming convention compliance
- No duplicate policies
- Clear role permission matrix

**Effort Estimate:** 2-3 weeks of focused work
**Risk Level:** HIGH - Current state has security and maintainability issues

**Reference Implementation:** Use `pipeline_stages` table as the gold standard for all other tables.

---

**Report Generated By:** Hermes Agent  
**Analysis Method:** Static analysis of migration SQL files  
**Limitation:** Could not connect to live database for runtime verification  
**Recommendation:** Run validation script against production database to confirm findings
