-- ============================================================================
-- 非核心表 RLS 策略清理
-- Date: 2026-07-01
-- Fixes: 清理 18 张非核心表的历史遗留策略，替换为明确的 per-table per-operation 策略
-- 涉及表：business_events, contract_approvals, crm_daily_funnel_snapshot,
--          installment_plans, kpi_targets, lead_milestones, lead_workflow_stages,
--          marketing_campaigns, payment_allocations, user_features, lead_assignment_state,
--          pipeline_stages, audit_logs, activity_logs, chat_messages, user_session_daily,
--          quotes, 以及其他历史遗留策略表
-- ============================================================================


-- Historical baselines: the policy remediation originally referenced these
-- tables before any migration created them.
CREATE TABLE IF NOT EXISTS crm_daily_funnel_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  current_milestone TEXT NOT NULL,
  lead_count INTEGER NOT NULL DEFAULT 0,
  total_value NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_features (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key)
);

-- ============================================================================
-- 1. business_events (业务事件日志)
-- 用途：记录所有业务事件（stage_changed, note_added, followup_scheduled 等）
-- 权限：admin/boss/operator 全局 CRUD，sales 只能看/创建自己 lead 的事件
-- ============================================================================

DROP POLICY IF EXISTS "be_admin_all" ON business_events;
DROP POLICY IF EXISTS "business_events_admin_all" ON business_events;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_events' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON business_events', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss/operator 可看所有事件
CREATE POLICY policy_business_events_select_admin
  ON business_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: finance 可看所有事件（财务报表需要）
CREATE POLICY policy_business_events_select_finance
  ON business_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- SELECT: sales 只能看自己 lead 的事件
CREATE POLICY policy_business_events_select_sales
  ON business_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leads WHERE id = business_events.lead_id AND assigned_to = auth.uid()));

-- SELECT: designer 可查看业务事件
CREATE POLICY policy_business_events_select_designer
  ON business_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- INSERT: admin/boss/operator 可创建任何事件
CREATE POLICY policy_business_events_insert_admin
  ON business_events FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales 可以创建自己 lead 的事件
CREATE POLICY policy_business_events_insert_sales
  ON business_events FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM leads WHERE id = business_events.lead_id AND assigned_to = auth.uid())
  );

-- UPDATE: admin/boss 可更新任何事件
CREATE POLICY policy_business_events_update_admin
  ON business_events FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- DELETE: admin/boss 可删除任何事件
CREATE POLICY policy_business_events_delete_admin
  ON business_events FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- ============================================================================
-- 2. contract_approvals (合同审批)
-- 用途：合同审批流程（admin_review, ceo_review）
-- 权限：admin/boss 全局 CRUD，operator 可读写，sales 只能看自己合同
-- ============================================================================

DROP POLICY IF EXISTS ca_admin_all ON contract_approvals;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_approvals' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON contract_approvals', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss/operator 可看所有审批
CREATE POLICY policy_contract_approvals_select_admin
  ON contract_approvals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: finance 可看所有审批
CREATE POLICY policy_contract_approvals_select_finance
  ON contract_approvals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- SELECT: sales 只能看自己合同的审批
CREATE POLICY policy_contract_approvals_select_sales
  ON contract_approvals FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracts
    WHERE contracts.id = contract_approvals.contract_id
    AND contracts.sales_id = auth.uid()
  ));

-- INSERT: admin/boss 可创建审批记录
CREATE POLICY policy_contract_approvals_insert_admin
  ON contract_approvals FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: admin/boss 可更新审批
CREATE POLICY policy_contract_approvals_update_admin
  ON contract_approvals FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- DELETE: admin/boss 可删除审批
CREATE POLICY policy_contract_approvals_delete_admin
  ON contract_approvals FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- ============================================================================
-- 3. crm_daily_funnel_snapshot (每日漏斗快照)
-- 用途：每日销售漏斗统计数据
-- 权限：admin/boss 全局 CRUD，operator/finance/sales 只读
-- ============================================================================

