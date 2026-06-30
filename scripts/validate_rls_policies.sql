-- RLS Policy Validation Script
-- Task 4.2 + 4.3: 权限测试 + RLS 策略验证
-- Generated: 2026-06-30

-- ============================================================================
-- 1. Query all RLS policies for the 13 core tables
-- ============================================================================
SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles::text,
    cmd,
    CASE 
        WHEN cmd = 'ALL' THEN '❌ VIOLATION: FOR ALL not allowed'
        ELSE '✓ OK'
    END AS validation_status
FROM pg_policies 
WHERE schemaname = 'public'
AND tablename IN (
    'profiles', 'leads', 'customers', 'contracts', 'tasks', 'follow_up_logs',
    'pipeline_stages', 'payments', 'quotations', 'products', 'projects',
    'activities', 'notifications', 'ad_spend'
)
ORDER BY tablename, cmd, policyname;

-- ============================================================================
-- 2. Count policies per table (by operation type)
-- ============================================================================
SELECT 
    tablename,
    COUNT(*) FILTER (WHERE cmd = 'SELECT') AS select_count,
    COUNT(*) FILTER (WHERE cmd = 'INSERT') AS insert_count,
    COUNT(*) FILTER (WHERE cmd = 'UPDATE') AS update_count,
    COUNT(*) FILTER (WHERE cmd = 'DELETE') AS delete_count,
    COUNT(*) FILTER (WHERE cmd = 'ALL') AS all_count,
    COUNT(*) AS total_policies
FROM pg_policies 
WHERE schemaname = 'public'
AND tablename IN (
    'profiles', 'leads', 'customers', 'contracts', 'tasks', 'follow_up_logs',
    'pipeline_stages', 'payments', 'quotations', 'products', 'projects',
    'activities', 'notifications', 'ad_spend'
)
GROUP BY tablename
ORDER BY tablename;

-- ============================================================================
-- 3. Check for FOR ALL policies (should be 0)
-- ============================================================================
SELECT 
    tablename,
    policyname,
    cmd,
    '❌ CRITICAL: FOR ALL policy found' AS issue
FROM pg_policies 
WHERE schemaname = 'public'
AND tablename IN (
    'profiles', 'leads', 'customers', 'contracts', 'tasks', 'follow_up_logs',
    'pipeline_stages', 'payments', 'quotations', 'products', 'projects',
    'activities', 'notifications', 'ad_spend'
)
AND cmd = 'ALL'
ORDER BY tablename, policyname;

-- ============================================================================
-- 4. Check naming convention: policy_表名_操作_角色
-- ============================================================================
SELECT 
    tablename,
    policyname,
    cmd,
    CASE 
        WHEN policyname ~* '^policy_[a-z_]+_(select|insert|update|delete)_[a-z]+$' 
        THEN '✓ OK'
        ELSE '⚠ WARNING: Non-standard naming'
    END AS naming_validation
FROM pg_policies 
WHERE schemaname = 'public'
AND tablename IN (
    'profiles', 'leads', 'customers', 'contracts', 'tasks', 'follow_up_logs',
    'pipeline_stages', 'payments', 'quotations', 'products', 'projects',
    'activities', 'notifications', 'ad_spend'
)
ORDER BY tablename, policyname;

-- ============================================================================
-- 5. Verify RLS is enabled on all 13 tables
-- ============================================================================
SELECT 
    schemaname,
    tablename,
    rowsecurity AS rls_enabled,
    CASE 
        WHEN rowsecurity = true THEN '✓ OK'
        ELSE '❌ CRITICAL: RLS not enabled'
    END AS validation_status
FROM pg_tables 
WHERE schemaname = 'public'
AND tablename IN (
    'profiles', 'leads', 'customers', 'contracts', 'tasks', 'follow_up_logs',
    'pipeline_stages', 'payments', 'quotations', 'products', 'projects',
    'activities', 'notifications', 'ad_spend'
)
ORDER BY tablename;

-- ============================================================================
-- 6. Check which tables are missing from the 13 core tables
-- ============================================================================
SELECT 
    'profiles' AS expected_table,
    CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'profiles' AND schemaname = 'public') 
    THEN '✓ EXISTS' ELSE '❌ MISSING' END AS status
UNION ALL
SELECT 'leads', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'leads' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'customers', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'customers' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'contracts', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'contracts' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'tasks', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'tasks' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'follow_up_logs', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'follow_up_logs' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'pipeline_stages', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'pipeline_stages' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'payments', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'payments' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'quotations', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'quotations' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'products', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'products' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'projects', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'projects' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'activities', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'activities' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'notifications', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'notifications' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
UNION ALL
SELECT 'ad_spend', CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'ad_spend' AND schemaname = 'public') THEN '✓ EXISTS' ELSE '❌ MISSING' END
ORDER BY expected_table;
