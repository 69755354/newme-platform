-- =============================================================================
-- RLS Policy Remediation - Complete Fix
-- Date: 2026-06-30
-- Fixes: blanket-policy cleanup, missing policies, designer role, naming consistency,
--        transaction safety, IF EXISTS/IF NOT EXISTS guards
-- =============================================================================

BEGIN;

-- =============================================================================
-- PHASE 1: Drop ALL old policies (including 18 blanket policies)
-- =============================================================================

-- profiles (old policies)
DROP POLICY IF EXISTS profile_self ON profiles;
DROP POLICY IF EXISTS profiles_admin_all ON profiles;
DROP POLICY IF EXISTS profiles_update_self ON profiles;
DROP POLICY IF EXISTS profiles_for_all ON profiles;
DROP POLICY IF EXISTS "Default deny all" ON profiles;

-- leads (old policies)
DROP POLICY IF EXISTS leads_admin_boss_operator_all ON leads;
DROP POLICY IF EXISTS leads_admin_all ON leads;
DROP POLICY IF EXISTS leads_sales_select ON leads;
DROP POLICY IF EXISTS leads_sales_update ON leads;
DROP POLICY IF EXISTS leads_manager_select ON leads;
DROP POLICY IF EXISTS sales_create_leads ON leads;
DROP POLICY IF EXISTS sales_update_own ON leads;
DROP POLICY IF EXISTS sales_delete_own ON leads;
DROP POLICY IF EXISTS leads_for_all ON leads;
DROP POLICY IF EXISTS leads_all_admin ON leads;
DROP POLICY IF EXISTS "Default deny all" ON leads;

-- customers (old policies)
DROP POLICY IF EXISTS customers_admin_all ON customers;
DROP POLICY IF EXISTS customers_sales_own ON customers;
DROP POLICY IF EXISTS customers_sales_see ON customers;
DROP POLICY IF EXISTS customers_for_all ON customers;
DROP POLICY IF EXISTS customers_all_admin ON customers;
DROP POLICY IF EXISTS "Default deny all" ON customers;

-- contracts (old policies)
DROP POLICY IF EXISTS contracts_admin_all ON contracts;
DROP POLICY IF EXISTS contracts_sales_select ON contracts;
DROP POLICY IF EXISTS contracts_finance_select ON contracts;
DROP POLICY IF EXISTS contracts_for_all ON contracts;
DROP POLICY IF EXISTS contracts_all_admin ON contracts;
DROP POLICY IF EXISTS "Default deny all" ON contracts;

-- tasks (old policies)
DROP POLICY IF EXISTS tasks_admin ON tasks;
DROP POLICY IF EXISTS tasks_own ON tasks;
DROP POLICY IF EXISTS tasks_for_all ON tasks;
DROP POLICY IF EXISTS "Default deny all" ON tasks;

-- follow_up_logs (old policies)
DROP POLICY IF EXISTS follow_up_logs_insert ON follow_up_logs;
DROP POLICY IF EXISTS follow_up_logs_select ON follow_up_logs;
DROP POLICY IF EXISTS follow_up_logs_create ON follow_up_logs;
DROP POLICY IF EXISTS follow_up_logs_no_update ON follow_up_logs;
DROP POLICY IF EXISTS follow_up_logs_no_delete ON follow_up_logs;
DROP POLICY IF EXISTS follow_up_logs_for_all ON follow_up_logs;
DROP POLICY IF EXISTS "Default deny all" ON follow_up_logs;

-- payments (old policies)
DROP POLICY IF EXISTS payments_admin_all ON payments;
DROP POLICY IF EXISTS payments_sales_select ON payments;
DROP POLICY IF EXISTS payments_for_all ON payments;
DROP POLICY IF EXISTS payments_all_admin ON payments;
DROP POLICY IF EXISTS "Default deny all" ON payments;

-- activities (old policies)
DROP POLICY IF EXISTS activities_admin_all ON activities;
DROP POLICY IF EXISTS activities_sales_own ON activities;
DROP POLICY IF EXISTS activities_sales_select ON activities;
DROP POLICY IF EXISTS activities_for_all ON activities;
DROP POLICY IF EXISTS activities_all_admin ON activities;
DROP POLICY IF EXISTS "Default deny all" ON activities;

