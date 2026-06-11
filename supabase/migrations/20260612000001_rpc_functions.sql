-- ============================================================
-- Contract Pipeline v1 — Phase 1 RPC Functions
-- 2026-06-12
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- 1. approve_contract(p_contract_id, p_approver_id, p_action, p_notes)
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION approve_contract(
  p_contract_id UUID,
  p_approver_id UUID,
  p_action TEXT,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_contract RECORD;
  v_step TEXT;
  v_new_status TEXT;
  v_approver_role TEXT;
  v_result JSONB;
BEGIN
  -- 获取合同当前状态
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Contract not found');
  END IF;

  -- 获取审批人角色
  SELECT role INTO v_approver_role FROM profiles WHERE id = p_approver_id;
  IF v_approver_role IS NULL THEN
    RETURN jsonb_build_object('error', 'Approver profile not found');
  END IF;

  -- 确定审批步骤
  IF v_approver_role IN ('admin', 'operator') THEN
    v_step := 'admin_review';
  ELSIF v_approver_role = 'boss' THEN
    v_step := 'ceo_review';
  ELSE
    RETURN jsonb_build_object('error', 'Role not authorized to approve');
  END IF;

  -- 验证当前合同状态允许审批
  IF v_contract.status NOT IN ('pending_admin', 'pending_ceo') THEN
    RETURN jsonb_build_object('error', 'Contract not in approvable state', 'current_status', v_contract.status);
  END IF;

  -- 验证审批步骤匹配
  IF v_step = 'admin_review' AND v_contract.status != 'pending_admin' THEN
    RETURN jsonb_build_object('error', 'Admin review not applicable', 'current_status', v_contract.status);
  END IF;
  IF v_step = 'ceo_review' AND v_contract.status != 'pending_ceo' THEN
    RETURN jsonb_build_object('error', 'CEO review not applicable', 'current_status', v_contract.status);
  END IF;

  IF p_action = 'approve' THEN
    -- Admin审批通过 → 推到CEO审批
    IF v_step = 'admin_review' THEN
      v_new_status := 'pending_ceo';
    -- CEO审批通过 → approved
    ELSIF v_step = 'ceo_review' THEN
      v_new_status := 'approved';
    END IF;

    -- 更新合同状态
    UPDATE contracts SET status = v_new_status, updated_at = now() WHERE id = p_contract_id;

    -- 写审批记录
    INSERT INTO contract_approvals (contract_id, step, approver_id, status, notes, reviewed_at)
    VALUES (p_contract_id, v_step, p_approver_id, 'approved',
      COALESCE(to_jsonb(p_notes), 'null'::jsonb), now());

    v_result := jsonb_build_object(
      'success', true,
      'action', 'approved',
      'new_status', v_new_status,
      'step', v_step
    );

  ELSIF p_action = 'reject' THEN
    -- 驳回 → 回退到 draft
    UPDATE contracts SET status = 'rejected', updated_at = now() WHERE id = p_contract_id;

    INSERT INTO contract_approvals (contract_id, step, approver_id, status, notes, reviewed_at)
    VALUES (p_contract_id, v_step, p_approver_id, 'rejected',
      COALESCE(to_jsonb(p_notes), 'null'::jsonb), now());

    v_result := jsonb_build_object(
      'success', true,
      'action', 'rejected',
      'new_status', 'rejected',
      'step', v_step
    );
  ELSE
    RETURN jsonb_build_object('error', 'Invalid action', 'action', p_action);
  END IF;

  RETURN v_result;
END;
$$;


-- ════════════════════════════════════════════════════════════
-- 2. allocate_payment(p_payment_id, p_allocations, p_allocated_by)
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION allocate_payment(
  p_payment_id UUID,
  p_allocations JSONB,
  p_allocated_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment RECORD;
  v_total_allocated DECIMAL(12,2) := 0;
  v_alloc JSONB;
  v_plan_id UUID;
  v_amount DECIMAL(12,2);
  v_plan_allocated DECIMAL(12,2);
  v_plan_amount DECIMAL(12,2);
  v_plan_status TEXT;
  v_count INT := 0;
BEGIN
  -- 获取付款记录
  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  -- 校验总额不超付款金额
  FOR i IN 0..jsonb_array_length(p_allocations) - 1 LOOP
    v_total_allocated := v_total_allocated + (p_allocations->i->>'amount')::DECIMAL(12,2);
  END LOOP;

  IF v_total_allocated > v_payment.amount THEN
    RETURN jsonb_build_object('error', 'Total allocation exceeds payment amount',
      'total_allocated', v_total_allocated, 'payment_amount', v_payment.amount);
  END IF;

  -- 删除该付款的旧核销记录（允许重新分配）
  DELETE FROM payment_allocations WHERE payment_id = p_payment_id;

  -- 写入新核销记录
  FOR i IN 0..jsonb_array_length(p_allocations) - 1 LOOP
    v_plan_id := (p_allocations->i->>'plan_id')::UUID;
    v_amount := (p_allocations->i->>'amount')::DECIMAL(12,2);

    INSERT INTO payment_allocations (payment_id, plan_id, amount_allocated, allocated_by)
    VALUES (p_payment_id, v_plan_id, v_amount, p_allocated_by);

    v_count := v_count + 1;
  END LOOP;

  -- 重算每个受影响 installment_plan 的 allocated_amount 和 status
  FOR v_plan_id IN
    SELECT DISTINCT plan_id FROM payment_allocations WHERE payment_id = p_payment_id
  LOOP
    SELECT COALESCE(SUM(amount_allocated), 0) INTO v_plan_allocated
    FROM payment_allocations WHERE plan_id = v_plan_id;

    SELECT amount INTO v_plan_amount FROM installment_plans WHERE id = v_plan_id;

    IF v_plan_allocated >= v_plan_amount THEN
      v_plan_status := 'paid';
    ELSIF v_plan_allocated > 0 THEN
      v_plan_status := 'partial';
    ELSE
      v_plan_status := 'pending';
    END IF;

    UPDATE installment_plans
    SET allocated_amount = v_plan_allocated, status = v_plan_status, updated_at = now()
    WHERE id = v_plan_id;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'allocations_count', v_count,
    'total_allocated', v_total_allocated
  );
END;
$$;


-- ════════════════════════════════════════════════════════════
-- 3. confirm_payment(p_payment_id, p_confirmer_id)
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION confirm_payment(
  p_payment_id UUID,
  p_confirmer_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment RECORD;
  v_contract RECORD;
  v_plan RECORD;
  v_first_plan_id UUID;
  v_first_plan_allocated DECIMAL(12,2);
  v_first_plan_amount DECIMAL(12,2);
  v_fp_status TEXT;
  v_total_paid DECIMAL(12,2);
  v_kpi_assigned_to UUID;
  v_kpi_period TEXT;
BEGIN
  -- 获取付款记录
  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;
  IF v_payment.confirmed THEN
    RETURN jsonb_build_object('error', 'Payment already confirmed');
  END IF;

  -- 获取关联合同
  SELECT * INTO v_contract FROM contracts WHERE id = v_payment.contract_id FOR UPDATE;

  -- 确认付款
  UPDATE payments
  SET confirmed = true, confirmed_by = p_confirmer_id, confirmed_at = now(), updated_at = now()
  WHERE id = p_payment_id;

  -- 更新首期款状态（如果分期 seq=1 的 plan 有核销到）
  SELECT id, amount INTO v_first_plan_id, v_first_plan_amount
  FROM installment_plans
  WHERE contract_id = v_payment.contract_id AND seq = 1
  LIMIT 1;

  IF v_first_plan_id IS NOT NULL THEN
    SELECT COALESCE(SUM(pa.amount_allocated), 0) INTO v_first_plan_allocated
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
    WHERE pa.plan_id = v_first_plan_id AND p.confirmed = true;

    IF v_first_plan_allocated >= v_first_plan_amount THEN
      v_fp_status := 'paid';
    ELSIF v_first_plan_allocated > 0 THEN
      v_fp_status := 'partial';
    ELSE
      v_fp_status := 'unpaid';
    END IF;

    UPDATE contracts
    SET first_payment_status = v_fp_status, updated_at = now()
    WHERE id = v_payment.contract_id;
  END IF;

  -- 更新 projects.paid_amount
  IF v_contract IS NOT NULL THEN
    SELECT COALESCE(SUM(p.amount), 0) INTO v_total_paid
    FROM payments p WHERE p.contract_id = v_payment.contract_id AND p.confirmed = true;

    UPDATE projects SET paid_amount = v_total_paid, updated_at = now()
    WHERE contract_id = v_payment.contract_id;
  END IF;

  -- 累加 kpi_targets.actual_amount
  IF v_contract IS NOT NULL THEN
    v_kpi_assigned_to := v_contract.sales_id;
    v_kpi_period := to_char(v_payment.payment_date, 'YYYY-MM');

    UPDATE kpi_targets
    SET actual_amount = actual_amount + v_payment.amount, updated_at = now()
    WHERE assigned_to = v_kpi_assigned_to
      AND period = v_kpi_period
      AND target_type = 'collection';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'amount', v_payment.amount
  );
END;
$$;
