-- ================================================
-- CRM v3 — Seed Data (Dev 环境)
-- 从生产导出20条lead，匿名化后导入dev
-- 覆盖各 milestone 阶段
-- ================================================
-- FIXED 2026-08-11: the first statement below was
--     UPDATE leads SET ... WHERE customer_name NOT IN (...) LIMIT 20;
-- PostgreSQL does not accept LIMIT on UPDATE — it is a MySQL extension — so this
-- file raised a syntax error every time it was read, which means it has never
-- seeded anything, in any environment. It went unnoticed because `supabase db
-- reset` was only ever run against supabase/ci-local, which has its own workdir
-- and does not use this file.
--
-- Rewritten as a subquery, the standard way to bound an UPDATE. ORDER BY id makes
-- the choice of 20 rows deterministic rather than dependent on physical row
-- order, so two resets produce the same fixture.
-- ================================================

-- 匿名化客户名称和电话
UPDATE leads SET
  customer_name = 'Test Client ' || substring(id::text, 1, 4),
  phone = '+971 50 XXX XXXX',
  email = NULL
WHERE id IN (
  SELECT id
  FROM leads
  WHERE customer_name NOT IN ('Tanya', 'Ayana', 'SAM')
  ORDER BY id
  LIMIT 20
);

-- 为没有 current_milestone 的leads设置初始milestone
UPDATE leads SET current_milestone = 'new'
WHERE current_milestone IS NULL AND (final_status IS NULL OR final_status NOT IN ('won', 'lost'));