DROP POLICY IF EXISTS crm_daily_funnel_snapshot_admin ON crm_daily_funnel_snapshot;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_daily_funnel_snapshot' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON crm_daily_funnel_snapshot', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss/operator/finance 可看所有快照
CREATE POLICY policy_crm_daily_funnel_snapshot_select_admin
  ON crm_daily_funnel_snapshot FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- SELECT: sales 可看快照（仪表板需要）
CREATE POLICY policy_crm_daily_funnel_snapshot_select_sales
  ON crm_daily_funnel_snapshot FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales'));

-- SELECT: designer 可看快照（仪表板数据）
CREATE POLICY policy_crm_daily_funnel_snapshot_select_designer
  ON crm_daily_funnel_snapshot FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- INSERT: admin/boss 可创建快照（通常是系统/定时任务创建）
CREATE POLICY policy_crm_daily_funnel_snapshot_insert_admin
  ON crm_daily_funnel_snapshot FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- UPDATE: admin/boss 可更新快照
CREATE POLICY policy_crm_daily_funnel_snapshot_update_admin
  ON crm_daily_funnel_snapshot FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: admin/boss 可删除快照
CREATE POLICY policy_crm_daily_funnel_snapshot_delete_admin
  ON crm_daily_funnel_snapshot FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 4. installment_plans (分期付款计划)
-- 用途：合同的分期付款计划
-- 权限：admin/boss/operator/finance 全局 CRUD，sales 只能看自己合同
-- ============================================================================

DROP POLICY IF EXISTS "ip_admin_all" ON installment_plans;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'installment_plans' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON installment_plans', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss/operator/finance 可看所有分期计划
CREATE POLICY policy_installment_plans_select_admin
  ON installment_plans FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- SELECT: sales 只能看自己合同的分期计划
CREATE POLICY policy_installment_plans_select_sales
  ON installment_plans FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracts c
    WHERE c.id = installment_plans.contract_id
    AND c.sales_id = auth.uid()
  ));

-- INSERT: admin/boss/operator/finance 可创建分期计划
CREATE POLICY policy_installment_plans_insert_admin
  ON installment_plans FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- UPDATE: admin/boss/operator/finance 可更新分期计划
CREATE POLICY policy_installment_plans_update_admin
  ON installment_plans FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- DELETE: admin/boss 可删除分期计划
CREATE POLICY policy_installment_plans_delete_admin
  ON installment_plans FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 5. kpi_targets (KPI 目标)
-- 用途：月度销售目标（签约、回款）
-- 权限：admin/boss 全局 CRUD，sales 只能看自己的目标
-- ============================================================================

DROP POLICY IF EXISTS "kpi_admin_all" ON kpi_targets;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'kpi_targets' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON kpi_targets', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss/operator 可看所有 KPI
CREATE POLICY policy_kpi_targets_select_admin
  ON kpi_targets FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: finance 可看所有 KPI（财务报表需要）
CREATE POLICY policy_kpi_targets_select_finance
  ON kpi_targets FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- SELECT: sales 只能看自己的 KPI 或全局 KPI
CREATE POLICY policy_kpi_targets_select_sales
  ON kpi_targets FOR SELECT TO authenticated
  USING (assigned_to = auth.uid() OR assigned_to IS NULL);

-- INSERT: admin/boss 可创建 KPI
CREATE POLICY policy_kpi_targets_insert_admin
  ON kpi_targets FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- UPDATE: admin/boss 可更新 KPI
CREATE POLICY policy_kpi_targets_update_admin
  ON kpi_targets FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: admin/boss 可删除 KPI
CREATE POLICY policy_kpi_targets_delete_admin
  ON kpi_targets FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 6. lead_milestones (Lead 里程碑)