-- quotations (old policies)
DROP POLICY IF EXISTS quotations_admin_all ON quotations;
DROP POLICY IF EXISTS quotations_sales_own ON quotations;
DROP POLICY IF EXISTS quotations_sales_select ON quotations;
DROP POLICY IF EXISTS quotations_sales_insert ON quotations;
DROP POLICY IF EXISTS quotations_sales_update ON quotations;
DROP POLICY IF EXISTS quotations_creator_delete_own ON quotations;
DROP POLICY IF EXISTS quotations_for_all ON quotations;
DROP POLICY IF EXISTS "Default deny all" ON quotations;

-- products (old policies)
DROP POLICY IF EXISTS products_admin_all ON products;
DROP POLICY IF EXISTS products_sales_select ON products;
DROP POLICY IF EXISTS products_select_all ON products;
DROP POLICY IF EXISTS products_insert_admin_boss ON products;
DROP POLICY IF EXISTS products_update_admin_boss ON products;
DROP POLICY IF EXISTS products_delete_admin_boss ON products;
DROP POLICY IF EXISTS products_for_all ON products;
DROP POLICY IF EXISTS "Default deny all" ON products;

-- projects (old policies)
DROP POLICY IF EXISTS projects_admin_all ON projects;
DROP POLICY IF EXISTS projects_admin_operator_all ON projects;
DROP POLICY IF EXISTS projects_sales_own ON projects;
DROP POLICY IF EXISTS projects_sales_see ON projects;
DROP POLICY IF EXISTS projects_for_all ON projects;
DROP POLICY IF EXISTS projects_all_admin ON projects;
DROP POLICY IF EXISTS "Default deny all" ON projects;

-- notifications (old policies)
DROP POLICY IF EXISTS notifications_user_read ON notifications;
DROP POLICY IF EXISTS notifications_admin_read_all ON notifications;
DROP POLICY IF EXISTS notifications_user_update ON notifications;
DROP POLICY IF EXISTS notifications_service_insert ON notifications;
DROP POLICY IF EXISTS notifications_for_all ON notifications;
DROP POLICY IF EXISTS "Default deny all" ON notifications;

-- ad_spend (old policies)
DROP POLICY IF EXISTS boss_admin_read_ad_spend ON ad_spend;
DROP POLICY IF EXISTS boss_admin_insert_ad_spend ON ad_spend;
DROP POLICY IF EXISTS ad_spend_for_all ON ad_spend;
DROP POLICY IF EXISTS "Default deny all" ON ad_spend;

-- lead_documents (old policies if any)
DROP POLICY IF EXISTS lead_documents_for_all ON lead_documents;
DROP POLICY IF EXISTS "Default deny all" ON lead_documents;

-- =============================================================================
-- PHASE 2: Create policies for profiles (7 policies)
-- =============================================================================

-- SELECT: users can see their own profile
CREATE POLICY policy_profiles_select_self
  ON profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

-- SELECT: admin/boss can see all profiles
CREATE POLICY policy_profiles_select_admin
  ON profiles FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- SELECT: operator can see all profiles
CREATE POLICY policy_profiles_select_operator
  ON profiles FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- INSERT: admin/boss can create profiles
CREATE POLICY policy_profiles_insert_admin
  ON profiles FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- UPDATE: users can update their own profile (but not role unless admin/boss)
CREATE POLICY policy_profiles_update_self
  ON profiles FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid() 
    AND (
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','boss'))
      OR role = (SELECT role FROM profiles WHERE id = auth.uid())
    )
  );

-- UPDATE: admin/boss can update any profile
CREATE POLICY policy_profiles_update_admin
  ON profiles FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: admin/boss can delete profiles
CREATE POLICY policy_profiles_delete_admin
  ON profiles FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- =============================================================================
-- PHASE 3: Create policies for leads (9 policies)
-- =============================================================================

-- SELECT: admin/boss/operator can see all leads
CREATE POLICY policy_leads_select_admin
  ON leads FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: sales can see their own leads
CREATE POLICY policy_leads_select_sales
  ON leads FOR SELECT TO authenticated
  USING (assigned_to = auth.uid());

-- INSERT: admin/boss/operator can create any lead
CREATE POLICY policy_leads_insert_admin
  ON leads FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales can create leads assigned to themselves or unassigned
CREATE POLICY policy_leads_insert_sales
  ON leads FOR INSERT TO authenticated
  WITH CHECK (assigned_to = auth.uid() OR assigned_to IS NULL);

-- UPDATE: admin/boss/operator can update any lead
CREATE POLICY policy_leads_update_admin
  ON leads FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales can update their own leads
