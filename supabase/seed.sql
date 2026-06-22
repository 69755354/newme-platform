-- ================================================
-- CRM v3 — Seed Data (Dev 环境)
-- 从生产导出20条lead，匿名化后导入dev
-- 覆盖各 milestone 阶段
-- ================================================

-- 匿名化客户名称和电话
UPDATE leads SET
  customer_name = 'Test Client ' || substring(id::text, 1, 4),
  phone = '+971 50 XXX XXXX',
  email = NULL
WHERE customer_name NOT IN ('Tanya', 'Ayana', 'SAM')
LIMIT 20;

-- 为没有 current_milestone 的leads设置初始milestone
UPDATE leads SET current_milestone = 'new'
WHERE current_milestone IS NULL AND (final_status IS NULL OR final_status NOT IN ('won', 'lost'));
