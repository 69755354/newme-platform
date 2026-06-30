-- ============================================================================
-- Migration: 最后 4 张核心表 FOR ALL 策略清理
-- Date: 2026-07-01
-- Fixes: 清理 customers, projects, activities, products 上的 FOR ALL 策略
--         替换为明确的 per-operation per-role 策略（6 角色矩阵）
-- 目标: 全库 FOR ALL = 0
-- 说明: 本 migration 为幂等的 — 先清理再重建所有策略
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. customers (客户)
-- 权限矩阵: admin/boss/operator CRUD, sales 读写自己的, finance 只读, designer 只读
-- 所有权: customers.assigned_sales_id = auth.uid()
-- ============================================================================

-- 清理所有旧策略（包括之前可能已创建的 per-operation 策略，确保幂等）
DROP POLICY IF EXISTS "customer_admin" ON customers;
DROP POLICY IF EXISTS "customers_admin_all" ON customers;
DROP POLICY IF EXISTS "customer_sales" ON customers;
DROP POLICY IF EXISTS "customers_sales_see" ON customers;
DROP POLICY IF EXISTS "policy_customers_select_admin" ON customers;
DROP POLICY IF EXISTS "policy_customers_select_finance" ON customers;
DROP POLICY IF EXISTS "policy_customers_select_designer" ON customers;
DROP POLICY IF EXISTS "policy_customers_select_sales" ON customers;
DROP POLICY IF EXISTS "policy_customers_insert_admin" ON customers;
DROP POLICY IF EXISTS "policy_customers_insert_sales" ON customers;
DROP POLICY IF EXISTS "policy_customers_update_admin" ON customers;
DROP POLICY IF EXISTS "policy_customers_update_sales" ON customers;
DROP POLICY IF EXISTS "policy_customers_delete_admin" ON customers;

-- SELECT: admin/boss/operator 可查看所有客户
CREATE POLICY policy_customers_select_admin
  ON customers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: finance 可查看所有客户(财务审核需要)
CREATE POLICY policy_customers_select_finance
  ON customers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- SELECT: designer 可查看所有客户(项目设计需要)
CREATE POLICY policy_customers_select_designer
  ON customers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- SELECT: sales 只能查看自己 assigned 的客户
CREATE POLICY policy_customers_select_sales
  ON customers FOR SELECT TO authenticated
  USING (assigned_sales_id = auth.uid());

-- INSERT: admin/boss/operator 可创建任何客户
CREATE POLICY policy_customers_insert_admin
  ON customers FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales 可创建客户(自动 assigned 给自己)
CREATE POLICY policy_customers_insert_sales
  ON customers FOR INSERT TO authenticated
  WITH CHECK (assigned_sales_id = auth.uid());

-- UPDATE: admin/boss/operator 可更新任何客户
CREATE POLICY policy_customers_update_admin
  ON customers FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales 可更新自己 assigned 的客户
CREATE POLICY policy_customers_update_sales
  ON customers FOR UPDATE TO authenticated
  USING (assigned_sales_id = auth.uid())
  WITH CHECK (assigned_sales_id = auth.uid());

-- DELETE: admin/boss 可删除客户
CREATE POLICY policy_customers_delete_admin
  ON customers FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 2. projects (项目)
-- 权限矩阵: admin/boss/operator CRUD, sales 读写自己的, designer 只读
-- 所有权: projects.sales_id = auth.uid()
-- ============================================================================

-- 清理所有旧策略
DROP POLICY IF EXISTS "project_admin" ON projects;
DROP POLICY IF EXISTS "projects_admin_operator_all" ON projects;
DROP POLICY IF EXISTS "project_sales_see" ON projects;
DROP POLICY IF EXISTS "projects_sales_see" ON projects;
DROP POLICY IF EXISTS "policy_projects_select_admin" ON projects;
DROP POLICY IF EXISTS "policy_projects_select_designer" ON projects;
DROP POLICY IF EXISTS "policy_projects_select_sales" ON projects;
DROP POLICY IF EXISTS "policy_projects_insert_admin" ON projects;
DROP POLICY IF EXISTS "policy_projects_insert_sales" ON projects;
DROP POLICY IF EXISTS "policy_projects_update_admin" ON projects;
DROP POLICY IF EXISTS "policy_projects_update_sales" ON projects;
DROP POLICY IF EXISTS "policy_projects_delete_admin" ON projects;

-- SELECT: admin/boss/operator 可查看所有项目
CREATE POLICY policy_projects_select_admin
  ON projects FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: designer 可查看所有项目(设计工作需要)
CREATE POLICY policy_projects_select_designer
  ON projects FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- SELECT: sales 只能查看自己的项目
CREATE POLICY policy_projects_select_sales
  ON projects FOR SELECT TO authenticated
  USING (sales_id = auth.uid());

-- INSERT: admin/boss/operator 可创建任何项目
CREATE POLICY policy_projects_insert_admin
  ON projects FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales 可创建项目(自动 sales_id 为自己)
CREATE POLICY policy_projects_insert_sales
  ON projects FOR INSERT TO authenticated
  WITH CHECK (sales_id = auth.uid());

-- UPDATE: admin/boss/operator 可更新任何项目
CREATE POLICY policy_projects_update_admin
  ON projects FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales 可更新自己的项目
CREATE POLICY policy_projects_update_sales
  ON projects FOR UPDATE TO authenticated
  USING (sales_id = auth.uid())
  WITH CHECK (sales_id = auth.uid());