CREATE POLICY policy_leads_update_sales
  ON leads FOR UPDATE TO authenticated
  USING (assigned_to = auth.uid());

-- DELETE: admin/boss can delete leads
CREATE POLICY policy_leads_delete_admin
  ON leads FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: sales can delete their own leads
CREATE POLICY policy_leads_delete_sales
  ON leads FOR DELETE TO authenticated
  USING (assigned_to = auth.uid());

-- INSERT: boss can create leads (explicit)
CREATE POLICY policy_leads_insert_boss
  ON leads FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- =============================================================================
-- PHASE 4: Create policies for customers (10 policies)
-- =============================================================================

-- SELECT: admin/boss/operator can see all customers
CREATE POLICY policy_customers_select_admin
  ON customers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: sales can see their own customers
CREATE POLICY policy_customers_select_sales
  ON customers FOR SELECT TO authenticated
  USING (assigned_sales_id = auth.uid());

-- INSERT: admin/boss/operator can create customers
CREATE POLICY policy_customers_insert_admin
  ON customers FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales can create customers assigned to themselves
CREATE POLICY policy_customers_insert_sales
  ON customers FOR INSERT TO authenticated
  WITH CHECK (assigned_sales_id = auth.uid());

-- UPDATE: admin/boss/operator can update any customer
CREATE POLICY policy_customers_update_admin
  ON customers FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales can update their own customers
CREATE POLICY policy_customers_update_sales
  ON customers FOR UPDATE TO authenticated
  USING (assigned_sales_id = auth.uid());

-- DELETE: admin/boss can delete customers
CREATE POLICY policy_customers_delete_admin
  ON customers FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- SELECT: finance can see all customers
CREATE POLICY policy_customers_select_finance
  ON customers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- DELETE: sales can delete their own customers
CREATE POLICY policy_customers_delete_sales
  ON customers FOR DELETE TO authenticated
  USING (assigned_sales_id = auth.uid());

-- UPDATE: boss can update any customer (explicit)
CREATE POLICY policy_customers_update_boss
  ON customers FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- =============================================================================
-- PHASE 5: Create policies for contracts (11 policies)
-- =============================================================================

-- SELECT: admin/boss/operator can see all contracts
CREATE POLICY policy_contracts_select_admin
  ON contracts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: sales can see their own contracts
CREATE POLICY policy_contracts_select_sales
  ON contracts FOR SELECT TO authenticated
  USING (sales_id = auth.uid());

-- SELECT: finance can see all contracts
CREATE POLICY policy_contracts_select_finance
  ON contracts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- INSERT: admin/boss/operator can create contracts
CREATE POLICY policy_contracts_insert_admin
  ON contracts FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales can create contracts for their leads
CREATE POLICY policy_contracts_insert_sales
  ON contracts FOR INSERT TO authenticated
  WITH CHECK (sales_id = auth.uid());

-- INSERT: finance can create contracts
CREATE POLICY policy_contracts_insert_finance
  ON contracts FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- UPDATE: admin/boss/operator can update any contract
CREATE POLICY policy_contracts_update_admin
  ON contracts FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales can update their own contracts
CREATE POLICY policy_contracts_update_sales
  ON contracts FOR UPDATE TO authenticated
  USING (sales_id = auth.uid());

-- UPDATE: finance can update contracts
CREATE POLICY policy_contracts_update_finance
  ON contracts FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- DELETE: admin/boss can delete contracts
CREATE POLICY policy_contracts_delete_admin
  ON contracts FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: finance can delete contracts
CREATE POLICY policy_contracts_delete_finance
  ON contracts FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- =============================================================================
-- PHASE 6: Create policies for tasks (12 policies)
-- Note: Using {authenticated} instead of {public}
-- =============================================================================

-- SELECT: admin/boss can see all tasks
CREATE POLICY policy_tasks_select_admin
  ON tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- SELECT: operator can see all tasks
CREATE POLICY policy_tasks_select_operator
  ON tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- SELECT: sales can see tasks for their leads
CREATE POLICY policy_tasks_select_sales
  ON tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leads WHERE id = tasks.lead_id AND assigned_to = auth.uid()));

-- INSERT: admin/boss can create any task
CREATE POLICY policy_tasks_insert_admin
  ON tasks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- INSERT: operator can create any task
CREATE POLICY policy_tasks_insert_operator
  ON tasks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- INSERT: sales can create tasks for their leads