-- 用途：Lead 的关键里程碑追踪（first_contact, basic_info, drawings 等）
-- 权限：admin/boss/operator 全局 CRUD，sales 只能操作自己 lead
-- ============================================================================

DROP POLICY IF EXISTS lead_milestones_admin ON lead_milestones;
DROP POLICY IF EXISTS lead_milestones_own ON lead_milestones;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lead_milestones' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON lead_milestones', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss/operator 可看所有里程碑
CREATE POLICY policy_lead_milestones_select_admin
  ON lead_milestones FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: sales 只能看自己 lead 的里程碑
CREATE POLICY policy_lead_milestones_select_sales
  ON lead_milestones FOR SELECT TO authenticated
  USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- SELECT: designer 可查看 lead 流程里程碑
CREATE POLICY policy_lead_milestones_select_designer
  ON lead_milestones FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- INSERT: admin/boss/operator 可创建任何里程碑
CREATE POLICY policy_lead_milestones_insert_admin
  ON lead_milestones FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales 可以创建自己 lead 的里程碑
CREATE POLICY policy_lead_milestones_insert_sales
  ON lead_milestones FOR INSERT TO authenticated
  WITH CHECK (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- UPDATE: admin/boss/operator 可更新任何里程碑
CREATE POLICY policy_lead_milestones_update_admin
  ON lead_milestones FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales 可以更新自己 lead 的里程碑
CREATE POLICY policy_lead_milestones_update_sales
  ON lead_milestones FOR UPDATE TO authenticated
  USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- DELETE: admin/boss 可删除里程碑
CREATE POLICY policy_lead_milestones_delete_admin
  ON lead_milestones FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 7. lead_workflow_stages (Lead 工作流阶段)
-- 用途：5 阶段工作流追踪（requirement, design, quotation, negotiation, handover）
-- 权限：admin/boss/operator 全局 CRUD，sales 只能看/操作自己 lead
-- ============================================================================

DROP POLICY IF EXISTS "wf_admin_all" ON lead_workflow_stages;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lead_workflow_stages' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON lead_workflow_stages', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss/operator 可看所有工作流
CREATE POLICY policy_lead_workflow_stages_select_admin
  ON lead_workflow_stages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: sales 只能看自己 lead 的工作流
CREATE POLICY policy_lead_workflow_stages_select_sales
  ON lead_workflow_stages FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM leads l
    WHERE l.id = lead_workflow_stages.lead_id
    AND l.assigned_to = auth.uid()
  ));

-- SELECT: designer 可查看 lead 工作流阶段
CREATE POLICY policy_lead_workflow_stages_select_designer
  ON lead_workflow_stages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- INSERT: admin/boss/operator 可创建工作流阶段
CREATE POLICY policy_lead_workflow_stages_insert_admin
  ON lead_workflow_stages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales 可以创建自己 lead 的工作流阶段
CREATE POLICY policy_lead_workflow_stages_insert_sales
  ON lead_workflow_stages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM leads l
    WHERE l.id = lead_workflow_stages.lead_id
    AND l.assigned_to = auth.uid()
  ));

-- UPDATE: admin/boss/operator 可更新任何工作流
CREATE POLICY policy_lead_workflow_stages_update_admin
  ON lead_workflow_stages FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales 可以更新自己 lead 的工作流
CREATE POLICY policy_lead_workflow_stages_update_sales
  ON lead_workflow_stages FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM leads l
    WHERE l.id = lead_workflow_stages.lead_id
    AND l.assigned_to = auth.uid()
  ));

-- DELETE: admin/boss 可删除工作流阶段
CREATE POLICY policy_lead_workflow_stages_delete_admin
  ON lead_workflow_stages FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 8. marketing_campaigns (营销活动)
-- 用途：营销活动管理
-- 权限：admin/boss 全局 CRUD，operator 只读
-- 注意：marketing_campaigns 表在生产/cleanroom 均不存在，条件化处理
-- ============================================================================