-- DELETE: admin/boss 可删除项目
CREATE POLICY policy_projects_delete_admin
  ON projects FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 3. activities (跟进活动)
-- 权限矩阵: admin/boss/operator CRUD, sales 读写自己的, finance 只读, designer 只读
-- 所有权: activities.user_id = auth.uid() (写), lead_id → leads.assigned_to (读)
-- ============================================================================

-- 清理所有旧策略
DROP POLICY IF EXISTS "activity_admin" ON activities;
DROP POLICY IF EXISTS "activities_admin_all" ON activities;
DROP POLICY IF EXISTS "activity_sales_see" ON activities;
DROP POLICY IF EXISTS "activity_sales_create" ON activities;
DROP POLICY IF EXISTS "activity_sales_create_on_lead" ON activities;
DROP POLICY IF EXISTS "activities_sales_select" ON activities;
DROP POLICY IF EXISTS "activities_sales_insert" ON activities;
DROP POLICY IF EXISTS "activities_sales_update" ON activities;
DROP POLICY IF EXISTS "Authenticated users can insert activities" ON activities;
DROP POLICY IF EXISTS "Users can view activities" ON activities;
DROP POLICY IF EXISTS "policy_activities_select_admin" ON activities;
DROP POLICY IF EXISTS "policy_activities_select_finance" ON activities;
DROP POLICY IF EXISTS "policy_activities_select_designer" ON activities;
DROP POLICY IF EXISTS "policy_activities_select_sales" ON activities;
DROP POLICY IF EXISTS "policy_activities_insert_admin" ON activities;
DROP POLICY IF EXISTS "policy_activities_insert_sales" ON activities;
DROP POLICY IF EXISTS "policy_activities_update_admin" ON activities;
DROP POLICY IF EXISTS "policy_activities_update_sales" ON activities;
DROP POLICY IF EXISTS "policy_activities_delete_admin" ON activities;

-- SELECT: admin/boss/operator 可查看所有活动
CREATE POLICY policy_activities_select_admin
  ON activities FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: finance 可查看所有活动(审计需要)
CREATE POLICY policy_activities_select_finance
  ON activities FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- SELECT: designer 可查看所有活动(设计协作需要)
CREATE POLICY policy_activities_select_designer
  ON activities FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- SELECT: sales 只能看自己 lead 的活动
CREATE POLICY policy_activities_select_sales
  ON activities FOR SELECT TO authenticated
  USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- INSERT: admin/boss/operator 可创建任何活动
CREATE POLICY policy_activities_insert_admin
  ON activities FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales 可创建活动(user_id 设为自身)
CREATE POLICY policy_activities_insert_sales
  ON activities FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- UPDATE: admin/boss/operator 可更新任何活动
CREATE POLICY policy_activities_update_admin
  ON activities FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales 可更新自己创建的活动
CREATE POLICY policy_activities_update_sales
  ON activities FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- DELETE: admin/boss 可删除活动
CREATE POLICY policy_activities_delete_admin
  ON activities FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 4. products (产品)
-- 权限矩阵: admin/boss/operator CRUD, sales 只读, finance 只读, designer 只读
-- ============================================================================

-- 清理所有旧策略
DROP POLICY IF EXISTS "products_admin_all" ON products;
DROP POLICY IF EXISTS "products_auth_all" ON products;
DROP POLICY IF EXISTS "products_sales_select" ON products;
DROP POLICY IF EXISTS "products_select_all" ON products;
DROP POLICY IF EXISTS "products_insert_admin_boss" ON products;
DROP POLICY IF EXISTS "products_update_admin_boss" ON products;
DROP POLICY IF EXISTS "products_delete_admin_boss" ON products;
DROP POLICY IF EXISTS "policy_products_select_admin" ON products;
DROP POLICY IF EXISTS "policy_products_select_finance" ON products;
DROP POLICY IF EXISTS "policy_products_select_designer" ON products;
DROP POLICY IF EXISTS "policy_products_select_sales" ON products;
DROP POLICY IF EXISTS "policy_products_insert_admin" ON products;
DROP POLICY IF EXISTS "policy_products_update_admin" ON products;
DROP POLICY IF EXISTS "policy_products_delete_admin" ON products;
DROP POLICY IF EXISTS "products_all_select" ON products;
DROP POLICY IF EXISTS "products_all_insert" ON products;
DROP POLICY IF EXISTS "products_all_update" ON products;
DROP POLICY IF EXISTS "products_all_delete" ON products;

-- SELECT: admin/boss/operator 可查看所有产品
CREATE POLICY policy_products_select_admin
  ON products FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: finance 可查看所有产品(成本核算需要)
CREATE POLICY policy_products_select_finance
  ON products FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- SELECT: designer 可查看所有产品(设计选材需要)
CREATE POLICY policy_products_select_designer
  ON products FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- SELECT: sales 可查看所有产品(报价需要)
CREATE POLICY policy_products_select_sales
  ON products FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales'));

-- INSERT: admin/boss/operator 可创建产品
CREATE POLICY policy_products_insert_admin
  ON products FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: admin/boss/operator 可更新产品
CREATE POLICY policy_products_update_admin
  ON products FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- DELETE: admin/boss 可删除产品
CREATE POLICY policy_products_delete_admin
  ON products FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

COMMIT;