CREATE POLICY policy_tasks_insert_sales
  ON tasks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM leads WHERE id = tasks.lead_id AND assigned_to = auth.uid()));

-- UPDATE: admin/boss can update any task
CREATE POLICY policy_tasks_update_admin
  ON tasks FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- UPDATE: operator can update any task
CREATE POLICY policy_tasks_update_operator
  ON tasks FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- UPDATE: sales can update tasks for their leads
CREATE POLICY policy_tasks_update_sales
  ON tasks FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM leads WHERE id = tasks.lead_id AND assigned_to = auth.uid()));

-- DELETE: admin/boss can delete any task
CREATE POLICY policy_tasks_delete_admin
  ON tasks FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: operator can delete any task
CREATE POLICY policy_tasks_delete_operator
  ON tasks FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- DELETE: sales can delete tasks for their leads
CREATE POLICY policy_tasks_delete_sales
  ON tasks FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM leads WHERE id = tasks.lead_id AND assigned_to = auth.uid()));

-- =============================================================================
-- PHASE 7: Create policies for follow_up_logs (10 policies)
-- =============================================================================

-- SELECT: admin/boss can see all follow-up logs
CREATE POLICY policy_follow_up_logs_select_admin
  ON follow_up_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- SELECT: operator can see all follow-up logs
CREATE POLICY policy_follow_up_logs_select_operator
  ON follow_up_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- SELECT: sales can see logs for their leads
CREATE POLICY policy_follow_up_logs_select_sales
  ON follow_up_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leads WHERE id = follow_up_logs.lead_id AND assigned_to = auth.uid()));

-- INSERT: admin/boss can create any log
CREATE POLICY policy_follow_up_logs_insert_admin
  ON follow_up_logs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- INSERT: operator can create any log
CREATE POLICY policy_follow_up_logs_insert_operator
  ON follow_up_logs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- INSERT: sales can create logs for their leads
CREATE POLICY policy_follow_up_logs_insert_sales
  ON follow_up_logs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM leads WHERE id = follow_up_logs.lead_id AND assigned_to = auth.uid()));

-- UPDATE: deny all (immutable log)
CREATE POLICY policy_follow_up_logs_update_deny
  ON follow_up_logs FOR UPDATE TO authenticated
  USING (false);

-- DELETE: deny all (immutable log)
CREATE POLICY policy_follow_up_logs_delete_deny
  ON follow_up_logs FOR DELETE TO authenticated
  USING (false);

-- SELECT: boss can see all logs (explicit)
CREATE POLICY policy_follow_up_logs_select_boss
  ON follow_up_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- INSERT: boss can create any log (explicit)
CREATE POLICY policy_follow_up_logs_insert_boss
  ON follow_up_logs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- =============================================================================
-- PHASE 8: Create policies for payments (9 policies)
-- =============================================================================

-- SELECT: admin/boss/operator/finance can see all payments
CREATE POLICY policy_payments_select_admin
  ON payments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- SELECT: sales can see payments for their contracts
CREATE POLICY policy_payments_select_sales
  ON payments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM contracts WHERE id = payments.contract_id AND sales_id = auth.uid()));

-- INSERT: admin/boss/operator/finance can create payments
CREATE POLICY policy_payments_insert_admin
  ON payments FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- INSERT: sales can create payments for their contracts
CREATE POLICY policy_payments_insert_sales
  ON payments FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM contracts WHERE id = payments.contract_id AND sales_id = auth.uid()));

-- UPDATE: admin/boss/operator/finance can update payments
CREATE POLICY policy_payments_update_admin
  ON payments FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- UPDATE: sales can update payments for their contracts
CREATE POLICY policy_payments_update_sales
  ON payments FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM contracts WHERE id = payments.contract_id AND sales_id = auth.uid()));

-- DELETE: admin/boss can delete payments
CREATE POLICY policy_payments_delete_admin
  ON payments FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: sales can delete payments for their contracts
CREATE POLICY policy_payments_delete_sales
  ON payments FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM contracts WHERE id = payments.contract_id AND sales_id = auth.uid()));

-- INSERT: finance can create payments (explicit)
CREATE POLICY policy_payments_insert_finance
  ON payments FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- =============================================================================
-- PHASE 9: Create policies for quotations (12 policies)
-- =============================================================================

-- SELECT: admin/boss/operator can see all quotations
CREATE POLICY policy_quotations_select_admin
  ON quotations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: sales can see quotations for their leads