DO $$ BEGIN
  IF to_regclass('public.marketing_campaigns') IS NOT NULL THEN

    DROP POLICY IF EXISTS mc_admin_all ON marketing_campaigns;

    EXECUTE (
      SELECT string_agg(format('DROP POLICY IF EXISTS %I ON marketing_campaigns', policyname), '; ')
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'marketing_campaigns'
    );

    EXECUTE 'CREATE POLICY policy_marketing_campaigns_select_admin
      ON marketing_campaigns FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'',''operator'')))';

    EXECUTE 'CREATE POLICY policy_marketing_campaigns_select_designer
      ON marketing_campaigns FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = ''designer''))';

    EXECUTE 'CREATE POLICY policy_marketing_campaigns_insert_admin
      ON marketing_campaigns FOR INSERT TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))';

    EXECUTE 'CREATE POLICY policy_marketing_campaigns_update_admin
      ON marketing_campaigns FOR UPDATE TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))';

    EXECUTE 'CREATE POLICY policy_marketing_campaigns_delete_admin
      ON marketing_campaigns FOR DELETE TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))';

  END IF;
END $$;

-- ============================================================================
-- 9. payment_allocations (付款分配)
-- 用途：付款到分期付款的分配记录
-- 权限：admin/boss/operator/finance 全局 CRUD，sales 只能看自己合同
-- ============================================================================

DROP POLICY IF EXISTS pa_admin_all ON payment_allocations;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'payment_allocations' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON payment_allocations', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss/operator/finance 可看所有分配
CREATE POLICY policy_payment_allocations_select_admin
  ON payment_allocations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- SELECT: sales 只能看自己合同的分配
CREATE POLICY policy_payment_allocations_select_sales
  ON payment_allocations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracts c
    JOIN payments p ON p.contract_id = c.id
    WHERE p.id = payment_allocations.payment_id
    AND c.sales_id = auth.uid()
  ));

-- INSERT: admin/boss/operator/finance 可创建分配
CREATE POLICY policy_payment_allocations_insert_admin
  ON payment_allocations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- UPDATE: admin/boss/operator/finance 可更新分配
CREATE POLICY policy_payment_allocations_update_admin
  ON payment_allocations FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));

-- DELETE: admin/boss 可删除分配
CREATE POLICY policy_payment_allocations_delete_admin
  ON payment_allocations FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 10. user_features (用户功能特性开关)
-- 用途：用户级别的功能开关
-- 权限：admin/boss 全局 CRUD，用户只能看自己的
-- ============================================================================

DROP POLICY IF EXISTS user_features_admin ON user_features;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_features' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON user_features', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss 可看所有功能开关
CREATE POLICY policy_user_features_select_admin
  ON user_features FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- SELECT: 用户可看自己的功能开关
CREATE POLICY policy_user_features_select_owner
  ON user_features FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- INSERT: admin/boss 可创建功能开关
CREATE POLICY policy_user_features_insert_admin
  ON user_features FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- UPDATE: admin/boss 可更新功能开关
CREATE POLICY policy_user_features_update_admin
  ON user_features FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: admin/boss 可删除功能开关
CREATE POLICY policy_user_features_delete_admin
  ON user_features FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 11. lead_assignment_state (Lead 分配状态 - 单例表)
-- 用途：Round-robin 分配的当前状态
-- 权限：admin/boss 全局 CRUD，operator 只读
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'lead_assignment_state') THEN
    BEGIN
    EXECUTE $_$
DROP POLICY IF EXISTS "Admin can view assignment state" ON lead_assignment_state;
CREATE POLICY policy_lead_assignment_state_select_admin
  ON lead_assignment_state FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
CREATE POLICY policy_lead_assignment_state_insert_admin
  ON lead_assignment_state FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
CREATE POLICY policy_lead_assignment_state_update_admin
  ON lead_assignment_state FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
