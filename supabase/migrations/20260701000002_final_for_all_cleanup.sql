-- ============================================================================
-- Migration: 最后 5 张表 FOR ALL 策略清理
-- Date: 2026-07-01
-- Fixes: 清理 transfer_history, lead_files, meta_tokens, knx_designs, lead_documents
--        的最后 8 条 FOR ALL 策略，替换为明确的 per-operation 策略
-- 目标: 全库 FOR ALL = 0
-- ============================================================================


-- ============================================================================
-- 1. knx_designs (KNX 智能家居设计方案)
-- 用途：KNX 设计方案的创建和管理
-- 权限：admin/boss/operator 全局 CRUD，sales 操作自己 lead 的设计
--        designer/finance 只读
-- ============================================================================

DROP POLICY IF EXISTS "Default deny all" ON knx_designs;
DROP POLICY IF EXISTS "knx_designs_admin_all" ON knx_designs;

-- SELECT: admin/boss/operator 可查看所有设计
CREATE POLICY policy_knx_designs_select_admin
  ON knx_designs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: designer 可查看所有设计
CREATE POLICY policy_knx_designs_select_designer
  ON knx_designs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- SELECT: finance 可查看设计（成本核算需要）
CREATE POLICY policy_knx_designs_select_finance
  ON knx_designs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- INSERT: admin/boss/operator 可创建任何设计
CREATE POLICY policy_knx_designs_insert_admin
  ON knx_designs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales 可以为自己 lead 创建设计
CREATE POLICY policy_knx_designs_insert_sales
  ON knx_designs FOR INSERT TO authenticated
  WITH CHECK (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- UPDATE: admin/boss/operator 可更新任何设计
CREATE POLICY policy_knx_designs_update_admin
  ON knx_designs FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales 可以更新自己 lead 的设计
CREATE POLICY policy_knx_designs_update_sales
  ON knx_designs FOR UPDATE TO authenticated
  USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()))
  WITH CHECK (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- DELETE: admin/boss 可删除设计
CREATE POLICY policy_knx_designs_delete_admin
  ON knx_designs FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 2. lead_documents (Lead 文档)
-- 用途：Lead 相关的文档存储（合同、图纸、报价等）
-- 权限：admin/boss/operator 全局 CRUD，sales 操作自己 lead 的文档
--        designer/finance 只读
-- 已有：SELECT admin/boss/operator, SELECT designer, SELECT sales(own),
--       INSERT admin/boss/operator, INSERT sales, DELETE admin
-- 缺失：UPDATE, DELETE boss, SELECT finance, UPDATE sales
-- ============================================================================

DROP POLICY IF EXISTS "lead_documents_admin" ON lead_documents;
DROP POLICY IF EXISTS "lead_documents_own" ON lead_documents;

-- SELECT: finance 可查看所有文档
CREATE POLICY policy_lead_documents_select_finance
  ON lead_documents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- UPDATE: admin/boss/operator 可更新任何文档
CREATE POLICY policy_lead_documents_update_admin
  ON lead_documents FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- UPDATE: sales 可以更新自己 lead 的文档
CREATE POLICY policy_lead_documents_update_sales
  ON lead_documents FOR UPDATE TO authenticated
  USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()))
  WITH CHECK (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- DELETE: boss 可删除文档 (admin 已有 policy_lead_documents_delete_admin)
CREATE POLICY policy_lead_documents_delete_boss
  ON lead_documents FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- ============================================================================
-- 3. lead_files (Lead 文件)
-- 用途：Lead 的文件上传和存储
-- 权限：admin/boss/operator 全局 CRUD，sales 操作自己 lead 的文件
--        designer/finance 只读
-- 已有：lead_files_select_assigned (SELECT, public), lead_files_insert_staff (INSERT, public)
-- 缺失：SELECT admin/boss/operator/designer/finance, INSERT admin/boss/operator,
--       UPDATE, DELETE
-- ============================================================================

DROP POLICY IF EXISTS "Default deny all" ON lead_files;
DROP POLICY IF EXISTS "lead_files_admin_all" ON lead_files;

-- SELECT: admin/boss/operator 可查看所有文件
CREATE POLICY policy_lead_files_select_admin
  ON lead_files FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- SELECT: designer 可查看所有文件
CREATE POLICY policy_lead_files_select_designer
  ON lead_files FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'designer'));