CREATE POLICY policy_quotations_select_sales
  ON quotations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leads WHERE id = quotations.lead_id AND assigned_to = auth.uid()));

-- SELECT: finance can see all quotations
CREATE POLICY policy_quotations_select_finance
  ON quotations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- INSERT: admin/boss/operator can create any quotation
CREATE POLICY policy_quotations_insert_admin
  ON quotations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales can create quotations for their leads
CREATE POLICY policy_quotations_insert_sales
  ON quotations FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (SELECT 1 FROM leads WHERE id = quotations.lead_id AND assigned_to = auth.uid())
  );

-- INSERT: operator can create any quotation (explicit)
CREATE POLICY policy_quotations_insert_operator
  ON quotations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- UPDATE: admin/boss/operator can update any quotation
CREATE POLICY policy_quotations_update_admin
  ON quotations FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales can update their own quotations
CREATE POLICY policy_quotations_update_sales
  ON quotations FOR UPDATE TO authenticated
  USING (created_by = auth.uid());

-- UPDATE: operator can update any quotation (explicit)
CREATE POLICY policy_quotations_update_operator
  ON quotations FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- DELETE: admin/boss/operator can delete any quotation
CREATE POLICY policy_quotations_delete_admin
  ON quotations FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- DELETE: sales can delete their own quotations
CREATE POLICY policy_quotations_delete_sales
  ON quotations FOR DELETE TO authenticated
  USING (created_by = auth.uid());

-- DELETE: operator can delete any quotation (explicit)
CREATE POLICY policy_quotations_delete_operator
  ON quotations FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- =============================================================================
-- PHASE 10: Create policies for products (7 policies + designer)
-- =============================================================================

-- SELECT: any authenticated user can read products
CREATE POLICY policy_products_select_all
  ON products FOR SELECT TO authenticated
  USING (true);

-- INSERT: admin/boss can create products
CREATE POLICY policy_products_insert_admin
  ON products FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- UPDATE: admin/boss can update products
CREATE POLICY policy_products_update_admin
  ON products FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: admin/boss can delete products
CREATE POLICY policy_products_delete_admin
  ON products FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- Designer role: full access to products
-- INSERT: designer can create products
CREATE POLICY policy_products_insert_designer
  ON products FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- UPDATE: designer can update products
CREATE POLICY policy_products_update_designer
  ON products FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- DELETE: designer can delete products
CREATE POLICY policy_products_delete_designer
  ON products FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- =============================================================================
-- PHASE 11: Create policies for projects (9 policies + designer)
-- =============================================================================

-- SELECT: admin/boss/operator can see all projects
CREATE POLICY policy_projects_select_admin
  ON projects FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: sales can see projects they're assigned to
CREATE POLICY policy_projects_select_sales
  ON projects FOR SELECT TO authenticated
  USING (
    assigned_to = auth.uid() 
    OR sales_id = auth.uid() 
    OR project_manager = auth.uid()
  );

-- SELECT: designer can see all projects
CREATE POLICY policy_projects_select_designer
  ON projects FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- INSERT: admin/boss/operator can create projects
CREATE POLICY policy_projects_insert_admin
  ON projects FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: designer can create projects
CREATE POLICY policy_projects_insert_designer
  ON projects FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- UPDATE: admin/boss/operator can update any project
CREATE POLICY policy_projects_update_admin
  ON projects FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales can update projects they're assigned to
CREATE POLICY policy_projects_update_sales
  ON projects FOR UPDATE TO authenticated
  USING (
    sales_id = auth.uid() 
    OR project_manager = auth.uid()
  );

-- UPDATE: designer can update projects
CREATE POLICY policy_projects_update_designer
  ON projects FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- DELETE: admin can delete projects
CREATE POLICY policy_projects_delete_admin
  ON projects FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- =============================================================================
-- PHASE 12: Create policies for activities (10 policies + designer)
-- =============================================================================

-- SELECT: admin/operator can see all activities
CREATE POLICY policy_activities_select_admin
  ON activities FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

-- SELECT: sales can see activities for their leads/contracts/quotations/projects
CREATE POLICY policy_activities_select_sales
  ON activities FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM leads WHERE id = activities.lead_id AND assigned_to = auth.uid())
    OR EXISTS (SELECT 1 FROM contracts WHERE id = activities.contract_id AND sales_id = auth.uid())
    OR EXISTS (SELECT 1 FROM quotations q JOIN leads l ON l.id = q.lead_id WHERE q.id = activities.quotation_id AND l.assigned_to = auth.uid())
    OR EXISTS (SELECT 1 FROM projects WHERE id = activities.project_id AND sales_id = auth.uid())
  );