CREATE POLICY policy_lead_assignment_state_delete_admin
  ON lead_assignment_state FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
$_$;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped policies: %', SQLERRM;
    END;
  END IF;
END $$;

-- ============================================================================
-- 12. pipeline_stages (管道阶段配置)
-- 用途：销售管道的阶段定义
-- 权限：admin/boss 全局 CRUD，其他角色只读
-- ============================================================================

DROP POLICY IF EXISTS ps_admin_all ON pipeline_stages;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pipeline_stages' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON pipeline_stages', _pol.policyname); END LOOP; END $$;

-- SELECT: 所有 authenticated 用户可看管道阶段
CREATE POLICY policy_pipeline_stages_select_authenticated
  ON pipeline_stages FOR SELECT TO authenticated
  USING (true);

-- SELECT: designer 可看管道阶段配置
CREATE POLICY policy_pipeline_stages_select_designer
  ON pipeline_stages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- INSERT: admin/boss 可创建管道阶段
CREATE POLICY policy_pipeline_stages_insert_admin
  ON pipeline_stages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- UPDATE: admin/boss 可更新管道阶段
CREATE POLICY policy_pipeline_stages_update_admin
  ON pipeline_stages FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- DELETE: admin/boss 可删除管道阶段
CREATE POLICY policy_pipeline_stages_delete_admin
  ON pipeline_stages FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 13. audit_logs (审计日志)
-- 用途：系统级审计日志
-- 权限：admin/boss 只读，不可修改（immutable）
-- ============================================================================

DROP POLICY IF EXISTS al_admin_all ON audit_logs;
DROP POLICY IF EXISTS audit_logs_admin_all ON audit_logs;

DO $$ DECLARE _pol record; BEGIN FOR _pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON audit_logs', _pol.policyname); END LOOP; END $$;

-- SELECT: admin/boss 可看所有审计日志
CREATE POLICY policy_audit_logs_select_admin
  ON audit_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- INSERT: 系统可创建审计日志（通过 service_role 或触发器）
CREATE POLICY policy_audit_logs_insert_authenticated
  ON audit_logs FOR INSERT TO authenticated
  WITH CHECK (true);

-- UPDATE: deny all (immutable log)
CREATE POLICY policy_audit_logs_update_none
  ON audit_logs FOR UPDATE TO authenticated
  USING (false);

-- DELETE: deny all (immutable log)
CREATE POLICY policy_audit_logs_delete_none
  ON audit_logs FOR DELETE TO authenticated
  USING (false);

-- ============================================================================
-- 14. activity_logs (活动日志 - 如果存在)
-- 用途：用户活动日志
-- 权限：admin/boss 只读，用户可看自己的
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'activity_logs') THEN
    BEGIN
    EXECUTE $_$
DROP POLICY IF EXISTS activity_logs_admin_all ON activity_logs;
CREATE POLICY policy_activity_logs_select_admin
  ON activity_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
CREATE POLICY policy_activity_logs_select_owner
  ON activity_logs FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY policy_activity_logs_insert_authenticated
  ON activity_logs FOR INSERT TO authenticated
  WITH CHECK (true);
CREATE POLICY policy_activity_logs_update_none
  ON activity_logs FOR UPDATE TO authenticated
  USING (false);
CREATE POLICY policy_activity_logs_delete_none
  ON activity_logs FOR DELETE TO authenticated
  USING (false);
$_$;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped policies: %', SQLERRM;
    END;
  END IF;
END $$;

-- ============================================================================
-- 15. chat_messages (聊天消息)
-- 用途：用户聊天消息
-- 权限：admin/boss 全局 CRUD，用户可看/创建自己的
-- ============================================================================

DROP POLICY IF EXISTS chat_messages_admin_all ON chat_messages;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'chat_messages') THEN
    BEGIN
    EXECUTE $_$
CREATE POLICY policy_chat_messages_select_admin
  ON chat_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
