-- 允许创建者删除自己创建的报价
-- 对应 Codex 1审 FAIL #1: RLS 缺少 sales delete policy
-- admin/boss/operator 已有 quotations_admin_all (FOR ALL) 覆盖

CREATE POLICY "quotations_creator_delete_own"
  ON quotations
  FOR DELETE
  TO authenticated
  USING (created_by = auth.uid());