-- SELECT: finance 可查看所有文件
CREATE POLICY policy_lead_files_select_finance
  ON lead_files FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- INSERT: admin/boss/operator 可上传任何文件
CREATE POLICY policy_lead_files_insert_admin
  ON lead_files FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- INSERT: sales 可以为自己 lead 上传文件
CREATE POLICY policy_lead_files_insert_sales
  ON lead_files FOR INSERT TO authenticated
  WITH CHECK (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- UPDATE: admin/boss/operator 可更新任何文件记录
CREATE POLICY policy_lead_files_update_admin
  ON lead_files FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));

-- DELETE: admin/boss 可删除文件
CREATE POLICY policy_lead_files_delete_admin
  ON lead_files FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- ============================================================================
-- 4. meta_tokens (Meta API 访问令牌 - 单例表)
-- 用途：存储 Meta/Facebook API 的 access token
-- 权限：admin/boss 全局 CRUD，operator/sales/finance/designer 只读
-- 注意：meta_tokens 表在生产/cleanroom 均不存在，条件化处理
-- ============================================================================

DO $$ BEGIN
  IF to_regclass('public.meta_tokens') IS NOT NULL THEN

    DROP POLICY IF EXISTS "meta_tokens_admin" ON meta_tokens;
    DROP POLICY IF EXISTS meta_tokens_admin ON meta_tokens;

    EXECUTE 'CREATE POLICY policy_meta_tokens_select_admin
      ON meta_tokens FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'',''operator'')))';

    EXECUTE 'CREATE POLICY policy_meta_tokens_select_authenticated
      ON meta_tokens FOR SELECT TO authenticated
      USING (true)';

    EXECUTE 'CREATE POLICY policy_meta_tokens_insert_admin
      ON meta_tokens FOR INSERT TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))';

    EXECUTE 'CREATE POLICY policy_meta_tokens_update_admin
      ON meta_tokens FOR UPDATE TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))
      WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))';

    EXECUTE 'CREATE POLICY policy_meta_tokens_delete_admin
      ON meta_tokens FOR DELETE TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))';

  END IF;
END $$;

-- ============================================================================
-- 5. transfer_history (Lead 转移历史)
-- 用途：记录 Lead 分配/转交的完整历史
-- 权限：admin/boss/operator 全局 CRUD，sales 可查看/创建自己 lead 的记录
--        finance/designer 只读
-- 已有：transfer_sales_select (SELECT, authenticated),
--       transfer_sales_insert (INSERT, authenticated)
-- 缺失：SELECT admin/boss/operator/finance/designer, INSERT admin/boss/operator,
--       UPDATE, DELETE
-- 注意：transfer_history 表在生产/cleanroom 均不存在，条件化处理
-- ============================================================================

DO $$ BEGIN
  IF to_regclass('public.transfer_history') IS NOT NULL THEN

    DROP POLICY IF EXISTS "transfer_admin_all" ON transfer_history;
    DROP POLICY IF EXISTS transfer_admin_all ON transfer_history;

    EXECUTE 'CREATE POLICY policy_transfer_history_select_admin
      ON transfer_history FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'',''operator'')))';

    EXECUTE 'CREATE POLICY policy_transfer_history_select_finance
      ON transfer_history FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = ''finance''))';

    EXECUTE 'CREATE POLICY policy_transfer_history_select_designer
      ON transfer_history FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = ''designer''))';

    EXECUTE 'CREATE POLICY policy_transfer_history_select_sales
      ON transfer_history FOR SELECT TO authenticated
      USING (
        from_user_id = auth.uid() OR to_user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM leads WHERE id = transfer_history.lead_id AND assigned_to = auth.uid())
      )';

    EXECUTE 'CREATE POLICY policy_transfer_history_insert_admin
      ON transfer_history FOR INSERT TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'',''operator'')))';

    EXECUTE 'CREATE POLICY policy_transfer_history_update_admin
      ON transfer_history FOR UPDATE TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))
      WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))';

    EXECUTE 'CREATE POLICY policy_transfer_history_delete_admin
      ON transfer_history FOR DELETE TO authenticated
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'')))';

  END IF;
END $$;