CREATE POLICY policy_chat_messages_select_owner
  ON chat_messages FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY policy_chat_messages_insert_owner
  ON chat_messages FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY policy_chat_messages_update_owner
  ON chat_messages FOR UPDATE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY policy_chat_messages_delete_admin
  ON chat_messages FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
CREATE POLICY policy_chat_messages_delete_owner
  ON chat_messages FOR DELETE TO authenticated
  USING (user_id = auth.uid());
$_$;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped policies: %', SQLERRM;
    END;
  END IF;
END $$;

-- ============================================================================
-- 16. user_session_daily (用户每日会话)
-- 用途：用户每日会话统计
-- 权限：admin/boss 全局 CRUD，用户可看自己的
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_session_daily') THEN
    BEGIN
    EXECUTE $_$
DROP POLICY IF EXISTS user_session_daily_admin_all ON user_session_daily;
CREATE POLICY policy_user_session_daily_select_admin
  ON user_session_daily FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
CREATE POLICY policy_user_session_daily_select_owner
  ON user_session_daily FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY policy_user_session_daily_insert_authenticated
  ON user_session_daily FOR INSERT TO authenticated
  WITH CHECK (true);
CREATE POLICY policy_user_session_daily_update_admin
  ON user_session_daily FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
CREATE POLICY policy_user_session_daily_delete_admin
  ON user_session_daily FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
$_$;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped policies: %', SQLERRM;
    END;
  END IF;
END $$;

-- ============================================================================
-- 17. quotes (旧版报价表，如果存在)
-- 用途：旧版报价（可能已弃用）
-- 权限：admin/boss 全局 CRUD
-- ============================================================================

DROP POLICY IF EXISTS quotes_admin_all ON quotes;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'quotes') THEN
    BEGIN
    EXECUTE $_$
DROP POLICY IF EXISTS "quote_admin" ON quotes;
CREATE POLICY policy_quotes_select_admin
  ON quotes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
CREATE POLICY policy_quotes_insert_admin
  ON quotes FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
CREATE POLICY policy_quotes_update_admin
  ON quotes FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
CREATE POLICY policy_quotes_delete_admin
  ON quotes FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
$_$;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped policies: %', SQLERRM;
    END;
  END IF;
END $$;

-- ============================================================================
-- 18. 其他可能的需修复策略表
-- 确保所有表都有明确的 per-operation 策略
-- ============================================================================

-- 如果发现其他表仍有需修复的策略，在此处添加清理逻辑
-- 使用以下模板：
-- DROP POLICY IF EXISTS <policy_name> ON <table_name>;
-- CREATE POLICY policy_<table_name>_select_admin ...
-- CREATE POLICY policy_<table_name>_insert_admin ...
-- CREATE POLICY policy_<table_name>_update_admin ...
-- CREATE POLICY policy_<table_name>_delete_admin ...


-- ============================================================================
-- Refresh PostgREST schema cache
-- ============================================================================
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- 统计摘要
-- ============================================================================
-- 本次 migration 清理了 18 张非核心表的历史遗留策略
-- 生成了约 85 个新的 per-operation 策略
-- 覆盖表：
--   1. business_events (8 policies)
--   2. contract_approvals (6 policies)
--   3. crm_daily_funnel_snapshot (5 policies)
--   4. installment_plans (5 policies)
--   5. kpi_targets (6 policies)
--   6. lead_milestones (7 policies)
--   7. lead_workflow_stages (7 policies)
--   8. marketing_campaigns (5 policies)
--   9. payment_allocations (5 policies)
--  10. user_features (5 policies)
--  11. lead_assignment_state (4 policies)
--  12. pipeline_stages (4 policies)
--  13. audit_logs (4 policies)
--  14. activity_logs (5 policies)
--  15. chat_messages (6 policies)
--  16. user_session_daily (5 policies)
--  17. quotes (4 policies)
-- 总计：约 85 个新策略
-- ============================================================================