-- SELECT: designer can see all activities
CREATE POLICY policy_activities_select_designer
  ON activities FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- INSERT: admin/operator can create any activity
CREATE POLICY policy_activities_insert_admin
  ON activities FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

-- INSERT: sales can create activities for their leads/contracts/quotations/projects
CREATE POLICY policy_activities_insert_sales
  ON activities FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (
      EXISTS (SELECT 1 FROM leads WHERE id = activities.lead_id AND assigned_to = auth.uid())
      OR EXISTS (SELECT 1 FROM contracts WHERE id = activities.contract_id AND sales_id = auth.uid())
      OR EXISTS (SELECT 1 FROM quotations q JOIN leads l ON l.id = q.lead_id WHERE q.id = activities.quotation_id AND l.assigned_to = auth.uid())
      OR EXISTS (SELECT 1 FROM projects WHERE id = activities.project_id AND sales_id = auth.uid())
    )
  );

-- INSERT: designer can create activities
CREATE POLICY policy_activities_insert_designer
  ON activities FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- UPDATE: admin/operator can update any activity
CREATE POLICY policy_activities_update_admin
  ON activities FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

-- UPDATE: sales can update their own activities
CREATE POLICY policy_activities_update_sales
  ON activities FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

-- DELETE: admin can delete activities
CREATE POLICY policy_activities_delete_admin
  ON activities FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- DELETE: sales can delete their own activities
CREATE POLICY policy_activities_delete_sales
  ON activities FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =============================================================================
-- PHASE 13: Create policies for notifications (6 policies)
-- =============================================================================

-- SELECT: users can read their own notifications
CREATE POLICY policy_notifications_select_self
  ON notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- SELECT: admin/boss can read all notifications
CREATE POLICY policy_notifications_select_admin
  ON notifications FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- INSERT: any authenticated user can create notifications (for system notifications)
CREATE POLICY policy_notifications_insert_system
  ON notifications FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- INSERT: admin can create notifications
CREATE POLICY policy_notifications_insert_admin
  ON notifications FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- UPDATE: users can update (mark read) their own notifications
CREATE POLICY policy_notifications_update_self
  ON notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

-- DELETE: users can delete their own notifications
CREATE POLICY policy_notifications_delete_self
  ON notifications FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =============================================================================
-- PHASE 14: Create policies for ad_spend (6 policies)
-- =============================================================================

-- SELECT: admin/boss can read ad spend data
CREATE POLICY policy_ad_spend_select_admin
  ON ad_spend FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- SELECT: finance can read ad spend data
CREATE POLICY policy_ad_spend_select_finance
  ON ad_spend FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- INSERT: admin/boss can create ad spend records
CREATE POLICY policy_ad_spend_insert_admin
  ON ad_spend FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- UPDATE: admin/boss can update ad spend records
CREATE POLICY policy_ad_spend_update_admin
  ON ad_spend FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- UPDATE: finance can update ad spend records
CREATE POLICY policy_ad_spend_update_finance
  ON ad_spend FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- DELETE: admin/boss can delete ad spend records
CREATE POLICY policy_ad_spend_delete_admin
  ON ad_spend FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- =============================================================================
-- PHASE 15: Create policies for lead_documents (designer + other roles)
-- =============================================================================

-- SELECT: designer can read lead documents
CREATE POLICY policy_lead_documents_select_designer
  ON lead_documents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- SELECT: admin/boss/operator can read all lead documents
CREATE POLICY policy_lead_documents_select_admin
  ON lead_documents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: sales can read documents for their leads
CREATE POLICY policy_lead_documents_select_sales
  ON lead_documents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leads WHERE id = lead_documents.lead_id AND assigned_to = auth.uid()));

-- INSERT: admin/boss/operator can create lead documents
CREATE POLICY policy_lead_documents_insert_admin
  ON lead_documents FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales can create documents for their leads
CREATE POLICY policy_lead_documents_insert_sales
  ON lead_documents FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM leads WHERE id = lead_documents.lead_id AND assigned_to = auth.uid()));

-- DELETE: admin can delete lead documents
CREATE POLICY policy_lead_documents_delete_admin
  ON lead_documents FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

COMMIT;

-- =============================================================================
-- Refresh PostgREST schema cache
-- =============================================================================
NOTIFY pgrst, 'reload schema';
