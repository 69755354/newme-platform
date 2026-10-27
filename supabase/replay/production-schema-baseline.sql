-- GENERATED FILE: schema-only public application baseline.
-- Source: authenticated read-only pg_catalog capture; no table rows or sequence current values.
-- project_ref: vfopmpxlhwzpxqegayew
-- captured_at: 2026-08-14T16:03:09.258173+00:00
-- production_history_watermark: 20260805202917
-- production_history_row_count: 100
-- capture_query_sha256: 7c5c9bcad1c9f39a0e0441b6eeaecb057d1d560793cd0be8e954ac40cbc642ba
-- source_body_sha256: 6624a11f81ac4103dc187cc43ab8607a7e7e2f019df74f7a0dd3fa2a1ed7d9aa
-- source_body_bytes: 316219
-- full_file_sha256: see production-schema-baseline.json (self-hash cannot be embedded).
-- scope: public application objects only; managed Supabase schemas are supplied by 00_platform_bootstrap.sql.
SET check_function_bodies = false;
SET search_path = "$user", public, extensions;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM anon;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM authenticated;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM service_role;

GRANT USAGE ON SCHEMA public TO PUBLIC;

GRANT USAGE ON SCHEMA public TO anon;

GRANT USAGE ON SCHEMA public TO authenticated;

GRANT USAGE ON SCHEMA public TO postgres;

GRANT USAGE ON SCHEMA public TO service_role;

CREATE TABLE public.activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid,
    customer_id uuid,
    project_id uuid,
    user_id uuid,
    type text NOT NULL,
    content text,
    ai_generated boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    contract_id uuid,
    quotation_id uuid,
    duration integer,
    is_completed boolean DEFAULT true,
    due_at timestamp with time zone,
    priority text DEFAULT 'normal'::text,
    metadata jsonb);

CREATE TABLE public.activity_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    user_id uuid NOT NULL,
    action text NOT NULL,
    entity_type text,
    entity_id uuid,
    details jsonb,
    ip_address inet,
    user_agent text,
    session_id text,
    page_path text,
    duration_seconds integer,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.ad_spend (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_name text,
    adset_name text,
    ad_name text,
    spend_date date,
    amount numeric(12,2),
    currency text DEFAULT 'AED'::text,
    impressions integer,
    clicks integer,
    source text DEFAULT 'meta'::text,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.audit_log_archived_20260615 (
    id bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.audit_log_id_seq START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE) NOT NULL,
    user_id uuid NOT NULL,
    event_type text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    ip_address text,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid,
    actor_email text,
    action text NOT NULL,
    target_type text,
    target_id uuid,
    details jsonb DEFAULT '{}'::jsonb,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.business_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid,
    user_id uuid,
    event_type text NOT NULL,
    event_data jsonb DEFAULT '{}'::jsonb,
    description text,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid,
    wa_message_id text,
    direction text NOT NULL,
    from_number text,
    to_number text,
    content text,
    media_url text,
    media_type text,
    extracted jsonb,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.contract_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    contract_id uuid NOT NULL,
    step text NOT NULL,
    approver_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    notes jsonb,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    quotation_id uuid,
    customer_id uuid,
    sales_id uuid,
    created_by uuid,
    contract_no text NOT NULL,
    contract_date date DEFAULT CURRENT_DATE NOT NULL,
    contract_amount numeric(12,2) NOT NULL,
    currency text DEFAULT 'AED'::text,
    party_a_name text NOT NULL,
    party_a_contact text,
    party_b_name text DEFAULT 'NewMe Smart Home FZCO'::text NOT NULL,
    party_b_contact text,
    file_url text,
    file_metadata jsonb,
    status text DEFAULT 'draft'::text NOT NULL,
    notes text,
    terminated_reason text,
    terminated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    first_payment_status text DEFAULT 'unpaid'::text NOT NULL,
    first_payment_due_date date,
    sealed_file_url text,
    sealed_file_metadata jsonb,
    approval_status text DEFAULT 'none'::text);

CREATE TABLE public.crm_daily_funnel_snapshot (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_date date DEFAULT CURRENT_DATE NOT NULL,
    current_milestone text NOT NULL,
    lead_count integer DEFAULT 0 NOT NULL,
    total_value numeric DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL);

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid,
    name text NOT NULL,
    phone text,
    email text,
    whatsapp text,
    address text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    unified_profile boolean DEFAULT true,
    tags text[],
    total_contract_amount numeric(12,2) DEFAULT 0,
    last_activity_at timestamp with time zone,
    assigned_sales_id uuid,
    poor_reason text,
    archive_reason text);

CREATE TABLE public.follow_up_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    user_id uuid,
    contact_type text DEFAULT 'phone'::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    result text,
    no_answer boolean DEFAULT false NOT NULL,
    next_action text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    next_followup_date timestamp with time zone,
    created_by uuid,
    contact_time timestamp with time zone NOT NULL,
    contact_result text,
    contact_fingerprint text);

CREATE TABLE public.installment_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    seq integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    due_date date NOT NULL,
    description text,
    status text DEFAULT 'pending'::text NOT NULL,
    paid_amount numeric(12,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    allocated_amount numeric(12,2) DEFAULT 0 NOT NULL);

CREATE TABLE public.knx_designs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    devices_json jsonb DEFAULT '{}'::jsonb,
    total_aed numeric(12,2) DEFAULT 0,
    device_count integer DEFAULT 0,
    status text DEFAULT 'draft'::text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now());

CREATE TABLE public.kpi_targets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period text NOT NULL,
    target_type text NOT NULL,
    target_amount numeric(12,2) NOT NULL,
    assigned_to uuid,
    notes text,
    set_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    actual_amount numeric(12,2) DEFAULT 0 NOT NULL);

CREATE TABLE public.lead_deletion_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    deleted_lead_id uuid NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL);

CREATE TABLE public.lead_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    document_type text NOT NULL,
    file_name text NOT NULL,
    file_url text NOT NULL,
    file_size bigint,
    uploaded_by uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL);

CREATE TABLE public.lead_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    file_name text,
    file_path text NOT NULL,
    file_type text,
    file_size bigint,
    mime_type text,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.lead_milestones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    milestone_key text NOT NULL,
    completed_by uuid,
    completed_at timestamp with time zone DEFAULT now(),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL);

CREATE TABLE public.lead_mutation_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid NOT NULL,
    operation text NOT NULL,
    idempotency_key uuid NOT NULL,
    lead_id uuid NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL);

CREATE TABLE public.lead_workflow_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    stage_key text NOT NULL,
    stage_order integer DEFAULT 0 NOT NULL,
    weight integer DEFAULT 20 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    assigned_to uuid,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    deadline_at timestamp with time zone,
    notified_24h boolean DEFAULT false,
    notified_48h boolean DEFAULT false,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now());

CREATE TABLE public.leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    meta_click_id text,
    meta_campaign text,
    meta_ad_id text,
    quality text DEFAULT 'pending'::text,
    customer_name text,
    phone text,
    email text,
    property_type text,
    property_size_sqm integer,
    location text,
    budget_range text,
    service_needs text[],
    ai_summary text,
    ai_tags text[],
    ai_quality text,
    assigned_to uuid,
    converted_at timestamp with time zone,
    lost_at timestamp with time zone,
    lost_reason text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    stage text DEFAULT 'new'::text,
    lead_status text,
    win_probability integer,
    stage_changed_at timestamp with time zone,
    decision_maker text,
    decision_date date,
    competitor text,
    last_contact_date date,
    next_followup_date date DEFAULT (CURRENT_DATE + '1 day'::interval),
    followup_count integer DEFAULT 0,
    next_action text DEFAULT 'call'::text,
    disqualified_candidate boolean DEFAULT false,
    sales_manager_review boolean DEFAULT false,
    recovery_candidate boolean DEFAULT false,
    transfer_candidate boolean DEFAULT false,
    hold_since date,
    notes text,
    quotation_value numeric(12,2),
    expected_close_date date,
    confidence_pct integer DEFAULT 50,
    forecast_category text,
    rep_name text,
    source_platform text,
    source_channel text,
    campaign_id text,
    campaign_name text,
    adset_id text,
    adset_name text,
    ad_id text,
    ad_name text,
    creative_id text,
    creative_name text,
    form_id text,
    form_name text,
    utm_source text,
    utm_medium text,
    utm_campaign text,
    utm_content text,
    utm_term text,
    fbclid text,
    gclid text,
    landing_page text,
    referrer text,
    first_touch_at timestamp with time zone,
    last_touch_at timestamp with time zone,
    owner text,
    sales_manager uuid,
    days_since_last_contact integer DEFAULT 0,
    customer_id uuid,
    project_name text,
    project_status text,
    ac_brand text,
    system_preference text,
    visit_status text,
    rejection_detail text,
    circuit_diagrams boolean DEFAULT false,
    phase_pct integer DEFAULT 0,
    sub_phase text,
    quotation_sent_date timestamp with time zone,
    reminder_24h_sent boolean DEFAULT false,
    reminder_48h_sent boolean DEFAULT false,
    sales_phase text DEFAULT 'lead'::text,
    lost_reason_price boolean DEFAULT false,
    lost_reason_competitor boolean DEFAULT false,
    lost_reason_no_budget boolean DEFAULT false,
    lost_reason_project_cancelled boolean DEFAULT false,
    lost_reason_project_delayed boolean DEFAULT false,
    lost_reason_no_response boolean DEFAULT false,
    lost_reason_other boolean DEFAULT false,
    current_milestone text DEFAULT 'new'::text,
    final_status text,
    no_answer_flag boolean DEFAULT false NOT NULL,
    not_interested_reason text,
    emirate text,
    area text,
    customer_company_type text,
    customer_position text,
    smart_requirements jsonb,
    customer_budget numeric(12,2),
    expected_sign_date date,
    contact_result text,
    project_type text,
    raw_import_data jsonb,
    import_batch_id uuid,
    imported_by uuid,
    imported_at timestamp with time zone,
    archived boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    archive_batch_id uuid,
    archive_reason text,
    devices_json jsonb,
    created_by uuid,
    poor_reason text,
    won_at timestamp with time zone,
    import_fingerprint text);

CREATE TABLE public.marketing_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_name text NOT NULL,
    platform text DEFAULT 'meta'::text,
    status text DEFAULT 'inactive'::text,
    start_date date DEFAULT '2025-12-01'::date,
    end_date date DEFAULT '2026-05-31'::date,
    daily_budget numeric,
    budget_type text,
    total_spent_aed numeric,
    impressions integer,
    reach integer,
    frequency numeric,
    clicks integer,
    cpm_aed numeric,
    cpc_aed numeric,
    ctr_pct numeric,
    conversion_metric text,
    conversions integer,
    cost_per_conversion_aed numeric,
    attribution_window text,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.meta_tokens (
    id integer DEFAULT 1 NOT NULL,
    access_token text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    title text NOT NULL,
    body text,
    related_id text,
    related_type character varying(30),
    is_read boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.payment_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    payment_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    amount_allocated numeric(12,2) NOT NULL,
    allocated_by uuid,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    installment_plan_id uuid,
    created_by uuid,
    amount numeric(12,2) NOT NULL,
    currency text DEFAULT 'AED'::text,
    payment_date date DEFAULT CURRENT_DATE NOT NULL,
    received_at timestamp with time zone,
    payment_method text,
    reference_no text,
    confirmed boolean DEFAULT false,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    overpayment_action text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now());

CREATE TABLE public.pipeline_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    order_index integer NOT NULL,
    is_terminal boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku text NOT NULL,
    name text NOT NULL,
    description text,
    category text,
    brand text,
    unit text DEFAULT 'pcs'::text,
    unit_price numeric(12,2) NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now());

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    role text DEFAULT 'sales'::text,
    full_name text,
    phone text,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    manager_id uuid,
    is_active boolean DEFAULT true,
    last_active_at timestamp with time zone,
    joined_at timestamp with time zone DEFAULT now(),
    email text,
    password_changed_at timestamp with time zone,
    force_password_change boolean DEFAULT false,
    password_hint text);

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid,
    name text NOT NULL,
    property_type text,
    property_size integer,
    location text,
    phase text DEFAULT 'design'::text,
    status text DEFAULT 'active'::text,
    cad_url text,
    quote_url text,
    ppt_url text,
    contract_url text,
    quoted_amount numeric(12,2),
    contract_amount numeric(12,2),
    paid_amount numeric(12,2) DEFAULT 0,
    assigned_to uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    contract_id uuid,
    lead_id uuid,
    sales_id uuid,
    project_manager uuid);

CREATE TABLE public.quotations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    customer_id uuid,
    created_by uuid,
    quote_no text NOT NULL,
    version integer DEFAULT 1,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    discount_rate numeric(5,2) DEFAULT 0,
    discount_amount numeric(12,2) DEFAULT 0,
    tax_rate numeric(5,2) DEFAULT 5.0,
    tax_amount numeric(12,2) DEFAULT 0,
    total_amount numeric(12,2) NOT NULL,
    currency text DEFAULT 'AED'::text,
    valid_until date DEFAULT (CURRENT_DATE + '30 days'::interval) NOT NULL,
    payment_terms text,
    delivery_terms text,
    status text DEFAULT 'draft'::text NOT NULL,
    pdf_url text,
    ppt_url text,
    devices_json jsonb,
    notes text,
    internal_notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    contract_id uuid,
    quotation_type text DEFAULT 'standard'::text NOT NULL,
    sent_at timestamp with time zone,
    accepted_at timestamp with time zone,
    rejected_at timestamp with time zone);

CREATE TABLE public.quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    lead_id uuid,
    version integer DEFAULT 1,
    devices jsonb,
    device_details jsonb,
    total_amount numeric(12,2),
    generated_by text DEFAULT 'hermes'::text,
    status text DEFAULT 'draft'::text,
    quote_url text,
    ppt_url text,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    title text NOT NULL,
    assignee_id uuid,
    due_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    source text DEFAULT 'manual'::text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    priority text);

CREATE TABLE public.transfer_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    from_user_id uuid,
    to_user_id uuid NOT NULL,
    reason text,
    notes text,
    transferred_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now());

CREATE TABLE public.user_features (
    user_id uuid NOT NULL,
    feature_key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL);

CREATE TABLE public.user_session_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    user_id uuid NOT NULL,
    session_date date DEFAULT CURRENT_DATE NOT NULL,
    first_login timestamp with time zone,
    last_active timestamp with time zone,
    total_duration_seconds integer DEFAULT 0,
    login_count integer DEFAULT 0,
    pages_viewed integer DEFAULT 0,
    actions_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now());

CREATE OR REPLACE FUNCTION public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.apply_standard_rls(table_name text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  own_policy TEXT;
  admin_policy TEXT;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', table_name);
  -- own policy
  EXECUTE format($p$DROP POLICY IF EXISTS %I ON %I;$p$, table_name || '_own', table_name);
  EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL USING (
    lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
  );$p$, table_name || '_own', table_name);
  -- admin policy
  EXECUTE format($p$DROP POLICY IF EXISTS %I ON %I;$p$, table_name || '_admin', table_name);
  EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))
  );$p$, table_name || '_admin', table_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.auto_create_task_from_followup()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.next_action IS NOT NULL AND NEW.next_action != '' THEN
    INSERT INTO tasks (lead_id, title, assignee_id, due_at, source)
    VALUES (
      NEW.lead_id, 
      NEW.next_action, 
      NEW.user_id, 
      COALESCE(NEW.next_followup_date, now() + interval '24 hours'),
      'follow_up'
    )
    ON CONFLICT (lead_id) WHERE source = 'follow_up' AND status = 'pending'
    DO UPDATE SET due_at = EXCLUDED.due_at, title = EXCLUDED.title;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.auto_enable_rls()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  obj record;
  tbl_name text;
  has_policies boolean;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF obj.command_tag = 'CREATE TABLE' AND obj.schema_name = 'public' THEN
      -- object_identity is schema-qualified (e.g. "public.mytable")
      -- Extract just the table name
      tbl_name := split_part(obj.object_identity, '.', 2);
      
      -- Enable RLS on the table
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', obj.schema_name, tbl_name);
      
      -- Check if any policies already exist
      SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = obj.schema_name AND tablename = tbl_name
      ) INTO has_policies;
      
      -- If no policies exist, add a default "deny all" policy (safest default)
      IF NOT has_policies THEN
        EXECUTE format(
          'CREATE POLICY "Default deny all" ON %I.%I FOR ALL USING (false)',
          obj.schema_name, tbl_name
        );
      END IF;
    END IF;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_milestone_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  last_key text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = NEW.lead_id
      AND milestone_key = NEW.milestone_key
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.milestone_key = 'first_contact' THEN
    RETURN NEW;
  END IF;

  SELECT milestone_key
  INTO last_key
  FROM public.lead_milestones
  WHERE lead_id = NEW.lead_id
  ORDER BY milestone_order(milestone_key) DESC
  LIMIT 1;

  IF last_key IS NOT NULL THEN
    IF milestone_order(NEW.milestone_key) <= milestone_order(last_key) THEN
      RAISE EXCEPTION 'Cannot go backwards: % -> %', last_key, NEW.milestone_key;
    END IF;
    IF milestone_order(NEW.milestone_key) > milestone_order(last_key) + 1 THEN
      RAISE EXCEPTION 'Cannot skip: % -> %', last_key, NEW.milestone_key;
    END IF;
  END IF;

  UPDATE public.leads
  SET current_milestone = NEW.milestone_key
  WHERE id = NEW.lead_id;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.days_since_last_contact(lead_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  last_contact DATE;
BEGIN
  SELECT leads.last_contact_date INTO last_contact FROM leads WHERE id = lead_id;
  IF last_contact IS NULL THEN RETURN NULL; END IF;
  RETURN (CURRENT_DATE - last_contact)::INTEGER;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_lead_atomic(p_lead_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_lead public.leads%ROWTYPE;
  v_response jsonb;
BEGIN
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY'; END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'sales') THEN
    RAISE EXCEPTION 'FORBIDDEN_LEAD_DELETE';
  END IF;

  SELECT response INTO v_response
  FROM public.lead_deletion_requests
  WHERE actor_id = v_actor_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_response || jsonb_build_object('idempotent_replay', true); END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;
  IF v_actor_role = 'sales' AND v_lead.assigned_to IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'FORBIDDEN_LEAD_DELETE';
  END IF;

  BEGIN
    DELETE FROM public.leads WHERE id = p_lead_id;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'LEAD_DELETE_BLOCKED';
  END;

  v_response := jsonb_build_object('lead_id', p_lead_id, 'deleted', true);
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, details)
  VALUES (
    v_actor_id, 'lead_deleted', 'lead', p_lead_id,
    jsonb_build_object('customer_name', v_lead.customer_name, 'assigned_to', v_lead.assigned_to, 'stage', v_lead.stage)
  );
  INSERT INTO public.lead_deletion_requests (actor_id, idempotency_key, deleted_lead_id, response)
  VALUES (v_actor_id, p_idempotency_key, p_lead_id, v_response);
  RETURN v_response;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.derive_lead_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- Don't auto-change for won/lost
  IF NEW.stage IN ('won','lost') THEN
    RETURN NEW;
  END IF;
  -- Only auto-set if lead_status is not explicitly set by user
  -- (Check metadata.lead_status_manual if column exists)
  BEGIN
    IF NEW.metadata->>'lead_status_manual' = 'true' THEN
      RETURN NEW;
    END IF;
  EXCEPTION WHEN undefined_column THEN
    -- metadata column doesn't exist, skip this check
  END;
  -- Derive from last_contact_date (fallback to updated_at)
  IF NEW.last_contact_date IS NULL THEN
    NEW.lead_status := 'dormant';
  ELSIF NEW.last_contact_date >= (CURRENT_DATE - INTERVAL '7 days') THEN
    NEW.lead_status := 'hot';
  ELSIF NEW.last_contact_date >= (CURRENT_DATE - INTERVAL '14 days') THEN
    NEW.lead_status := 'warm';
  ELSIF NEW.last_contact_date >= (CURRENT_DATE - INTERVAL '30 days') THEN
    NEW.lead_status := 'cold';
  ELSE
    NEW.lead_status := 'dormant';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.detect_stale_leads(stale_days integer DEFAULT 7)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
    affected_count INT;
    stale_lead RECORD;
BEGIN
    affected_count := 0;

    FOR stale_lead IN
        SELECT l.id, l.assigned_to, l.customer_name
        FROM public.leads l
        WHERE l.lead_status NOT IN ('closed_won', 'closed_lost', 'disqualified')
          AND l.recovery_candidate = false
          AND l.assigned_to IS NOT NULL
          AND NOT EXISTS (
              -- No activity in the last N days
              SELECT 1 FROM public.activities a
              WHERE a.lead_id = l.id
                AND a.created_at > now() - (stale_days || ' days')::INTERVAL
          )
          AND NOT EXISTS (
              -- No follow-up scheduled in the future
              SELECT 1 FROM public.activities a
              WHERE a.lead_id = l.id
                AND a.type = 'follow_up'
                AND a.due_at > now()
          )
    LOOP
        -- Mark as recovery candidate
        UPDATE public.leads
        SET recovery_candidate = true,
            sales_manager_review = true
        WHERE id = stale_lead.id;

        -- Log event
        INSERT INTO public.business_events (lead_id, user_id, event_type, event_data)
        VALUES (
            stale_lead.id, NULL, 'lead_stale_detected',
            jsonb_build_object(
                'stale_days', stale_days,
                'assigned_to', stale_lead.assigned_to,
                'customer_name', stale_lead.customer_name
            )
        );

        -- Notify admin (boss)
        INSERT INTO public.notifications (user_id, type, title, body, related_id)
        SELECT p.id, 'followup_reminder', 'Stale Lead Alert',
               'Lead "' || COALESCE(stale_lead.customer_name,'Unknown') || '" has no activity for ' || stale_days || ' days. Consider reassignment.',
               stale_lead.id
        FROM public.profiles p
        WHERE p.role = 'admin' AND p.is_active = true;

        affected_count := affected_count + 1;
    END LOOP;

    RETURN affected_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_active_lead_transfer_candidate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
  if new.assigned_to is not null
    and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to)
    and not exists (
      select 1
      from public.profiles
      where id = new.assigned_to
        and is_active = true
        and role in ('sales', 'operator', 'boss', 'admin')
    )
  then
    raise exception 'Lead assignee must be an active transfer candidate'
      using errcode = '23514';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_followup_required()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.stage IN ('won', 'lost') THEN
    RETURN NEW;
  END IF;
  IF NEW.next_action IS NULL OR NEW.next_action = '' THEN
    RAISE EXCEPTION 'Next action is required';
  END IF;
  IF NEW.next_followup_date IS NULL THEN
    RAISE EXCEPTION 'Next follow-up date is required';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_quote_no(year_param integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  next_seq integer;
  year_str text;
BEGIN
  -- Serialize all quote_no generation with a transaction-level advisory lock
  PERFORM pg_advisory_xact_lock(42);

  year_str := year_param::text;

  SELECT COALESCE(
    (SELECT MAX(NULLIF(regexp_replace(quote_no, '^NM-\d{4}-', ''), ''))
     FROM public.quotations
     WHERE quote_no LIKE 'NM-' || year_str || '-%')::integer,
    0
  ) + 1 INTO next_seq;

  RETURN 'NM-' || year_str || '-' || lpad(next_seq::text, 4, '0');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_my_role()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT role FROM public.profiles WHERE id = auth.uid());
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_team_activity(p_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(user_id uuid, full_name text, role text, first_login timestamp with time zone, last_active timestamp with time zone, total_duration_seconds integer, login_count integer, pages_viewed integer, actions_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    us.user_id,
    p.full_name,
    p.role,
    us.first_login,
    us.last_active,
    us.total_duration_seconds,
    us.login_count,
    us.pages_viewed,
    us.actions_count
  FROM public.user_session_daily us
  JOIN public.profiles p ON us.user_id = p.id
  WHERE us.session_date = p_date
  ORDER BY
    CASE p.role
      WHEN 'boss' THEN 1
      WHEN 'admin' THEN 2
      WHEN 'sales' THEN 3
      ELSE 4
    END,
    p.full_name;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_auth_login()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_tenant_id UUID;
BEGIN
  -- profiles table has no tenant_id column; use NULL
  -- COALESCE below defaults to zero-UUID
  v_tenant_id := NULL;
  
  -- upsert today's session record
  INSERT INTO user_session_daily (tenant_id, user_id, session_date, first_login, last_active, login_count)
  VALUES (
    COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'),
    NEW.id,
    CURRENT_DATE,
    now(),
    now(),
    1
  )
  ON CONFLICT (user_id, session_date) DO UPDATE SET
    first_login = COALESCE(user_session_daily.first_login, now()),
    last_active = now(),
    login_count = user_session_daily.login_count + 1,
    updated_at = now();
    
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_user_login()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$ BEGIN INSERT INTO public.user_session_daily (tenant_id, user_id, session_date, first_login, last_active, login_count, created_at, updated_at) VALUES ('00000000-0000-0000-0000-000000000000', NEW.id, CURRENT_DATE, NEW.last_sign_in_at, NEW.last_sign_in_at, 1, NOW(), NOW()) ON CONFLICT (user_id, session_date) DO UPDATE SET login_count = user_session_daily.login_count + 1, last_active = NEW.last_sign_in_at, updated_at = NOW(); RETURN NEW; END; $function$
;

CREATE OR REPLACE FUNCTION public.log_activity(p_action text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_details jsonb DEFAULT NULL::jsonb, p_page_path text DEFAULT NULL::text, p_duration_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id UUID;
  v_tenant_id UUID;
  v_result UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- profiles may not have tenant_id column; default to global tenant
  v_tenant_id := '00000000-0000-0000-0000-000000000000';

  INSERT INTO public.activity_logs (tenant_id, user_id, action, entity_type, entity_id, details, page_path, duration_seconds)
  VALUES (v_tenant_id, v_user_id, p_action, p_entity_type, p_entity_id, p_details, p_page_path, p_duration_seconds)
  RETURNING id INTO v_result;

  INSERT INTO public.user_session_daily (tenant_id, user_id, session_date, first_login, last_active, actions_count)
  VALUES (
    v_tenant_id,
    v_user_id,
    CURRENT_DATE,
    CASE WHEN p_action = 'login' THEN now() ELSE NULL END,
    now(),
    1
  )
  ON CONFLICT (user_id, session_date) DO UPDATE SET
    first_login = COALESCE(public.user_session_daily.first_login, EXCLUDED.first_login),
    last_active = now(),
    login_count = public.user_session_daily.login_count + CASE WHEN p_action = 'login' THEN 1 ELSE 0 END,
    actions_count = public.user_session_daily.actions_count + 1,
    pages_viewed = public.user_session_daily.pages_viewed + CASE WHEN p_action = 'page_view' THEN 1 ELSE 0 END,
    updated_at = now();

  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_activity(p_lead_id uuid, p_type text, p_content text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_activity_id UUID;
  v_user_id UUID;
BEGIN
  v_user_id := COALESCE(p_user_id, auth.uid());
  
  INSERT INTO activities (lead_id, user_id, type, content)
  VALUES (p_lead_id, v_user_id, p_type, p_content)
  RETURNING id INTO v_activity_id;
  
  RETURN v_activity_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_auth_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE event_name TEXT; event_meta JSONB; client_ip TEXT;
BEGIN
  client_ip := NULLIF(current_setting('request.header.x-forwarded-for', true), '');
  IF client_ip IS NULL THEN
    client_ip := inet_client_addr()::TEXT;
  END IF;
  IF TG_OP = 'INSERT' THEN
    event_name := 'USER_SIGNUP';
    event_meta := jsonb_build_object('email', NEW.email, 'provider', NEW.raw_app_meta_data ->> 'provider', 'email_confirmed', NEW.email_confirmed_at IS NOT NULL);
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.last_sign_in_at IS DISTINCT FROM NEW.last_sign_in_at THEN
      event_name := 'USER_SIGN_IN';
    ELSIF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
      event_name := 'EMAIL_CONFIRMED';
    ELSIF OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password THEN
      event_name := 'PASSWORD_CHANGED';
    ELSE
      event_name := 'USER_UPDATED';
    END IF;
    event_meta := jsonb_build_object('email', NEW.email, 'provider', NEW.raw_app_meta_data ->> 'provider', 'last_sign_in', NEW.last_sign_in_at);
  END IF;
  INSERT INTO public.audit_logs (actor_id, action, details, ip_address)
  VALUES (NEW.id, event_name, event_meta, client_ip);
  UPDATE public.profiles SET last_active_at = NEW.last_sign_in_at
  WHERE id = NEW.id AND NEW.last_sign_in_at IS NOT NULL;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.milestone_order(milestone text)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN CASE milestone
    WHEN 'new' THEN 0 WHEN 'first_contact' THEN 1
    WHEN 'basic_info' THEN 2 WHEN 'drawings' THEN 3
    WHEN 'requirements' THEN 4 WHEN 'solution' THEN 5
    WHEN 'quotation' THEN 6 WHEN 'meeting' THEN 7
    WHEN 'negotiation' THEN 8 ELSE 99
  END;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.next_quote_no()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_year TEXT := to_char(now(), 'YYYY');
  v_max INT;
  v_next INT;
BEGIN
  SELECT COALESCE(
    MAX(CAST(split_part(quote_no, '-', 3) AS INT)),
    0
  ) INTO v_max
  FROM quotations
  WHERE quote_no LIKE 'NM-' || v_year || '-%';
  v_next := v_max + 1;
  RETURN 'NM-' || v_year || '-' || LPAD(v_next::text, 4, '0');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.on_lead_won()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer_id uuid;
  v_contract_id uuid;
  v_project_id uuid;
  v_contract_no text;
  v_contract_amount numeric;
  v_customer_name text;
  v_location text;
  v_property_type text;
  v_property_size integer;
  v_installment_count integer := 3;
  v_seq integer;
  v_pct numeric[];
  v_amount numeric;
  v_due_days integer[];
BEGIN
  -- Only trigger when final_status changes TO 'won' (not from 'won' to something else)
  IF NEW.final_status <> 'won' OR OLD.final_status = 'won' THEN
    RETURN NEW;
  END IF;

  -- Guard: skip if contract already exists for this lead (idempotency)
  IF EXISTS (SELECT 1 FROM contracts WHERE lead_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- Guard: skip if quotation_value is NULL or zero (can't create contract with 0 amount)
  IF COALESCE(NEW.quotation_value, 0) <= 0 THEN
    INSERT INTO activities (lead_id, user_id, type, content)
    VALUES (NEW.id, NEW.assigned_to, 'note',
      'Lead Won auto-creation skipped: contract_amount is 0 (quotation_value was NULL or zero).');
    RETURN NEW;
  END IF;

  v_contract_amount := COALESCE(NEW.quotation_value, 0);
  v_customer_name := COALESCE(NEW.customer_name, NEW.phone, 'Unknown Client');
  v_location := NEW.location;
  v_property_type := NEW.property_type;
  v_property_size := NEW.property_size_sqm;

  -- Step 1: Create or update customer
  IF NEW.customer_id IS NOT NULL THEN
    v_customer_id := NEW.customer_id;
    UPDATE customers SET
      total_contract_amount = COALESCE(total_contract_amount, 0) + v_contract_amount,
      last_activity_at = now(),
      name = CASE WHEN customers.name = 'Unknown' OR customers.name IS NULL THEN v_customer_name ELSE customers.name END,
      phone = COALESCE(customers.phone, NEW.phone),
      updated_at = now()
    WHERE id = v_customer_id;
  ELSE
    INSERT INTO customers (lead_id, name, phone, email, address, total_contract_amount, last_activity_at)
    VALUES (NEW.id, v_customer_name, NEW.phone, NEW.email, v_location, v_contract_amount, now())
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_customer_id;

    IF v_customer_id IS NOT NULL THEN
      UPDATE leads SET customer_id = v_customer_id WHERE id = NEW.id;
    END IF;
  END IF;

  -- Step 2: Generate contract number (NEW-YYYYMMDD-NNN)
  v_contract_no := 'NEW-' || to_char(now(), 'YYYYMMDD') || '-' ||
    lpad(COALESCE((SELECT count(*)::text FROM contracts WHERE contract_date = CURRENT_DATE), '0'), 3, '0');

  -- Step 3: Create contract
  INSERT INTO contracts (
    lead_id, customer_id, sales_id, created_by,
    contract_no, contract_date, contract_amount, currency,
    party_a_name, party_a_contact,
    party_b_name, status, approval_status
  ) VALUES (
    NEW.id, v_customer_id, NEW.assigned_to, NEW.assigned_to,
    v_contract_no, CURRENT_DATE, v_contract_amount, 'AED',
    v_customer_name, NEW.phone,
    'NewMe Smart Home FZCO', 'active', 'none'
  )
  RETURNING id INTO v_contract_id;

  -- Step 4: Create installment plans (50% / 30% / 20%)
  v_pct := ARRAY[0.50, 0.30, 0.20];
  v_due_days := ARRAY[0, 30, 60];

  FOR v_seq IN 1..v_installment_count LOOP
    v_amount := ROUND(v_contract_amount * v_pct[v_seq], 2);
    INSERT INTO installment_plans (contract_id, seq, amount, due_date, description, status)
    VALUES (
      v_contract_id, v_seq, v_amount,
      CURRENT_DATE + v_due_days[v_seq],
      CASE v_seq
        WHEN 1 THEN '首期款 (签约)'
        WHEN 2 THEN '二期款 (设备到货)'
        WHEN 3 THEN '尾款 (验收)'
      END,
      'pending'
    );
  END LOOP;

  -- Step 5: Create project
  INSERT INTO projects (
    customer_id, lead_id, contract_id, sales_id,
    name, property_type, property_size, location,
    phase, status, contract_amount
  ) VALUES (
    v_customer_id, NEW.id, v_contract_id, NEW.assigned_to,
    v_customer_name || ' - ' || COALESCE(v_property_type, 'Project'),
    v_property_type, v_property_size, v_location,
    'design', 'active', v_contract_amount
  )
  RETURNING id INTO v_project_id;

  -- Step 6: Log business event (using 'won' which is in chk_event_type)
  INSERT INTO business_events (lead_id, user_id, event_type, description, event_data)
  VALUES (
    NEW.id, NEW.assigned_to, 'won',
    'Automation: Lead Won → Contract#' || v_contract_no || ' + 3 installments + project',
    jsonb_build_object(
      'contract_id', v_contract_id,
      'contract_no', v_contract_no,
      'project_id', v_project_id,
      'installment_count', v_installment_count,
      'customer_id', v_customer_id
    )
  );

  -- Step 7: Log activity (using 'note' which is in activities_type_check)
  INSERT INTO activities (lead_id, user_id, type, content)
  VALUES (NEW.id, NEW.assigned_to, 'note', 'System auto-created: Contract#' || v_contract_no || ', 3 installment plans, project');

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reassign_lead(p_lead_id uuid, p_new_sales uuid, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
    old_sales UUID;
    v_customer_name TEXT;
BEGIN
    SELECT assigned_to, customer_name INTO old_sales, v_customer_name
    FROM public.leads WHERE id = p_lead_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lead not found: %', p_lead_id;
    END IF;

    -- Update assignment
    UPDATE public.leads
    SET assigned_to = p_new_sales,
        transfer_candidate = false,
        recovery_candidate = false,
        hold_since = NULL
    WHERE id = p_lead_id;

    -- Log transfer
    INSERT INTO public.business_events (lead_id, user_id, event_type, event_data)
    VALUES (
        p_lead_id, auth.uid(), 'lead_reassigned',
        jsonb_build_object(
            'from_sales', old_sales,
            'to_sales', p_new_sales,
            'reason', p_reason
        )
    );

    -- Notify new sales
    INSERT INTO public.notifications (user_id, type, title, body, related_id)
    VALUES (
        p_new_sales, 'lead_assigned', 'Lead Transferred to You',
        'Lead "' || COALESCE(v_customer_name, 'Unknown') || '" has been transferred to you.',
        p_lead_id
    );

    RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reassign_lead_atomic(p_lead_id uuid, p_new_assignee uuid, p_expected_updated_at timestamp with time zone, p_idempotency_key uuid, p_reason text DEFAULT 'manual_reassign'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
  v_target_active boolean;
  v_lead public.leads%ROWTYPE;
  v_response jsonb;
  v_reason text := left(btrim(coalesce(p_reason, 'manual_reassign')), 500);
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
  END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator') THEN
    RAISE EXCEPTION 'FORBIDDEN_REASSIGNMENT';
  END IF;

  SELECT response INTO v_response
  FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id
    AND operation = 'lead_reassignment'
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_response || jsonb_build_object('idempotent_replay', true);
  END IF;

  SELECT role, is_active INTO v_target_role, v_target_active
  FROM public.profiles WHERE id = p_new_assignee;
  IF NOT FOUND OR coalesce(v_target_active, false) = false
     OR coalesce(v_target_role, '') NOT IN ('sales', 'operator', 'boss') THEN
    RAISE EXCEPTION 'INVALID_ASSIGNEE';
  END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND';
  END IF;
  IF p_expected_updated_at IS NOT NULL AND v_lead.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'CONCURRENT_LEAD_UPDATE';
  END IF;

  IF v_lead.assigned_to IS NOT DISTINCT FROM p_new_assignee THEN
    v_response := jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', p_new_assignee,
      'unchanged', true
    );
  ELSE
    UPDATE public.leads
    SET assigned_to = p_new_assignee,
        transfer_candidate = false,
        recovery_candidate = false,
        hold_since = NULL,
        updated_at = now()
    WHERE id = p_lead_id;

    INSERT INTO public.transfer_history (
      lead_id, from_user_id, to_user_id, reason, transferred_by
    ) VALUES (
      p_lead_id, v_lead.assigned_to, p_new_assignee, v_reason, v_actor_id
    );

    INSERT INTO public.activities (lead_id, user_id, type, content)
    VALUES (
      p_lead_id, v_actor_id, 'transfer',
      format('Lead reassigned from %s to %s', coalesce(v_lead.assigned_to::text, 'unassigned'), p_new_assignee::text)
    );

    INSERT INTO public.business_events (lead_id, user_id, event_type, description, event_data)
    VALUES (
      p_lead_id, v_actor_id, 'transfer', 'Lead reassigned',
      jsonb_build_object('from_user_id', v_lead.assigned_to, 'to_user_id', p_new_assignee, 'reason', v_reason)
    );

    INSERT INTO public.notifications (user_id, type, title, body, related_id, related_type)
    VALUES (
      p_new_assignee, 'lead_assigned', 'Lead assigned',
      coalesce(v_lead.customer_name, 'Lead') || ' was assigned to you.', p_lead_id, 'lead'
    );

    v_response := jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', p_new_assignee,
      'updated_at', (SELECT updated_at FROM public.leads WHERE id = p_lead_id),
      'unchanged', false
    );
  END IF;

  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'lead_reassignment', p_idempotency_key, p_lead_id, v_response);

  RETURN v_response;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.recomplete_lead_milestone(p_lead_id uuid, p_milestone_key text, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  current_lead public.leads%ROWTYPE;
  current_milestone public.lead_milestones%ROWTYPE;
  recompleted public.lead_milestones%ROWTYPE;
  target_order integer;
  clean_notes text := btrim(COALESCE(p_notes, ''));
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT role INTO actor_role
  FROM public.profiles
  WHERE id = actor_id;

  IF actor_role IS NULL
     OR actor_role NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'Forbidden: invalid CRM role';
  END IF;

  IF p_milestone_key IS NULL
     OR p_milestone_key NOT IN (
       'first_contact', 'basic_info', 'drawings', 'requirements',
       'solution', 'quotation', 'meeting'
     ) THEN
    RAISE EXCEPTION 'Invalid milestone';
  END IF;

  IF clean_notes = '' THEN
    RAISE EXCEPTION 'Milestone note is required';
  END IF;
  IF char_length(clean_notes) > 1000 THEN
    RAISE EXCEPTION 'Milestone note must be 1000 characters or fewer';
  END IF;

  SELECT * INTO current_lead
  FROM public.leads
  WHERE id = p_lead_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;

  IF actor_role NOT IN ('admin', 'boss', 'operator')
     AND current_lead.assigned_to IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'Forbidden: lead not assigned to you';
  END IF;

  SELECT * INTO current_milestone
  FROM public.lead_milestones
  WHERE lead_id = p_lead_id
    AND milestone_key = p_milestone_key
  FOR UPDATE;

  IF NOT FOUND OR current_milestone.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Milestone is not open for recompletion';
  END IF;

  target_order := public.milestone_order(p_milestone_key);
  IF target_order > 1 AND NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = p_lead_id
      AND completed_at IS NOT NULL
      AND public.milestone_order(milestone_key) = target_order - 1
  ) THEN
    RAISE EXCEPTION 'Previous milestone must be completed first';
  END IF;

  UPDATE public.lead_milestones
  SET notes = clean_notes,
      completed_by = actor_id,
      completed_at = NOW()
  WHERE id = current_milestone.id
  RETURNING * INTO recompleted;

  UPDATE public.leads
  SET current_milestone = p_milestone_key,
      updated_at = recompleted.completed_at
  WHERE id = p_lead_id;

  INSERT INTO public.business_events (
    lead_id,
    user_id,
    event_type,
    description,
    event_data,
    created_at
  )
  VALUES (
    p_lead_id,
    actor_id,
    'note_added',
    format('Milestone %s completed again: %s', p_milestone_key, clean_notes),
    jsonb_build_object(
      'action', 'milestone_recompleted',
      'milestone_key', p_milestone_key,
      'notes', clean_notes
    ),
    recompleted.completed_at
  );

  RETURN jsonb_build_object(
    'success', true,
    'milestone', to_jsonb(recompleted),
    'recompleted', true
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_lead_contact_atomic(p_lead_id uuid, p_contact_method text, p_contact_time timestamp with time zone, p_contact_result text, p_summary text, p_contact_fingerprint text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_lead public.leads%ROWTYPE;
  v_contact_id uuid;
  v_response jsonb;
BEGIN
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF p_idempotency_key IS NULL
     OR p_contact_method NOT IN ('phone', 'whatsapp', 'other')
     OR btrim(coalesce(p_contact_result, '')) = ''
     OR p_contact_time IS NULL OR p_contact_time > now()
     OR btrim(coalesce(p_contact_fingerprint, '')) = '' THEN
    RAISE EXCEPTION 'INVALID_CONTACT_REQUEST';
  END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'FORBIDDEN_CONTACT';
  END IF;
  SELECT response INTO v_response FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id AND operation = 'lead_contact' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_response || jsonb_build_object('idempotent_replay', true); END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;
  IF v_actor_role NOT IN ('admin', 'boss', 'operator') AND v_lead.assigned_to IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'FORBIDDEN_CONTACT';
  END IF;

  INSERT INTO public.follow_up_logs (
    lead_id, user_id, contact_type, contact_time, contact_result, summary, no_answer, contact_fingerprint
  ) VALUES (
    p_lead_id, v_actor_id, p_contact_method, p_contact_time, btrim(p_contact_result),
    coalesce(nullif(btrim(coalesce(p_summary, '')), ''), btrim(p_contact_result)), false, p_contact_fingerprint
  ) ON CONFLICT (contact_fingerprint) DO UPDATE
    SET contact_fingerprint = EXCLUDED.contact_fingerprint
  RETURNING id INTO v_contact_id;

  UPDATE public.leads
  SET last_contact_date = greatest(coalesce(last_contact_date, p_contact_time::date), p_contact_time::date),
      updated_at = now()
  WHERE id = p_lead_id;
  v_response := jsonb_build_object('lead_id', p_lead_id, 'contact_id', v_contact_id);
  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'lead_contact', p_idempotency_key, p_lead_id, v_response);
  RETURN v_response;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_lead_note_atomic(p_lead_id uuid, p_note text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_lead public.leads%ROWTYPE;
  v_note text := btrim(coalesce(p_note, ''));
  v_note_id uuid;
  v_response jsonb;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_idempotency_key IS NULL OR v_note = '' OR char_length(v_note) > 4000 THEN
    RAISE EXCEPTION 'INVALID_NOTE_REQUEST';
  END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'FORBIDDEN_NOTE';
  END IF;

  SELECT response INTO v_response
  FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id AND operation = 'lead_note' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_response || jsonb_build_object('idempotent_replay', true);
  END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND';
  END IF;
  IF v_actor_role NOT IN ('admin', 'boss', 'operator') AND v_lead.assigned_to IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'FORBIDDEN_NOTE';
  END IF;

  INSERT INTO public.follow_up_logs (lead_id, user_id, contact_type, summary, contact_time, no_answer)
  VALUES (p_lead_id, v_actor_id, 'note', v_note, now(), false)
  RETURNING id INTO v_note_id;

  UPDATE public.leads SET last_contact_date = current_date, updated_at = now() WHERE id = p_lead_id;
  v_response := jsonb_build_object('lead_id', p_lead_id, 'note_id', v_note_id);
  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'lead_note', p_idempotency_key, p_lead_id, v_response);
  RETURN v_response;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reopen_lead_milestone(p_lead_id uuid, p_milestone_key text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  current_lead public.leads%ROWTYPE;
  target_order integer;
  previous_key text;
  clean_reason text := btrim(COALESCE(p_reason, ''));
  affected jsonb;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT role INTO actor_role
  FROM public.profiles
  WHERE id = actor_id;

  IF actor_role IS NULL
     OR actor_role NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'Forbidden: invalid CRM role';
  END IF;

  IF p_milestone_key IS NULL
     OR p_milestone_key NOT IN (
       'first_contact', 'basic_info', 'drawings', 'requirements',
       'solution', 'quotation', 'meeting'
     ) THEN
    RAISE EXCEPTION 'Invalid milestone';
  END IF;

  IF clean_reason = '' THEN
    RAISE EXCEPTION 'Reopen reason is required';
  END IF;
  IF char_length(clean_reason) > 1000 THEN
    RAISE EXCEPTION 'Reopen reason must be 1000 characters or fewer';
  END IF;

  SELECT * INTO current_lead
  FROM public.leads
  WHERE id = p_lead_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;

  IF actor_role NOT IN ('admin', 'boss', 'operator')
     AND current_lead.assigned_to IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'Forbidden: lead not assigned to you';
  END IF;

  target_order := public.milestone_order(p_milestone_key);

  IF NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = p_lead_id
      AND milestone_key = p_milestone_key
      AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Milestone is not completed';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'milestone_key', milestone_key,
      'notes', notes,
      'completed_at', completed_at,
      'completed_by', completed_by
    )
    ORDER BY public.milestone_order(milestone_key)
  )
  INTO affected
  FROM public.lead_milestones
  WHERE lead_id = p_lead_id
    AND completed_at IS NOT NULL
    AND public.milestone_order(milestone_key) >= target_order;

  UPDATE public.lead_milestones
  SET completed_at = NULL,
      completed_by = NULL
  WHERE lead_id = p_lead_id
    AND completed_at IS NOT NULL
    AND public.milestone_order(milestone_key) >= target_order;

  SELECT milestone_key
  INTO previous_key
  FROM public.lead_milestones
  WHERE lead_id = p_lead_id
    AND completed_at IS NOT NULL
  ORDER BY public.milestone_order(milestone_key) DESC
  LIMIT 1;

  UPDATE public.leads
  SET current_milestone = COALESCE(previous_key, 'new'),
      updated_at = NOW()
  WHERE id = p_lead_id;

  INSERT INTO public.business_events (
    lead_id,
    user_id,
    event_type,
    description,
    event_data,
    created_at
  )
  VALUES (
    p_lead_id,
    actor_id,
    'status_changed',
    format('Milestone %s reopened: %s', p_milestone_key, clean_reason),
    jsonb_build_object(
      'action', 'milestone_reopened',
      'milestone_key', p_milestone_key,
      'reason', clean_reason,
      'affected', COALESCE(affected, '[]'::jsonb),
      'current_milestone', COALESCE(previous_key, 'new')
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'milestone_key', p_milestone_key,
    'current_milestone', COALESCE(previous_key, 'new'),
    'affected', COALESCE(affected, '[]'::jsonb)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_lost_reasons()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only process when final_status changes TO 'lost'
  IF NEW.final_status = 'lost' AND (OLD.final_status IS DISTINCT FROM 'lost' OR OLD.final_status IS NULL) THEN
    -- Auto-set lost_reason based on follow-up content heuristics
    -- (existing logic preserved, just trigger condition changed)
    NULL; -- Placeholder — existing logic continues below
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_lead_next_followup()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_lead_id UUID;
  v_new_min TIMESTAMPTZ;
  v_current TIMESTAMPTZ;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_lead_id := COALESCE(NEW.lead_id, OLD.lead_id);
  
  SELECT MIN(due_at) INTO v_new_min
  FROM tasks WHERE lead_id = v_lead_id AND status = 'pending';
  
  SELECT next_followup_date INTO v_current
  FROM leads WHERE id = v_lead_id;
  
  IF v_new_min IS NOT DISTINCT FROM v_current THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  
  UPDATE leads SET next_followup_date = v_new_min WHERE id = v_lead_id;
  RETURN COALESCE(NEW, OLD);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_task_from_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF OLD.next_followup_date IS NOT DISTINCT FROM NEW.next_followup_date THEN
    RETURN NEW;
  END IF;
  
  IF NEW.next_followup_date IS NULL THEN
    UPDATE tasks SET status = 'cancelled', completed_at = now()
    WHERE lead_id = NEW.id AND status = 'pending' AND source = 'system';
    RETURN NEW;
  END IF;
  
  INSERT INTO tasks (lead_id, title, assignee_id, due_at, source)
  VALUES (NEW.id, 'Follow up', NEW.assigned_to, NEW.next_followup_date, 'system')
  ON CONFLICT (lead_id) WHERE source = 'system' AND status = 'pending'
  DO UPDATE SET due_at = EXCLUDED.due_at, assignee_id = EXCLUDED.assignee_id;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_user_email_to_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles SET email = NEW.email WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.transition_lead_stage(p_lead_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_current_lead public.leads%ROWTYPE;
  v_updated_lead public.leads%ROWTYPE;
  v_allowed_next_stage text;
  v_clean_note text := btrim(coalesce(p_note, ''));
  v_complete_contacts integer;
  v_response jsonb;
BEGIN
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'INVALID_STAGE_REQUEST'; END IF;
  IF v_clean_note = '' THEN RAISE EXCEPTION 'Stage note is required'; END IF;
  IF char_length(v_clean_note) > 1000 THEN RAISE EXCEPTION 'Stage note must be 1000 characters or fewer'; END IF;
  IF p_next_stage IS NULL OR p_next_stage NOT IN (
    'new', 'contacted', 'requirement_confirmed', 'solution_submitted',
    'quotation_submitted', 'negotiation', 'pending_decision', 'won', 'lost'
  ) THEN RAISE EXCEPTION 'Invalid stage'; END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'Forbidden: invalid CRM role';
  END IF;

  SELECT response INTO v_response FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id AND operation = 'stage_transition' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_response || jsonb_build_object('idempotent_replay', true); END IF;

  SELECT * INTO v_current_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead not found'; END IF;

  -- Recheck after the lead lock so a concurrent retry cannot double-write.
  SELECT response INTO v_response FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id AND operation = 'stage_transition' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_response || jsonb_build_object('idempotent_replay', true); END IF;

  IF v_actor_role NOT IN ('admin', 'boss') AND v_current_lead.assigned_to IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'Forbidden: lead not assigned to you';
  END IF;
  IF v_current_lead.stage IS DISTINCT FROM p_expected_stage THEN RAISE EXCEPTION 'Lead stage changed concurrently'; END IF;
  IF v_current_lead.stage IN ('won', 'lost') OR v_current_lead.final_status IN ('won', 'lost') THEN
    RAISE EXCEPTION 'Terminal Lead stage cannot be changed';
  END IF;

  v_allowed_next_stage := CASE v_current_lead.stage
    WHEN 'new' THEN 'contacted'
    WHEN 'contacted' THEN 'requirement_confirmed'
    WHEN 'requirement_confirmed' THEN 'solution_submitted'
    WHEN 'solution_submitted' THEN 'quotation_submitted'
    WHEN 'quotation_submitted' THEN 'negotiation'
    WHEN 'negotiation' THEN 'pending_decision'
    ELSE NULL
  END;
  IF p_next_stage NOT IN ('won', 'lost') AND p_next_stage IS DISTINCT FROM v_allowed_next_stage THEN
    RAISE EXCEPTION 'Invalid stage transition from % to %', v_current_lead.stage, p_next_stage;
  END IF;

  IF v_current_lead.stage = 'new' AND p_next_stage <> 'new' THEN
    SELECT count(*) INTO v_complete_contacts FROM public.follow_up_logs
    WHERE lead_id = p_lead_id
      AND contact_time IS NOT NULL
      AND btrim(coalesce(contact_result, '')) <> '';
    IF v_complete_contacts < 1 OR coalesce(v_current_lead.quality, '') NOT IN ('good', 'normal', 'poor') THEN
      RAISE EXCEPTION 'First Contact requirements are incomplete';
    END IF;
  END IF;

  UPDATE public.leads
  SET stage = p_next_stage,
      final_status = CASE WHEN p_next_stage IN ('won', 'lost') THEN p_next_stage ELSE NULL END,
      stage_changed_at = now(), updated_at = now()
  WHERE id = p_lead_id
  RETURNING * INTO v_updated_lead;

  INSERT INTO public.business_events (lead_id, user_id, event_type, description, event_data, created_at)
  VALUES (
    p_lead_id, v_actor_id, 'stage_change',
    format('Stage changed from %s to %s: %s', v_current_lead.stage, p_next_stage, v_clean_note),
    jsonb_build_object('from', v_current_lead.stage, 'to', p_next_stage, 'note', v_clean_note), now()
  );
  v_response := jsonb_build_object(
    'id', v_updated_lead.id, 'stage', v_updated_lead.stage, 'final_status', v_updated_lead.final_status,
    'quality', v_updated_lead.quality, 'stage_changed_at', v_updated_lead.stage_changed_at, 'updated_at', v_updated_lead.updated_at
  );
  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'stage_transition', p_idempotency_key, p_lead_id, v_response);
  RETURN v_response;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_check_first_contact_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  complete_contact_count integer;
BEGIN
  -- Guard every attempt to leave the initial stage, including direct won/lost
  -- updates. This prevents API payload and direct table-update bypasses.
  IF OLD.stage IS DISTINCT FROM 'new'
     OR NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO complete_contact_count
  FROM public.follow_up_logs
  WHERE lead_id = NEW.id
    AND contact_time IS NOT NULL
    AND contact_result IS NOT NULL
    AND btrim(contact_result) <> '';

  IF complete_contact_count < 1 THEN
    RAISE EXCEPTION 'first_contact gate: at least one complete contact record is required';
  END IF;

  IF NEW.quality IS NULL OR NEW.quality NOT IN ('good', 'normal', 'poor') THEN
    RAISE EXCEPTION 'first_contact gate: quality must be good, normal, or poor before leaving new';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_check_stage_sequence()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  stage_order text[] := ARRAY['new','contacted','requirement_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision'];
  cur_idx int;
  new_idx int;
BEGIN
  -- No-op: same stage
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;

  -- Reject NULL stage (bypass prevention)
  IF NEW.stage IS NULL THEN
    RAISE EXCEPTION 'Stage cannot be set to NULL.';
  END IF;

  -- Reject transitions FROM terminal stages (won/lost are final)
  IF OLD.stage IN ('won', 'lost') THEN
    RAISE EXCEPTION 'Cannot change stage from terminal state: %.', OLD.stage;
  END IF;

  -- Initial create (OLD.stage IS NULL) — allow any valid stage
  IF OLD.stage IS NULL THEN
    new_idx := array_position(stage_order, NEW.stage);
    IF new_idx IS NOT NULL OR NEW.stage IN ('won', 'lost') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Invalid initial stage: %. Allowed: % or won/lost.', NEW.stage, array_to_string(stage_order, ', ');
  END IF;

  -- Terminal stages (won/lost) can be reached from any non-terminal stage
  IF NEW.stage IN ('won', 'lost') THEN
    RETURN NEW;
  END IF;

  -- Find current and new stage indices
  cur_idx := array_position(stage_order, OLD.stage);
  new_idx := array_position(stage_order, NEW.stage);

  -- Reject unknown stages (was: defensive allow; now: block)
  IF cur_idx IS NULL OR new_idx IS NULL THEN
    RAISE EXCEPTION 'Invalid stage transition. Current: %, attempted: %.', OLD.stage, NEW.stage;
  END IF;

  -- New stage must be the NEXT stage (cur_idx + 1)
  IF new_idx != cur_idx + 1 THEN
    RAISE EXCEPTION 'Stage must advance sequentially. Current: %, attempted: %. Next allowed: %.',
      OLD.stage, NEW.stage,
      CASE WHEN cur_idx + 1 <= array_length(stage_order, 1) THEN stage_order[cur_idx + 1] ELSE 'won or lost' END;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_enforce_first_contact_milestone()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  lead_quality text;
BEGIN
  IF NEW.milestone_key = 'first_contact' THEN
    SELECT quality INTO lead_quality
    FROM public.leads
    WHERE id = NEW.lead_id;

    IF lead_quality IS NULL OR lead_quality NOT IN ('good', 'normal', 'poor') THEN
      RAISE EXCEPTION 'first_contact milestone: quality must be assessed';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.follow_up_logs
      WHERE lead_id = NEW.lead_id
        AND contact_time IS NOT NULL
        AND contact_result IS NOT NULL
        AND btrim(contact_result) <> ''
    ) THEN
      RAISE EXCEPTION 'first_contact milestone: complete contact record required';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_prevent_first_contact_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.milestone_key = 'first_contact' AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'first_contact milestone is fact-driven and cannot be deleted';
  END IF;
  RETURN OLD;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_set_won_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.final_status = 'won'
     AND OLD.final_status IS DISTINCT FROM 'won'
     AND NEW.won_at IS NULL THEN
    NEW.won_at := now();
  END IF;

  IF NEW.final_status IS DISTINCT FROM 'won'
     AND OLD.final_status = 'won' THEN
    NEW.won_at := NULL;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_installment_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_plan_amount DECIMAL(12,2);
  v_contract_id UUID;
  v_total_paid  DECIMAL(12,2);
BEGIN
  IF NEW.confirmed != true OR NEW.installment_plan_id IS NULL THEN RETURN NEW; END IF;
  SELECT ip.amount, ip.contract_id INTO v_plan_amount, v_contract_id
  FROM public.installment_plans ip WHERE ip.id = NEW.installment_plan_id;
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.payments WHERE installment_plan_id = NEW.installment_plan_id AND confirmed = true;
  UPDATE public.installment_plans SET paid_amount = v_total_paid, updated_at = now()
  WHERE id = NEW.installment_plan_id;
  IF v_total_paid >= v_plan_amount THEN
    UPDATE public.installment_plans SET status = 'paid', updated_at = now()
    WHERE id = NEW.installment_plan_id AND status = 'pending';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.installment_plans
    WHERE contract_id = v_contract_id AND status NOT IN ('paid', 'cancelled')) THEN
    UPDATE public.contracts SET status = 'completed', updated_at = now()
    WHERE id = v_contract_id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_lead_metrics()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$ BEGIN IF NEW.last_contact_date IS NOT NULL AND NEW.last_contact_date IS DISTINCT FROM OLD.last_contact_date THEN NEW.days_since_last_contact := GREATEST(0, EXTRACT(DAY FROM NOW() - NEW.last_contact_date::TIMESTAMPTZ)::INTEGER); END IF; IF NEW.next_action IS DISTINCT FROM OLD.next_action AND NEW.next_action IS NOT NULL THEN NEW.followup_count := COALESCE(OLD.followup_count, 0) + 1; END IF; IF NEW.next_followup_date IS NOT NULL AND NEW.next_followup_date <= CURRENT_DATE THEN IF NEW.next_followup_date <= CURRENT_DATE - 7 THEN NEW.recovery_candidate := true; END IF; END IF; IF NEW.next_followup_date IS NOT NULL AND NEW.next_followup_date <= CURRENT_DATE THEN IF NEW.next_followup_date <= CURRENT_DATE - 14 THEN NEW.transfer_candidate := true; END IF; END IF; IF NEW.stage = 'quotation_submitted' THEN IF NEW.updated_at <= NOW() - INTERVAL '30 days' THEN NEW.transfer_candidate := true; ELSIF NEW.updated_at <= NOW() - INTERVAL '14 days' THEN NEW.recovery_candidate := true; END IF; END IF; IF NEW.win_probability >= 70 AND NEW.sales_manager_review IS DISTINCT FROM true THEN IF NEW.updated_at <= NOW() - INTERVAL '14 days' AND NEW.stage NOT IN ('won', 'lost') THEN NEW.sales_manager_review := true; END IF; END IF; IF NEW.stage = 'pending_decision' AND NEW.hold_since IS NULL THEN IF NEW.updated_at <= NOW() - INTERVAL '30 days' THEN NEW.sales_manager_review := true; NEW.hold_since := NEW.updated_at::date; END IF; END IF; IF NEW.next_followup_date IS NOT NULL AND NEW.next_followup_date > CURRENT_DATE THEN IF OLD.recovery_candidate = true THEN NEW.recovery_candidate := false; END IF; IF OLD.transfer_candidate = true AND NEW.next_followup_date > CURRENT_DATE + 7 THEN NEW.transfer_candidate := false; END IF; END IF; RETURN NEW; END; $function$
;

ALTER TABLE ONLY public.activities ADD CONSTRAINT activities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.activities ADD CONSTRAINT activities_priority_check CHECK (priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]));

ALTER TABLE ONLY public.activities ADD CONSTRAINT activities_type_check CHECK (type = ANY (ARRAY['call'::text, 'whatsapp'::text, 'wechat'::text, 'email'::text, 'meeting'::text, 'sms'::text, 'note'::text, 'task'::text, 'quote_sent'::text, 'follow_up'::text, 'stage_change'::text, 'quality_change'::text, 'contract_signed'::text, 'payment_received'::text, 'site_visit'::text, 'cad_review'::text, 'transfer'::text]));

ALTER TABLE ONLY public.activity_logs ADD CONSTRAINT activity_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ad_spend ADD CONSTRAINT ad_spend_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_log_archived_20260615 ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_logs ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.business_events ADD CONSTRAINT business_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.business_events ADD CONSTRAINT chk_event_type CHECK (event_type = ANY (ARRAY['stage_change'::text, 'lead_stale_detected'::text, 'transfer'::text, 'quotation_sent'::text, 'quotation_accepted'::text, 'quotation_rejected'::text, 'won'::text, 'lost'::text, 'contract_activated'::text, 'contract_completed'::text, 'payment_recorded'::text, 'owner_change'::text, 'quality_checked'::text, 'project_info_updated'::text, 'note_added'::text, 'probability_changed'::text, 'status_changed'::text, 'lost_reason_set'::text, 'followup_scheduled'::text, 'leads_archived'::text])) NOT VALID;

ALTER TABLE ONLY public.chat_messages ADD CONSTRAINT chat_messages_direction_check CHECK (direction = ANY (ARRAY['inbound'::text, 'outbound'::text]));

ALTER TABLE ONLY public.chat_messages ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chat_messages ADD CONSTRAINT chat_messages_wa_message_id_key UNIQUE (wa_message_id);

ALTER TABLE ONLY public.contract_approvals ADD CONSTRAINT contract_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contract_approvals ADD CONSTRAINT contract_approvals_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]));

ALTER TABLE ONLY public.contract_approvals ADD CONSTRAINT contract_approvals_step_check CHECK (step = ANY (ARRAY['admin_review'::text, 'ceo_review'::text]));

ALTER TABLE ONLY public.contracts ADD CONSTRAINT contracts_contract_amount_check CHECK (contract_amount > 0::numeric);

ALTER TABLE ONLY public.contracts ADD CONSTRAINT contracts_contract_no_key UNIQUE (contract_no);

ALTER TABLE ONLY public.contracts ADD CONSTRAINT contracts_first_payment_status_check CHECK (first_payment_status = ANY (ARRAY['unpaid'::text, 'partial'::text, 'paid'::text]));

ALTER TABLE ONLY public.contracts ADD CONSTRAINT contracts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contracts ADD CONSTRAINT contracts_status_check CHECK (status = ANY (ARRAY['draft'::text, 'pending_admin'::text, 'pending_ceo'::text, 'approved'::text, 'active'::text, 'revoking'::text, 'superseded'::text, 'suspended'::text, 'completed'::text, 'terminated'::text, 'rejected'::text]));

ALTER TABLE ONLY public.crm_daily_funnel_snapshot ADD CONSTRAINT crm_daily_funnel_snapshot_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.crm_daily_funnel_snapshot ADD CONSTRAINT crm_daily_funnel_snapshot_snapshot_date_current_milestone_key UNIQUE (snapshot_date, current_milestone);

ALTER TABLE ONLY public.customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.follow_up_logs ADD CONSTRAINT follow_up_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.installment_plans ADD CONSTRAINT installment_plans_amount_check CHECK (amount > 0::numeric);

ALTER TABLE ONLY public.installment_plans ADD CONSTRAINT installment_plans_contract_id_seq_key UNIQUE (contract_id, seq);

ALTER TABLE ONLY public.installment_plans ADD CONSTRAINT installment_plans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.installment_plans ADD CONSTRAINT installment_plans_status_check CHECK (status = ANY (ARRAY['pending'::text, 'partial'::text, 'paid'::text, 'overdue'::text, 'cancelled'::text]));

ALTER TABLE ONLY public.knx_designs ADD CONSTRAINT knx_designs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kpi_targets ADD CONSTRAINT kpi_targets_period_check CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'::text);

ALTER TABLE ONLY public.kpi_targets ADD CONSTRAINT kpi_targets_period_target_type_assigned_to_key UNIQUE (period, target_type, assigned_to);

ALTER TABLE ONLY public.kpi_targets ADD CONSTRAINT kpi_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kpi_targets ADD CONSTRAINT kpi_targets_target_amount_check CHECK (target_amount >= 0::numeric);

ALTER TABLE ONLY public.kpi_targets ADD CONSTRAINT kpi_targets_target_type_check CHECK (target_type = ANY (ARRAY['signing'::text, 'collection'::text]));

ALTER TABLE ONLY public.lead_deletion_requests ADD CONSTRAINT lead_deletion_requests_actor_id_idempotency_key_key UNIQUE (actor_id, idempotency_key);

ALTER TABLE ONLY public.lead_deletion_requests ADD CONSTRAINT lead_deletion_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_documents ADD CONSTRAINT lead_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_files ADD CONSTRAINT lead_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_milestones ADD CONSTRAINT lead_milestones_lead_id_milestone_key_key UNIQUE (lead_id, milestone_key);

ALTER TABLE ONLY public.lead_milestones ADD CONSTRAINT lead_milestones_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_milestones ADD CONSTRAINT milestone_key_valid CHECK (milestone_key = ANY (ARRAY['first_contact'::text, 'basic_info'::text, 'drawings'::text, 'requirements'::text, 'solution'::text, 'quotation'::text, 'meeting'::text])) NOT VALID;

ALTER TABLE ONLY public.lead_mutation_requests ADD CONSTRAINT lead_mutation_requests_actor_id_operation_idempotency_key_key UNIQUE (actor_id, operation, idempotency_key);

ALTER TABLE ONLY public.lead_mutation_requests ADD CONSTRAINT lead_mutation_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_workflow_stages ADD CONSTRAINT lead_workflow_stages_lead_id_stage_key_key UNIQUE (lead_id, stage_key);

ALTER TABLE ONLY public.lead_workflow_stages ADD CONSTRAINT lead_workflow_stages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_workflow_stages ADD CONSTRAINT lead_workflow_stages_stage_key_check CHECK (stage_key = ANY (ARRAY['requirement'::text, 'design'::text, 'quotation'::text, 'negotiation'::text, 'handover'::text]));

ALTER TABLE ONLY public.lead_workflow_stages ADD CONSTRAINT lead_workflow_stages_status_check CHECK (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'skipped'::text]));

ALTER TABLE ONLY public.lead_workflow_stages ADD CONSTRAINT lead_workflow_stages_weight_check CHECK (weight = ANY (ARRAY[20, 30, 50, 60, 80]));

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_ai_quality_check CHECK (ai_quality = ANY (ARRAY['hot'::text, 'warm'::text, 'cold'::text]));

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_contact_result_check CHECK (contact_result = ANY (ARRAY['interested'::text, 'not_interested'::text, 'no_answer'::text]));

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_project_type_check CHECK (project_type = ANY (ARRAY['villa'::text, 'apartment'::text, 'developer'::text, 'office'::text, 'commercial'::text, 'penthouse'::text, 'townhouse'::text, 'unknown'::text]));

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_quality_check CHECK (quality = ANY (ARRAY['pending'::text, 'valid'::text, 'job_seeker'::text, 'fake'::text, 'duplicate'::text, 'poor'::text, 'normal'::text, 'good'::text]));

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_source_check CHECK (source = ANY (ARRAY['ins'::text, 'fb'::text, 'show_room'::text, 'whatsapp'::text, 'website'::text, 'offline'::text, 'referral'::text, 'other'::text, 'unknown_import'::text, 'unknown'::text]));

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_stage_check CHECK (stage = ANY (ARRAY['new'::text, 'contacted'::text, 'no_answered'::text, 'requirement_confirmed'::text, 'solution_submitted'::text, 'quotation_submitted'::text, 'negotiation'::text, 'pending_decision'::text, 'won'::text, 'lost'::text, 'fake'::text]));

ALTER TABLE ONLY public.marketing_campaigns ADD CONSTRAINT marketing_campaigns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.meta_tokens ADD CONSTRAINT meta_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications ADD CONSTRAINT notifications_related_type_check CHECK (related_type IS NULL OR (related_type::text = ANY (ARRAY['lead'::character varying, 'contract'::character varying, 'payment'::character varying, 'kpi'::character varying, 'quote'::character varying]::text[])));

ALTER TABLE ONLY public.notifications ADD CONSTRAINT notifications_type_check CHECK (type::text = ANY (ARRAY['lead_created'::character varying, 'lead_stage_change'::character varying, 'lead_stage_changed'::character varying, 'lead_assigned'::character varying, 'quote_created'::character varying, 'followup_reminder'::character varying, 'follow_up_reminder'::character varying, 'follow_up_overdue'::character varying, 'contract_signed'::character varying, 'contract_rejected'::character varying, 'contract_superseded'::character varying, 'contract_approved'::character varying, 'contract_pending_approval'::character varying, 'payment_received'::character varying, 'payment_overdue'::character varying, 'payment_due'::character varying, 'first_payment_reminder'::character varying, 'kpi_target_set'::character varying, 'team_member_added'::character varying]::text[]));

ALTER TABLE ONLY public.payment_allocations ADD CONSTRAINT payment_allocations_amount_allocated_check CHECK (amount_allocated > 0::numeric);

ALTER TABLE ONLY public.payment_allocations ADD CONSTRAINT payment_allocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_amount_check CHECK (amount > 0::numeric);

ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_overpayment_action_check CHECK (overpayment_action = ANY (ARRAY['refund'::text, 'credit'::text, 'adjust'::text]));

ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_payment_method_check CHECK (payment_method = ANY (ARRAY['bank_transfer'::text, 'cash'::text, 'cheque'::text, 'card'::text, 'other'::text]));

ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pipeline_stages ADD CONSTRAINT pipeline_stages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.products ADD CONSTRAINT products_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.products ADD CONSTRAINT products_sku_key UNIQUE (sku);

ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_role_check CHECK (role = ANY (ARRAY['admin'::text, 'boss'::text, 'sales'::text, 'designer'::text, 'operator'::text, 'finance'::text]));

ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_phase_check CHECK (phase = ANY (ARRAY['design'::text, 'procurement'::text, 'installation'::text, 'commissioning'::text, 'handover'::text, 'warranty'::text, 'completed'::text]));

ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_status_check CHECK (status = ANY (ARRAY['active'::text, 'on_hold'::text, 'completed'::text, 'cancelled'::text]));

ALTER TABLE ONLY public.quotations ADD CONSTRAINT quotations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.quotations ADD CONSTRAINT quotations_quotation_type_check CHECK (quotation_type = ANY (ARRAY['standard'::text, 'variation'::text]));

ALTER TABLE ONLY public.quotations ADD CONSTRAINT quotations_quote_no_key UNIQUE (quote_no);

ALTER TABLE ONLY public.quotations ADD CONSTRAINT quotations_status_check CHECK (status = ANY (ARRAY['draft'::text, 'sent'::text, 'accepted'::text, 'rejected'::text, 'expired'::text, 'won'::text, 'contract_created'::text]));

ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_status_check CHECK (status = ANY (ARRAY['draft'::text, 'sent'::text, 'approved'::text, 'rejected'::text]));

ALTER TABLE ONLY public.tasks ADD CONSTRAINT tasks_future_only CHECK (due_at > (now() - '30 days'::interval));

ALTER TABLE ONLY public.tasks ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tasks ADD CONSTRAINT tasks_priority_check CHECK (priority IS NULL OR (priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text])));

ALTER TABLE ONLY public.tasks ADD CONSTRAINT tasks_source_check CHECK (source = ANY (ARRAY['manual'::text, 'follow_up'::text, 'cron'::text, 'system'::text]));

ALTER TABLE ONLY public.tasks ADD CONSTRAINT tasks_status_check CHECK (status = ANY (ARRAY['pending'::text, 'completed'::text, 'cancelled'::text]));

ALTER TABLE ONLY public.transfer_history ADD CONSTRAINT transfer_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_features ADD CONSTRAINT user_features_pkey PRIMARY KEY (user_id, feature_key);

ALTER TABLE ONLY public.user_session_daily ADD CONSTRAINT user_session_daily_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_session_daily ADD CONSTRAINT user_session_daily_user_id_session_date_key UNIQUE (user_id, session_date);

ALTER TABLE ONLY public.activities ADD CONSTRAINT activities_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id);

ALTER TABLE ONLY public.activities ADD CONSTRAINT activities_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);

ALTER TABLE ONLY public.activities ADD CONSTRAINT activities_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.activities ADD CONSTRAINT activities_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE ONLY public.activities ADD CONSTRAINT activities_quotation_id_fkey FOREIGN KEY (quotation_id) REFERENCES quotations(id);

ALTER TABLE ONLY public.activities ADD CONSTRAINT activities_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.activity_logs ADD CONSTRAINT activity_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.audit_log_archived_20260615 ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_logs ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.business_events ADD CONSTRAINT business_events_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.business_events ADD CONSTRAINT business_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.business_events ADD CONSTRAINT fk_business_events_user_id FOREIGN KEY (user_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.chat_messages ADD CONSTRAINT chat_messages_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.contract_approvals ADD CONSTRAINT contract_approvals_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.contract_approvals ADD CONSTRAINT contract_approvals_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.contracts ADD CONSTRAINT contracts_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE ONLY public.contracts ADD CONSTRAINT contracts_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.contracts ADD CONSTRAINT contracts_quotation_id_fkey FOREIGN KEY (quotation_id) REFERENCES quotations(id);

ALTER TABLE ONLY public.contracts ADD CONSTRAINT contracts_sales_id_fkey FOREIGN KEY (sales_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.customers ADD CONSTRAINT customers_assigned_sales_id_fkey FOREIGN KEY (assigned_sales_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.customers ADD CONSTRAINT customers_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id);

ALTER TABLE ONLY public.follow_up_logs ADD CONSTRAINT fk_follow_up_logs_created_by FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE ONLY public.follow_up_logs ADD CONSTRAINT fk_follow_up_logs_user_id FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.follow_up_logs ADD CONSTRAINT follow_up_logs_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.follow_up_logs ADD CONSTRAINT follow_up_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.installment_plans ADD CONSTRAINT installment_plans_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.knx_designs ADD CONSTRAINT knx_designs_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.kpi_targets ADD CONSTRAINT kpi_targets_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id);

ALTER TABLE ONLY public.kpi_targets ADD CONSTRAINT kpi_targets_set_by_fkey FOREIGN KEY (set_by) REFERENCES profiles(id);

ALTER TABLE ONLY public.lead_deletion_requests ADD CONSTRAINT lead_deletion_requests_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.lead_documents ADD CONSTRAINT lead_documents_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.lead_documents ADD CONSTRAINT lead_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.lead_files ADD CONSTRAINT lead_files_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.lead_files ADD CONSTRAINT lead_files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.lead_milestones ADD CONSTRAINT fk_lead_milestones_completed_by FOREIGN KEY (completed_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.lead_milestones ADD CONSTRAINT lead_milestones_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.lead_milestones ADD CONSTRAINT lead_milestones_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.lead_mutation_requests ADD CONSTRAINT lead_mutation_requests_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.lead_mutation_requests ADD CONSTRAINT lead_mutation_requests_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id);

ALTER TABLE ONLY public.lead_workflow_stages ADD CONSTRAINT lead_workflow_stages_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id);

ALTER TABLE ONLY public.lead_workflow_stages ADD CONSTRAINT lead_workflow_stages_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leads ADD CONSTRAINT fk_leads_assigned_to FOREIGN KEY (assigned_to) REFERENCES profiles(id);

ALTER TABLE ONLY public.leads ADD CONSTRAINT fk_leads_created_by FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE ONLY public.leads ADD CONSTRAINT fk_leads_customer_id FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id);

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_sales_manager_fkey FOREIGN KEY (sales_manager) REFERENCES profiles(id);

ALTER TABLE ONLY public.notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.payment_allocations ADD CONSTRAINT payment_allocations_allocated_by_fkey FOREIGN KEY (allocated_by) REFERENCES profiles(id);

ALTER TABLE ONLY public.payment_allocations ADD CONSTRAINT payment_allocations_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payment_allocations ADD CONSTRAINT payment_allocations_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES installment_plans(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES profiles(id);

ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_installment_plan_id_fkey FOREIGN KEY (installment_plan_id) REFERENCES installment_plans(id);

ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.projects ADD CONSTRAINT fk_projects_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id);

ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id);

ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);

ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_project_manager_fkey FOREIGN KEY (project_manager) REFERENCES profiles(id);

ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_sales_id_fkey FOREIGN KEY (sales_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.quotations ADD CONSTRAINT quotations_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id);

ALTER TABLE ONLY public.quotations ADD CONSTRAINT quotations_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE ONLY public.quotations ADD CONSTRAINT quotations_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id);

ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE ONLY public.tasks ADD CONSTRAINT tasks_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.tasks ADD CONSTRAINT tasks_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transfer_history ADD CONSTRAINT transfer_history_from_user_id_fkey FOREIGN KEY (from_user_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.transfer_history ADD CONSTRAINT transfer_history_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id);

ALTER TABLE ONLY public.transfer_history ADD CONSTRAINT transfer_history_to_user_id_fkey FOREIGN KEY (to_user_id) REFERENCES profiles(id);

ALTER TABLE ONLY public.transfer_history ADD CONSTRAINT transfer_history_transferred_by_fkey FOREIGN KEY (transferred_by) REFERENCES profiles(id);

ALTER TABLE ONLY public.user_features ADD CONSTRAINT user_features_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_session_daily ADD CONSTRAINT user_session_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id);

CREATE INDEX idx_activities_contract ON activities USING btree (contract_id);

CREATE INDEX idx_activities_created ON activities USING btree (created_at DESC);

CREATE INDEX idx_activities_due ON activities USING btree (due_at) WHERE is_completed = false;

CREATE INDEX idx_activities_lead ON activities USING btree (lead_id);

CREATE INDEX idx_activities_lead_created ON activities USING btree (lead_id, created_at DESC);

CREATE INDEX idx_activities_lead_type ON activities USING btree (lead_id, type);

CREATE INDEX idx_activities_quotation ON activities USING btree (quotation_id);

CREATE INDEX idx_activities_type ON activities USING btree (type);

CREATE INDEX idx_activities_user ON activities USING btree (user_id);

CREATE INDEX idx_activity_logs_action ON activity_logs USING btree (action);

CREATE INDEX idx_activity_logs_created ON activity_logs USING btree (created_at);

CREATE INDEX idx_activity_logs_entity ON activity_logs USING btree (entity_type, entity_id);

CREATE INDEX idx_activity_logs_tenant ON activity_logs USING btree (tenant_id);

CREATE INDEX idx_activity_logs_user ON activity_logs USING btree (user_id);

CREATE INDEX idx_ad_spend_campaign ON ad_spend USING btree (campaign_name);

CREATE INDEX idx_ad_spend_date ON ad_spend USING btree (spend_date);

CREATE INDEX idx_audit_log_event ON audit_log_archived_20260615 USING btree (event_type, created_at DESC);

CREATE INDEX idx_audit_log_user_time ON audit_log_archived_20260615 USING btree (user_id, created_at DESC);

CREATE INDEX idx_audit_logs_action ON audit_logs USING btree (action);

CREATE INDEX idx_audit_logs_actor ON audit_logs USING btree (actor_id);

CREATE INDEX idx_audit_logs_created ON audit_logs USING btree (created_at DESC);

CREATE INDEX idx_business_events_created ON business_events USING btree (created_at DESC);

CREATE INDEX idx_business_events_lead ON business_events USING btree (lead_id);

CREATE INDEX idx_business_events_lead_id ON business_events USING btree (lead_id);

CREATE INDEX idx_business_events_type ON business_events USING btree (event_type);

CREATE INDEX idx_business_events_user_id ON business_events USING btree (user_id);

CREATE INDEX idx_chat_lead_id ON chat_messages USING btree (lead_id);

CREATE INDEX idx_chat_messages_lead_id ON chat_messages USING btree (lead_id);

CREATE INDEX idx_chat_sent_at ON chat_messages USING btree (sent_at);

CREATE INDEX idx_contract_approvals_contract ON contract_approvals USING btree (contract_id);

CREATE INDEX idx_contract_approvals_status ON contract_approvals USING btree (status);

CREATE INDEX idx_contract_approvals_tenant ON contract_approvals USING btree (tenant_id);

CREATE INDEX idx_contracts_customer ON contracts USING btree (customer_id);

CREATE INDEX idx_contracts_date ON contracts USING btree (contract_date);

CREATE INDEX idx_contracts_lead ON contracts USING btree (lead_id);

CREATE INDEX idx_contracts_no ON contracts USING btree (contract_no);

CREATE UNIQUE INDEX idx_contracts_one_active_per_lead ON contracts USING btree (lead_id) WHERE status <> ALL (ARRAY['archived'::text, 'cancelled'::text, 'terminated'::text]);

CREATE INDEX idx_contracts_quotation ON contracts USING btree (quotation_id);

CREATE INDEX idx_contracts_sales ON contracts USING btree (sales_id);

CREATE INDEX idx_contracts_status ON contracts USING btree (status);

CREATE INDEX idx_customers_assigned_sales_id ON customers USING btree (assigned_sales_id);

CREATE INDEX idx_customers_lead_id ON customers USING btree (lead_id);

CREATE INDEX idx_customers_phone ON customers USING btree (phone);

CREATE INDEX idx_customers_sales ON customers USING btree (assigned_sales_id);

CREATE INDEX idx_follow_up_logs_created ON follow_up_logs USING btree (created_at DESC);

CREATE INDEX idx_follow_up_logs_lead ON follow_up_logs USING btree (lead_id);

CREATE INDEX idx_follow_up_logs_lead_id ON follow_up_logs USING btree (lead_id);

CREATE INDEX idx_follow_up_logs_user_id ON follow_up_logs USING btree (user_id);

CREATE INDEX idx_installment_contract ON installment_plans USING btree (contract_id);

CREATE INDEX idx_installment_due ON installment_plans USING btree (due_date) WHERE status = 'pending'::text;

CREATE INDEX idx_installment_status ON installment_plans USING btree (status);

CREATE INDEX idx_installments_status_due ON installment_plans USING btree (status, due_date);

CREATE INDEX idx_knx_designs_lead ON knx_designs USING btree (lead_id);

CREATE INDEX idx_knx_designs_status ON knx_designs USING btree (status);

CREATE INDEX idx_kpi_targets_assigned ON kpi_targets USING btree (assigned_to);

CREATE INDEX idx_kpi_targets_period ON kpi_targets USING btree (period);

CREATE INDEX idx_lead_documents_lead ON lead_documents USING btree (lead_id);

CREATE INDEX idx_lead_files_lead ON lead_files USING btree (lead_id);

CREATE INDEX idx_lead_milestones_completed ON lead_milestones USING btree (completed_at DESC);

CREATE INDEX idx_lead_milestones_lead ON lead_milestones USING btree (lead_id);

CREATE INDEX idx_lead_milestones_lead_id ON lead_milestones USING btree (lead_id);

CREATE INDEX idx_leads_archive_batch ON leads USING btree (archive_batch_id);

CREATE INDEX idx_leads_archived ON leads USING btree (archived) WHERE archived = true;

CREATE INDEX idx_leads_assigned_stage ON leads USING btree (assigned_to, stage);

CREATE INDEX idx_leads_assigned_to ON leads USING btree (assigned_to);

CREATE INDEX idx_leads_campaign ON leads USING btree (campaign_name);

CREATE INDEX idx_leads_campaign_name ON leads USING btree (campaign_name);

CREATE INDEX idx_leads_created_at ON leads USING btree (created_at DESC);

CREATE INDEX idx_leads_days_since_contact ON leads USING btree (days_since_last_contact);

CREATE INDEX idx_leads_funnel_stage ON leads USING btree (stage);

CREATE INDEX idx_leads_import_batch ON leads USING btree (import_batch_id);

CREATE INDEX idx_leads_last_contact_date ON leads USING btree (last_contact_date);

CREATE INDEX idx_leads_next_followup ON leads USING btree (next_followup_date);

CREATE INDEX idx_leads_next_followup_date ON leads USING btree (next_followup_date);

CREATE INDEX idx_leads_no_answer_flag ON leads USING btree (no_answer_flag) WHERE no_answer_flag = true;

CREATE INDEX idx_leads_owner ON leads USING btree (owner);

CREATE INDEX idx_leads_quality ON leads USING btree (quality);

CREATE INDEX idx_leads_quotation_value ON leads USING btree (quotation_value);

CREATE INDEX idx_leads_recovery ON leads USING btree (recovery_candidate) WHERE recovery_candidate = true;

CREATE INDEX idx_leads_recovery_candidate ON leads USING btree (recovery_candidate) WHERE recovery_candidate = true;

CREATE INDEX idx_leads_sales_manager ON leads USING btree (sales_manager);

CREATE INDEX idx_leads_sales_manager_review ON leads USING btree (sales_manager_review) WHERE sales_manager_review = true;

CREATE INDEX idx_leads_sales_review ON leads USING btree (sales_manager_review) WHERE sales_manager_review = true;

CREATE INDEX idx_leads_source ON leads USING btree (source);

CREATE INDEX idx_leads_source_platform ON leads USING btree (source_platform);

CREATE INDEX idx_leads_stage ON leads USING btree (stage);

CREATE INDEX idx_leads_status ON leads USING btree (lead_status);

CREATE INDEX idx_leads_transfer ON leads USING btree (transfer_candidate) WHERE transfer_candidate = true;

CREATE INDEX idx_leads_transfer_candidate ON leads USING btree (transfer_candidate) WHERE transfer_candidate = true;

CREATE INDEX idx_leads_updated ON leads USING btree (updated_at DESC);

CREATE INDEX idx_leads_win_probability ON leads USING btree (win_probability);

CREATE INDEX idx_leads_won_at ON leads USING btree (won_at) WHERE won_at IS NOT NULL;

CREATE INDEX idx_notifications_type ON notifications USING btree (type);

CREATE INDEX idx_notifications_user_read_created ON notifications USING btree (user_id, is_read, created_at DESC);

CREATE INDEX idx_payment_allocations_payment ON payment_allocations USING btree (payment_id);

CREATE INDEX idx_payment_allocations_plan ON payment_allocations USING btree (plan_id);

CREATE INDEX idx_payment_allocations_tenant ON payment_allocations USING btree (tenant_id);

CREATE INDEX idx_payments_contract ON payments USING btree (contract_id);

CREATE INDEX idx_payments_date ON payments USING btree (payment_date);

CREATE INDEX idx_payments_installment ON payments USING btree (installment_plan_id);

CREATE INDEX idx_payments_method ON payments USING btree (payment_method);

CREATE INDEX idx_payments_unconfirmed ON payments USING btree (confirmed) WHERE confirmed = false;

CREATE INDEX idx_pipeline_stages_order_index ON pipeline_stages USING btree (order_index);

CREATE INDEX idx_products_active ON products USING btree (is_active) WHERE is_active = true;

CREATE INDEX idx_products_category ON products USING btree (category);

CREATE INDEX idx_products_sku ON products USING btree (sku);

CREATE INDEX idx_profiles_active ON profiles USING btree (is_active) WHERE is_active = true;

CREATE UNIQUE INDEX idx_profiles_email ON profiles USING btree (email) WHERE email IS NOT NULL AND email <> ''::text;

CREATE INDEX idx_profiles_role ON profiles USING btree (role);

CREATE INDEX idx_projects_contract ON projects USING btree (contract_id);

CREATE INDEX idx_projects_customer ON projects USING btree (customer_id);

CREATE INDEX idx_projects_manager ON projects USING btree (project_manager);

CREATE INDEX idx_projects_phase ON projects USING btree (phase);

CREATE INDEX idx_projects_sales ON projects USING btree (sales_id);

CREATE INDEX idx_quotations_creator ON quotations USING btree (created_by);

CREATE INDEX idx_quotations_lead ON quotations USING btree (lead_id);

CREATE INDEX idx_quotations_no ON quotations USING btree (quote_no);

CREATE INDEX idx_quotations_status ON quotations USING btree (status);

CREATE INDEX idx_quotes_lead ON quotes USING btree (lead_id);

CREATE INDEX idx_quotes_project ON quotes USING btree (project_id);

CREATE INDEX idx_tasks_assignee ON tasks USING btree (assignee_id);

CREATE INDEX idx_tasks_due ON tasks USING btree (due_at) WHERE status = 'pending'::text;

CREATE INDEX idx_tasks_lead ON tasks USING btree (lead_id);

CREATE INDEX idx_tasks_lead_id_completed_at ON tasks USING btree (lead_id, completed_at);

CREATE UNIQUE INDEX idx_tasks_lead_system_pending ON tasks USING btree (lead_id) WHERE source = 'system'::text AND status = 'pending'::text;

CREATE INDEX idx_transfer_history_lead ON transfer_history USING btree (lead_id);

CREATE INDEX idx_user_session_daily_tenant ON user_session_daily USING btree (tenant_id);

CREATE INDEX idx_user_session_daily_user_date ON user_session_daily USING btree (user_id, session_date DESC);

CREATE INDEX idx_wf_assigned ON lead_workflow_stages USING btree (assigned_to);

CREATE INDEX idx_wf_lead ON lead_workflow_stages USING btree (lead_id);

CREATE INDEX idx_wf_status ON lead_workflow_stages USING btree (status);

CREATE UNIQUE INDEX kpi_targets_period_type_assigned_uniq ON kpi_targets USING btree (period, target_type, COALESCE(assigned_to, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE UNIQUE INDEX leads_import_fingerprint_unique ON leads USING btree (import_fingerprint);

CREATE UNIQUE INDEX uq_follow_up_logs_contact_fingerprint ON follow_up_logs USING btree (contact_fingerprint);

CREATE VIEW public.customer_summary WITH (security_invoker=on) AS
 SELECT id AS customer_id,
    name AS customer_name,
    assigned_sales_id,
    ( SELECT count(*) AS count
           FROM leads l
          WHERE l.id = c.lead_id) AS total_leads,
    ( SELECT count(*) AS count
           FROM leads l
          WHERE l.id = c.lead_id AND l.stage = 'won'::text) AS won_leads,
    ( SELECT count(*) AS count
           FROM contracts ct
          WHERE ct.customer_id = c.id) AS total_contracts,
    ( SELECT COALESCE(sum(ct.contract_amount), 0::numeric) AS "coalesce"
           FROM contracts ct
          WHERE ct.customer_id = c.id) AS total_contract_amount,
    ( SELECT COALESCE(sum(p.amount), 0::numeric) AS "coalesce"
           FROM payments p
             JOIN contracts ct ON ct.id = p.contract_id
          WHERE ct.customer_id = c.id AND p.confirmed = true) AS total_paid
   FROM customers c;;

CREATE VIEW public.lead_alerts WITH (security_invoker=true) AS
 SELECT id,
    customer_name,
    phone,
    stage AS funnel_stage,
    lead_status,
    quotation_value,
    win_probability,
    assigned_to,
    rep_name,
    next_followup_date,
    last_contact_date,
    followup_count,
    next_action,
    stage_changed_at,
    recovery_candidate,
    transfer_candidate,
    sales_manager_review,
    hold_since,
        CASE
            WHEN next_followup_date IS NOT NULL AND next_followup_date = CURRENT_DATE THEN 'due_today'::text
            WHEN next_followup_date IS NOT NULL AND next_followup_date < CURRENT_DATE THEN 'overdue_followup'::text
            WHEN last_contact_date IS NOT NULL AND last_contact_date < (CURRENT_DATE - '7 days'::interval) AND (stage <> ALL (ARRAY['won'::text, 'lost'::text])) THEN 'stale_lead'::text
            WHEN followup_count >= 5 AND stage = 'new'::text THEN 'over_contacted'::text
            WHEN quotation_value > 50000::numeric AND stage = 'quotation_submitted'::text AND quotation_sent_date IS NOT NULL AND quotation_sent_date < (CURRENT_DATE - '14 days'::interval) THEN 'high_value_stuck'::text
            WHEN last_contact_date IS NULL AND (stage <> ALL (ARRAY['won'::text, 'lost'::text])) THEN 'no_contact'::text
            ELSE NULL::text
        END AS alert_type,
        CASE
            WHEN next_followup_date IS NOT NULL AND next_followup_date = CURRENT_DATE THEN '今日需跟进'::text
            WHEN next_followup_date IS NOT NULL AND next_followup_date < CURRENT_DATE THEN '逾期未跟进，已超过预定跟进日期'::text
            WHEN last_contact_date IS NOT NULL AND last_contact_date < (CURRENT_DATE - '7 days'::interval) AND (stage <> ALL (ARRAY['won'::text, 'lost'::text])) THEN '超过7天未联系，建议尽快跟进'::text
            WHEN followup_count >= 5 AND stage = 'new'::text THEN '已联系5次以上但仍在新线索阶段，建议降级或淘汰'::text
            WHEN quotation_value > 50000::numeric AND stage = 'quotation_submitted'::text AND quotation_sent_date IS NOT NULL AND quotation_sent_date < (CURRENT_DATE - '14 days'::interval) THEN '高金额报价已提交超14天无进展，建议重点跟进'::text
            WHEN last_contact_date IS NULL AND (stage <> ALL (ARRAY['won'::text, 'lost'::text])) THEN '从未联系过，需要首次触达'::text
            ELSE NULL::text
        END AS alert_message,
        CASE
            WHEN next_followup_date IS NOT NULL AND next_followup_date < CURRENT_DATE THEN 'red'::text
            WHEN last_contact_date IS NOT NULL AND last_contact_date < (CURRENT_DATE - '7 days'::interval) THEN 'red'::text
            WHEN followup_count >= 5 AND stage = 'new'::text THEN 'red'::text
            WHEN last_contact_date IS NULL THEN 'red'::text
            WHEN quotation_value > 50000::numeric AND stage = 'quotation_submitted'::text THEN 'yellow'::text
            WHEN next_followup_date IS NOT NULL AND next_followup_date = CURRENT_DATE THEN 'yellow'::text
            ELSE NULL::text
        END AS severity,
    CURRENT_DATE - last_contact_date AS days_since_contact
   FROM leads l
  WHERE disqualified_candidate = false AND (stage <> ALL (ARRAY['won'::text, 'lost'::text]));;

CREATE VIEW public.lead_funnel_daily WITH (security_invoker=on) AS
 SELECT date_trunc('day'::text, created_at) AS day,
    source,
    quality,
    stage,
    count(*) AS count
   FROM leads
  GROUP BY (date_trunc('day'::text, created_at)), source, quality, stage
  ORDER BY (date_trunc('day'::text, created_at)) DESC;;

CREATE VIEW public.pipeline_summary WITH (security_invoker=on) AS
 SELECT stage AS funnel_stage,
    count(*) AS lead_count,
    count(*) FILTER (WHERE lead_status = 'hot'::text) AS hot_count,
    count(*) FILTER (WHERE recovery_candidate = true) AS recovery_count,
    count(*) FILTER (WHERE transfer_candidate = true) AS transfer_count,
    sum(quotation_value) AS total_value,
    avg(win_probability) AS avg_probability,
    sum(quotation_value * COALESCE(win_probability, 0)::numeric / 100.0) AS weighted_value
   FROM leads
  WHERE stage <> ALL (ARRAY['won'::text, 'lost'::text])
  GROUP BY stage
  ORDER BY (array_position(ARRAY['new'::text, 'contacted'::text, 'requirement_confirmed'::text, 'solution_submitted'::text, 'quotation_submitted'::text, 'negotiation'::text, 'pending_decision'::text], stage));;

CREATE VIEW public.revenue_forecast WITH (security_invoker=on) AS
 SELECT stage AS funnel_stage,
    count(*) AS deal_count,
    COALESCE(sum(quotation_value), 0::numeric) AS total_value,
        CASE stage
            WHEN 'quotation_submitted'::text THEN COALESCE(sum(quotation_value), 0::numeric) * 0.40
            WHEN 'contacted'::text THEN COALESCE(sum(quotation_value), 0::numeric) * 0.15
            WHEN 'new'::text THEN COALESCE(sum(quotation_value), 0::numeric) * 0.05
            ELSE 0::numeric
        END AS weighted_value
   FROM leads
  WHERE disqualified_candidate = false AND (stage <> ALL (ARRAY['lost'::text, 'won'::text]))
  GROUP BY stage;;

CREATE VIEW public.sales_performance WITH (security_invoker=on) AS
 SELECT p.id,
    p.full_name,
    count(l.id) FILTER (WHERE l.stage = 'new'::text) AS new_leads,
    count(l.id) FILTER (WHERE l.stage = 'quoted'::text) AS quoted,
    count(l.id) FILTER (WHERE l.stage = 'won'::text) AS won,
    count(l.id) FILTER (WHERE l.stage = 'lost'::text) AS lost,
        CASE
            WHEN count(l.id) > 0 THEN round(count(l.id) FILTER (WHERE l.stage = 'won'::text)::numeric / count(l.id)::numeric * 100::numeric, 1)
            ELSE 0::numeric
        END AS conversion_rate
   FROM profiles p
     LEFT JOIN leads l ON l.assigned_to = p.id
  WHERE p.role = 'sales'::text
  GROUP BY p.id, p.full_name;;

CREATE VIEW public.v_account_receivable_aging WITH (security_invoker=on) AS
 SELECT c.id AS contract_id,
    c.contract_no,
    c.contract_amount,
    c.party_a_name AS customer_name,
    c.sales_id,
    COALESCE(sum(p.amount) FILTER (WHERE p.confirmed = true), 0::numeric) AS total_paid,
    c.contract_amount - COALESCE(sum(p.amount) FILTER (WHERE p.confirmed = true), 0::numeric) AS total_unpaid,
    count(ip.id) FILTER (WHERE ip.status = 'overdue'::text) AS overdue_installments,
        CASE
            WHEN c.contract_amount > 0::numeric THEN round(COALESCE(sum(p.amount) FILTER (WHERE p.confirmed = true), 0::numeric) / c.contract_amount * 100::numeric, 1)
            ELSE 0::numeric
        END AS payment_rate
   FROM contracts c
     LEFT JOIN installment_plans ip ON ip.contract_id = c.id
     LEFT JOIN payments p ON p.contract_id = c.id
  GROUP BY c.id, c.contract_no, c.contract_amount, c.party_a_name, c.sales_id;;

CREATE VIEW public.v_funnel_conversion WITH (security_invoker=on) AS
 SELECT stage,
    count(*) AS lead_count,
    COALESCE(sum(quotation_value), 0::numeric) AS pipeline_value,
    round(count(*)::numeric / NULLIF(( SELECT count(*) AS count
           FROM leads leads_1), 0)::numeric * 100::numeric, 1) AS pct_of_total
   FROM leads
  WHERE NOT COALESCE(disqualified_candidate, false)
  GROUP BY stage
  ORDER BY (count(*)) DESC;;

CREATE VIEW public.v_lead_trace WITH (security_invoker=on) AS
 SELECT l.id AS lead_id,
    l.customer_name,
    l.stage,
    l.quotation_value,
    q.id AS quotation_id,
    q.total_amount AS quotation_price,
    q.status AS quotation_status,
    c.id AS contract_id,
    c.contract_no,
    c.contract_amount,
    c.status AS contract_status,
    ip.id AS installment_id,
    ip.seq,
    ip.amount AS installment_amount,
    ip.due_date,
    ip.status AS installment_status,
    p.id AS payment_id,
    p.amount AS payment_amount,
    p.payment_date,
    p.confirmed,
    pr.id AS project_id,
    pr.name AS project_name,
    pr.phase AS project_phase,
    pr.status AS project_status
   FROM leads l
     LEFT JOIN quotations q ON q.lead_id = l.id
     LEFT JOIN contracts c ON c.lead_id = l.id
     LEFT JOIN installment_plans ip ON ip.contract_id = c.id
     LEFT JOIN payments p ON p.contract_id = c.id
     LEFT JOIN projects pr ON pr.lead_id = l.id;;

CREATE VIEW public.v_risk_pool WITH (security_invoker=on) AS
 SELECT id,
    customer_name,
    phone,
    stage,
    assigned_to,
    next_followup_date,
    next_action,
        CASE
            WHEN next_followup_date IS NULL THEN 'missing'::text
            WHEN next_followup_date < CURRENT_DATE THEN 'overdue'::text
            ELSE 'ok'::text
        END AS risk_level,
    COALESCE(CURRENT_DATE - next_followup_date, 999) AS days_overdue
   FROM leads
  WHERE (stage <> ALL (ARRAY['won'::text, 'lost'::text])) AND (next_followup_date IS NULL OR next_followup_date < CURRENT_DATE)
  ORDER BY (COALESCE(CURRENT_DATE - next_followup_date, 999)) DESC;;

CREATE VIEW public.v_sales_personal_stats WITH (security_invoker=on) AS
 SELECT p.id AS user_id,
    p.full_name,
    count(l.id) FILTER (WHERE (l.stage <> ALL (ARRAY['won'::text, 'lost'::text])) AND NOT COALESCE(l.disqualified_candidate, false)) AS active_leads,
    count(l.id) FILTER (WHERE l.stage = 'won'::text) AS won_leads,
    count(l.id) FILTER (WHERE l.stage = 'lost'::text) AS lost_leads,
    count(c.id) AS active_contracts,
        CASE
            WHEN count(l.id) > 0 THEN round(count(l.id) FILTER (WHERE l.stage = 'won'::text)::numeric / count(l.id)::numeric * 100::numeric, 1)
            ELSE 0::numeric
        END AS conversion_rate
   FROM profiles p
     LEFT JOIN leads l ON l.assigned_to = p.id
     LEFT JOIN contracts c ON c.sales_id = p.id AND c.status = 'active'::text
  WHERE p.role = 'sales'::text
  GROUP BY p.id, p.full_name;;

CREATE VIEW public.v_stagnant_leads WITH (security_invoker=on) AS
 SELECT l.id,
    l.customer_name,
    l.stage,
    l.assigned_to,
    p.full_name AS sales_name,
    l.created_at,
    ( SELECT max(a.created_at) AS max
           FROM activities a
          WHERE a.lead_id = l.id) AS last_activity_at,
    EXTRACT(day FROM now() - COALESCE(( SELECT max(a.created_at) AS max
           FROM activities a
          WHERE a.lead_id = l.id), l.created_at)) AS days_inactive
   FROM leads l
     LEFT JOIN profiles p ON p.id = l.assigned_to
  WHERE (l.stage <> ALL (ARRAY['won'::text, 'lost'::text])) AND NOT COALESCE(l.disqualified_candidate, false) AND EXTRACT(day FROM now() - COALESCE(( SELECT max(a.created_at) AS max
           FROM activities a
          WHERE a.lead_id = l.id), l.created_at)) > 7::numeric
  ORDER BY (EXTRACT(day FROM now() - COALESCE(( SELECT max(a.created_at) AS max
           FROM activities a
          WHERE a.lead_id = l.id), l.created_at))) DESC;;

CREATE VIEW public.v_unified_timeline WITH (security_invoker=on) AS
 SELECT activities.id,
    activities.lead_id,
    activities.user_id,
    activities.type AS event_type,
    activities.content AS description,
    activities.created_at,
    'activity'::text AS source
   FROM activities
UNION ALL
 SELECT business_events.id,
    business_events.lead_id,
    business_events.user_id,
    business_events.event_type,
    business_events.description,
    business_events.created_at,
    'event'::text AS source
   FROM business_events
UNION ALL
 SELECT chat_messages.id,
    chat_messages.lead_id,
    NULL::uuid AS user_id,
    chat_messages.direction AS event_type,
    chat_messages.content AS description,
    chat_messages.created_at,
    'chat'::text AS source
   FROM chat_messages
  ORDER BY 6 DESC;;

CREATE TRIGGER trg_auto_create_task AFTER INSERT ON follow_up_logs FOR EACH ROW WHEN (new.next_action IS NOT NULL AND new.next_action <> ''::text) EXECUTE FUNCTION auto_create_task_from_followup();

CREATE TRIGGER trg_check_milestone_order BEFORE INSERT ON lead_milestones FOR EACH ROW EXECUTE FUNCTION check_milestone_order();

CREATE TRIGGER trg_enforce_first_contact_milestone BEFORE INSERT ON lead_milestones FOR EACH ROW EXECUTE FUNCTION trg_enforce_first_contact_milestone();

CREATE TRIGGER trg_prevent_first_contact_delete BEFORE DELETE ON lead_milestones FOR EACH ROW EXECUTE FUNCTION trg_prevent_first_contact_delete();

CREATE TRIGGER enforce_active_lead_insert_assignee BEFORE INSERT ON leads FOR EACH ROW EXECUTE FUNCTION enforce_active_lead_transfer_candidate();

CREATE TRIGGER enforce_active_lead_transfer_candidate BEFORE UPDATE OF assigned_to ON leads FOR EACH ROW EXECUTE FUNCTION enforce_active_lead_transfer_candidate();

CREATE TRIGGER trg_check_stage_sequence BEFORE UPDATE OF stage ON leads FOR EACH ROW EXECUTE FUNCTION trg_check_stage_sequence();

CREATE TRIGGER trg_derive_lead_status BEFORE INSERT OR UPDATE OF last_contact_date, stage ON leads FOR EACH ROW EXECUTE FUNCTION derive_lead_status();

CREATE TRIGGER trg_enforce_followup BEFORE INSERT OR UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION enforce_followup_required();

CREATE TRIGGER trg_first_contact_gate BEFORE UPDATE OF stage ON leads FOR EACH ROW EXECUTE FUNCTION trg_check_first_contact_gate();

CREATE TRIGGER trg_lead_won AFTER UPDATE OF final_status ON leads FOR EACH ROW WHEN (new.final_status = 'won'::text) EXECUTE FUNCTION on_lead_won();

CREATE TRIGGER trg_leads_set_won_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION trg_set_won_at();

CREATE TRIGGER trg_set_lost_reasons AFTER UPDATE OF final_status ON leads FOR EACH ROW WHEN (new.final_status = 'lost'::text AND (old.final_status IS DISTINCT FROM 'lost'::text OR old.final_status IS NULL)) EXECUTE FUNCTION set_lost_reasons();

CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sync_task_from_lead AFTER UPDATE OF next_followup_date ON leads FOR EACH ROW EXECUTE FUNCTION sync_task_from_lead();

CREATE TRIGGER trg_update_lead_metrics BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION update_lead_metrics();

CREATE TRIGGER trg_payment_after_insert AFTER INSERT OR UPDATE OF confirmed ON payments FOR EACH ROW WHEN (new.confirmed = true AND new.installment_plan_id IS NOT NULL) EXECUTE FUNCTION update_installment_status();

CREATE TRIGGER trg_sync_lead_from_tasks AFTER INSERT OR DELETE OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION sync_lead_next_followup();

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.ad_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_spend NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.audit_log_archived_20260615 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log_archived_20260615 NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.business_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_events NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.contract_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_approvals NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contracts NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.crm_daily_funnel_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_daily_funnel_snapshot NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.follow_up_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_logs NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.installment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.installment_plans NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.knx_designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knx_designs NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.kpi_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_targets NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.lead_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_deletion_requests NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.lead_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_documents NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.lead_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_files NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.lead_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_milestones NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.lead_mutation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_mutation_requests NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.lead_workflow_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_workflow_stages NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.marketing_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaigns NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.meta_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_tokens NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_allocations NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_stages NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotations NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.transfer_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfer_history NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.user_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_features NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.user_session_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_session_daily NO FORCE ROW LEVEL SECURITY;

CREATE POLICY policy_activities_delete_admin ON public.activities AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_activities_delete_sales ON public.activities AS PERMISSIVE FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE POLICY policy_activities_insert_admin ON public.activities AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_activities_insert_designer ON public.activities AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_activities_insert_sales ON public.activities AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY policy_activities_select_admin ON public.activities AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_activities_select_designer ON public.activities AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_activities_select_finance ON public.activities AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_activities_select_sales ON public.activities AS PERMISSIVE FOR SELECT TO authenticated USING ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY policy_activities_update_admin ON public.activities AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_activities_update_sales ON public.activities AS PERMISSIVE FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY boss_admin_see_all_activity ON public.activity_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['boss'::text, 'admin'::text])))));

CREATE POLICY policy_activity_logs_delete_none ON public.activity_logs AS PERMISSIVE FOR DELETE TO authenticated USING (false);

CREATE POLICY policy_activity_logs_insert_authenticated ON public.activity_logs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY policy_activity_logs_select_admin ON public.activity_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_activity_logs_select_owner ON public.activity_logs AS PERMISSIVE FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY policy_activity_logs_update_none ON public.activity_logs AS PERMISSIVE FOR UPDATE TO authenticated USING (false);

CREATE POLICY sales_see_own_activity ON public.activity_logs AS PERMISSIVE FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY policy_ad_spend_delete_admin ON public.ad_spend AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_ad_spend_insert_admin ON public.ad_spend AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_ad_spend_select_admin ON public.ad_spend AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_ad_spend_select_finance ON public.ad_spend AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_ad_spend_update_admin ON public.ad_spend AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_ad_spend_update_finance ON public.ad_spend AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY "Admins read all audit logs" ON public.audit_log_archived_20260615 AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'admin'::text)));

CREATE POLICY "Users insert own audit events" ON public.audit_log_archived_20260615 AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users read own audit logs" ON public.audit_log_archived_20260615 AS PERMISSIVE FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY policy_audit_logs_delete_none ON public.audit_logs AS PERMISSIVE FOR DELETE TO authenticated USING (false);

CREATE POLICY policy_audit_logs_insert_authenticated ON public.audit_logs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY policy_audit_logs_select_admin ON public.audit_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_audit_logs_update_none ON public.audit_logs AS PERMISSIVE FOR UPDATE TO authenticated USING (false);

CREATE POLICY policy_business_events_delete_admin ON public.business_events AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_business_events_insert_admin ON public.business_events AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_business_events_insert_sales ON public.business_events AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() AND (EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = business_events.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_business_events_select_admin ON public.business_events AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_business_events_select_designer ON public.business_events AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_business_events_select_finance ON public.business_events AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_business_events_select_sales ON public.business_events AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = business_events.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_business_events_update_admin ON public.business_events AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY chat_messages_sales_insert ON public.chat_messages AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM leads l
  WHERE l.id = chat_messages.lead_id AND l.assigned_to = auth.uid())));

CREATE POLICY chat_messages_sales_select ON public.chat_messages AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads l
  WHERE l.id = chat_messages.lead_id AND l.assigned_to = auth.uid())));

CREATE POLICY policy_contract_approvals_delete_admin ON public.contract_approvals AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_contract_approvals_insert_admin ON public.contract_approvals AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_contract_approvals_select_admin ON public.contract_approvals AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_contract_approvals_select_finance ON public.contract_approvals AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_contract_approvals_select_sales ON public.contract_approvals AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM contracts
  WHERE contracts.id = contract_approvals.contract_id AND contracts.sales_id = auth.uid())));

CREATE POLICY policy_contract_approvals_update_admin ON public.contract_approvals AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_contracts_delete_admin ON public.contracts AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_contracts_delete_finance ON public.contracts AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_contracts_insert_admin ON public.contracts AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_contracts_insert_finance ON public.contracts AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_contracts_insert_sales ON public.contracts AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (sales_id = auth.uid());

CREATE POLICY policy_contracts_select_admin ON public.contracts AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_contracts_select_finance ON public.contracts AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_contracts_select_sales ON public.contracts AS PERMISSIVE FOR SELECT TO authenticated USING (sales_id = auth.uid());

CREATE POLICY policy_contracts_update_admin ON public.contracts AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_contracts_update_finance ON public.contracts AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_contracts_update_sales ON public.contracts AS PERMISSIVE FOR UPDATE TO authenticated USING (sales_id = auth.uid());

CREATE POLICY policy_crm_daily_funnel_snapshot_delete_admin ON public.crm_daily_funnel_snapshot AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_crm_daily_funnel_snapshot_insert_admin ON public.crm_daily_funnel_snapshot AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_crm_daily_funnel_snapshot_select_admin ON public.crm_daily_funnel_snapshot AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY policy_crm_daily_funnel_snapshot_select_designer ON public.crm_daily_funnel_snapshot AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_crm_daily_funnel_snapshot_select_sales ON public.crm_daily_funnel_snapshot AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'sales'::text)));

CREATE POLICY policy_crm_daily_funnel_snapshot_update_admin ON public.crm_daily_funnel_snapshot AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_customers_delete_admin ON public.customers AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_customers_delete_sales ON public.customers AS PERMISSIVE FOR DELETE TO authenticated USING (assigned_sales_id = auth.uid());

CREATE POLICY policy_customers_insert_admin ON public.customers AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_customers_insert_sales ON public.customers AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (assigned_sales_id = auth.uid());

CREATE POLICY policy_customers_select_admin ON public.customers AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_customers_select_designer ON public.customers AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_customers_select_finance ON public.customers AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_customers_select_sales ON public.customers AS PERMISSIVE FOR SELECT TO authenticated USING (assigned_sales_id = auth.uid());

CREATE POLICY policy_customers_update_admin ON public.customers AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_customers_update_boss ON public.customers AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'boss'::text)));

CREATE POLICY policy_customers_update_sales ON public.customers AS PERMISSIVE FOR UPDATE TO authenticated USING (assigned_sales_id = auth.uid()) WITH CHECK (assigned_sales_id = auth.uid());

CREATE POLICY policy_follow_up_logs_delete_deny ON public.follow_up_logs AS PERMISSIVE FOR DELETE TO authenticated USING (false);

CREATE POLICY policy_follow_up_logs_insert_admin ON public.follow_up_logs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_follow_up_logs_insert_boss ON public.follow_up_logs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'boss'::text)));

CREATE POLICY policy_follow_up_logs_insert_operator ON public.follow_up_logs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'operator'::text)));

CREATE POLICY policy_follow_up_logs_insert_sales ON public.follow_up_logs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = follow_up_logs.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_follow_up_logs_select_admin ON public.follow_up_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_follow_up_logs_select_boss ON public.follow_up_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'boss'::text)));

CREATE POLICY policy_follow_up_logs_select_operator ON public.follow_up_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'operator'::text)));

CREATE POLICY policy_follow_up_logs_select_sales ON public.follow_up_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = follow_up_logs.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_follow_up_logs_update_deny ON public.follow_up_logs AS PERMISSIVE FOR UPDATE TO authenticated USING (false);

CREATE POLICY policy_installment_plans_delete_admin ON public.installment_plans AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_installment_plans_insert_admin ON public.installment_plans AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY policy_installment_plans_select_admin ON public.installment_plans AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY policy_installment_plans_select_sales ON public.installment_plans AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM contracts c
  WHERE c.id = installment_plans.contract_id AND c.sales_id = auth.uid())));

CREATE POLICY policy_installment_plans_update_admin ON public.installment_plans AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY knx_designs_select_assigned ON public.knx_designs AS PERMISSIVE FOR SELECT TO authenticated USING ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY policy_knx_designs_delete_admin ON public.knx_designs AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_knx_designs_insert_admin ON public.knx_designs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_knx_designs_insert_sales ON public.knx_designs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY policy_knx_designs_select_admin ON public.knx_designs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_knx_designs_select_designer ON public.knx_designs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_knx_designs_select_finance ON public.knx_designs AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_knx_designs_update_admin ON public.knx_designs AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_knx_designs_update_sales ON public.knx_designs AS PERMISSIVE FOR UPDATE TO authenticated USING ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid()))) WITH CHECK ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY policy_kpi_targets_delete_admin ON public.kpi_targets AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_kpi_targets_insert_admin ON public.kpi_targets AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_kpi_targets_select_admin ON public.kpi_targets AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_kpi_targets_select_finance ON public.kpi_targets AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_kpi_targets_select_sales ON public.kpi_targets AS PERMISSIVE FOR SELECT TO authenticated USING (assigned_to = auth.uid() OR assigned_to IS NULL);

CREATE POLICY policy_kpi_targets_update_admin ON public.kpi_targets AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY "Default deny all" ON public.lead_deletion_requests AS PERMISSIVE FOR ALL TO PUBLIC USING (false);

CREATE POLICY policy_lead_documents_delete_admin ON public.lead_documents AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'admin'::text)));

CREATE POLICY policy_lead_documents_delete_boss ON public.lead_documents AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'boss'::text)));

CREATE POLICY policy_lead_documents_insert_admin ON public.lead_documents AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_documents_insert_sales ON public.lead_documents AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = lead_documents.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_lead_documents_select_admin ON public.lead_documents AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_documents_select_designer ON public.lead_documents AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_lead_documents_select_finance ON public.lead_documents AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_lead_documents_select_sales ON public.lead_documents AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = lead_documents.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_lead_documents_update_admin ON public.lead_documents AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_documents_update_sales ON public.lead_documents AS PERMISSIVE FOR UPDATE TO authenticated USING ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid()))) WITH CHECK ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY lead_files_insert_staff ON public.lead_files AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (uploaded_by = auth.uid() OR (get_my_role() = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])));

CREATE POLICY lead_files_select_assigned ON public.lead_files AS PERMISSIVE FOR SELECT TO authenticated USING ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY policy_lead_files_delete_admin ON public.lead_files AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_lead_files_insert_admin ON public.lead_files AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_files_insert_sales ON public.lead_files AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY policy_lead_files_select_admin ON public.lead_files AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_files_select_designer ON public.lead_files AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_lead_files_select_finance ON public.lead_files AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_lead_files_update_admin ON public.lead_files AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_milestones_delete_admin ON public.lead_milestones AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_lead_milestones_insert_admin ON public.lead_milestones AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_milestones_insert_sales ON public.lead_milestones AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY policy_lead_milestones_select_admin ON public.lead_milestones AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_milestones_select_designer ON public.lead_milestones AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_lead_milestones_select_sales ON public.lead_milestones AS PERMISSIVE FOR SELECT TO authenticated USING ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY policy_lead_milestones_update_admin ON public.lead_milestones AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_milestones_update_sales ON public.lead_milestones AS PERMISSIVE FOR UPDATE TO authenticated USING ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY "Default deny all" ON public.lead_mutation_requests AS PERMISSIVE FOR ALL TO PUBLIC USING (false);

CREATE POLICY policy_lead_workflow_stages_delete_admin ON public.lead_workflow_stages AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_lead_workflow_stages_insert_admin ON public.lead_workflow_stages AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_workflow_stages_insert_sales ON public.lead_workflow_stages AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM leads l
  WHERE l.id = lead_workflow_stages.lead_id AND l.assigned_to = auth.uid())));

CREATE POLICY policy_lead_workflow_stages_select_admin ON public.lead_workflow_stages AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_workflow_stages_select_designer ON public.lead_workflow_stages AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_lead_workflow_stages_select_sales ON public.lead_workflow_stages AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads l
  WHERE l.id = lead_workflow_stages.lead_id AND l.assigned_to = auth.uid())));

CREATE POLICY policy_lead_workflow_stages_update_admin ON public.lead_workflow_stages AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_lead_workflow_stages_update_sales ON public.lead_workflow_stages AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads l
  WHERE l.id = lead_workflow_stages.lead_id AND l.assigned_to = auth.uid())));

CREATE POLICY policy_leads_delete_admin ON public.leads AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_leads_delete_sales ON public.leads AS PERMISSIVE FOR DELETE TO authenticated USING (assigned_to = auth.uid());

CREATE POLICY policy_leads_insert_admin ON public.leads AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_leads_insert_boss ON public.leads AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'boss'::text)));

CREATE POLICY policy_leads_insert_sales ON public.leads AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (assigned_to = auth.uid() OR assigned_to IS NULL);

CREATE POLICY policy_leads_select_admin ON public.leads AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_leads_select_sales ON public.leads AS PERMISSIVE FOR SELECT TO authenticated USING (assigned_to = auth.uid());

CREATE POLICY policy_leads_update_admin ON public.leads AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_leads_update_sales ON public.leads AS PERMISSIVE FOR UPDATE TO authenticated USING (assigned_to = auth.uid());

CREATE POLICY policy_marketing_campaigns_delete_admin ON public.marketing_campaigns AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_marketing_campaigns_insert_admin ON public.marketing_campaigns AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_marketing_campaigns_select_admin ON public.marketing_campaigns AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_marketing_campaigns_select_designer ON public.marketing_campaigns AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_marketing_campaigns_update_admin ON public.marketing_campaigns AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_meta_tokens_delete_admin ON public.meta_tokens AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_meta_tokens_insert_admin ON public.meta_tokens AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_meta_tokens_select_admin ON public.meta_tokens AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_meta_tokens_select_authenticated ON public.meta_tokens AS PERMISSIVE FOR SELECT TO authenticated USING (true);

CREATE POLICY policy_meta_tokens_update_admin ON public.meta_tokens AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_notifications_delete_self ON public.notifications AS PERMISSIVE FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE POLICY policy_notifications_insert_admin ON public.notifications AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'admin'::text)));

CREATE POLICY policy_notifications_insert_system ON public.notifications AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY policy_notifications_select_admin ON public.notifications AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_notifications_select_self ON public.notifications AS PERMISSIVE FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY policy_notifications_update_self ON public.notifications AS PERMISSIVE FOR UPDATE TO authenticated USING (user_id = auth.uid());

CREATE POLICY policy_payment_allocations_delete_admin ON public.payment_allocations AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_payment_allocations_insert_admin ON public.payment_allocations AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY policy_payment_allocations_select_admin ON public.payment_allocations AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY policy_payment_allocations_select_sales ON public.payment_allocations AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM contracts c
     JOIN payments p ON p.contract_id = c.id
  WHERE p.id = payment_allocations.payment_id AND c.sales_id = auth.uid())));

CREATE POLICY policy_payment_allocations_update_admin ON public.payment_allocations AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY policy_payments_delete_admin ON public.payments AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_payments_delete_sales ON public.payments AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM contracts
  WHERE contracts.id = payments.contract_id AND contracts.sales_id = auth.uid())));

CREATE POLICY policy_payments_insert_admin ON public.payments AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY policy_payments_insert_finance ON public.payments AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_payments_insert_sales ON public.payments AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM contracts
  WHERE contracts.id = payments.contract_id AND contracts.sales_id = auth.uid())));

CREATE POLICY policy_payments_select_admin ON public.payments AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY policy_payments_select_sales ON public.payments AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM contracts
  WHERE contracts.id = payments.contract_id AND contracts.sales_id = auth.uid())));

CREATE POLICY policy_payments_update_admin ON public.payments AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text, 'finance'::text])))));

CREATE POLICY policy_payments_update_sales ON public.payments AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM contracts
  WHERE contracts.id = payments.contract_id AND contracts.sales_id = auth.uid())));

CREATE POLICY policy_pipeline_stages_delete_admin ON public.pipeline_stages AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_pipeline_stages_insert_admin ON public.pipeline_stages AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_pipeline_stages_select_authenticated ON public.pipeline_stages AS PERMISSIVE FOR SELECT TO authenticated USING (true);

CREATE POLICY policy_pipeline_stages_select_designer ON public.pipeline_stages AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_pipeline_stages_update_admin ON public.pipeline_stages AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_products_delete_admin ON public.products AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_products_delete_designer ON public.products AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_products_insert_admin ON public.products AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_products_insert_designer ON public.products AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_products_select_admin ON public.products AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_products_select_all ON public.products AS PERMISSIVE FOR SELECT TO authenticated USING (true);

CREATE POLICY policy_products_select_designer ON public.products AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_products_select_finance ON public.products AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_products_select_sales ON public.products AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'sales'::text)));

CREATE POLICY policy_products_update_admin ON public.products AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_products_update_designer ON public.products AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_profiles_delete_admin ON public.profiles AS PERMISSIVE FOR DELETE TO authenticated USING (get_my_role() = ANY (ARRAY['admin'::text, 'boss'::text]));

CREATE POLICY policy_profiles_insert_admin ON public.profiles AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (get_my_role() = ANY (ARRAY['admin'::text, 'boss'::text]));

CREATE POLICY policy_profiles_select_admin ON public.profiles AS PERMISSIVE FOR SELECT TO authenticated USING (get_my_role() = ANY (ARRAY['admin'::text, 'boss'::text]));

CREATE POLICY policy_profiles_select_operator ON public.profiles AS PERMISSIVE FOR SELECT TO authenticated USING (get_my_role() = 'operator'::text);

CREATE POLICY policy_profiles_select_self ON public.profiles AS PERMISSIVE FOR SELECT TO authenticated USING (id = auth.uid());

CREATE POLICY policy_profiles_update_admin ON public.profiles AS PERMISSIVE FOR UPDATE TO authenticated USING (get_my_role() = ANY (ARRAY['admin'::text, 'boss'::text]));

CREATE POLICY policy_profiles_update_self ON public.profiles AS PERMISSIVE FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid() AND ((get_my_role() = ANY (ARRAY['admin'::text, 'boss'::text])) OR role = get_my_role()));

CREATE POLICY policy_projects_delete_admin ON public.projects AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_projects_insert_admin ON public.projects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_projects_insert_designer ON public.projects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_projects_insert_sales ON public.projects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (sales_id = auth.uid());

CREATE POLICY policy_projects_select_admin ON public.projects AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_projects_select_designer ON public.projects AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_projects_select_sales ON public.projects AS PERMISSIVE FOR SELECT TO authenticated USING (sales_id = auth.uid());

CREATE POLICY policy_projects_update_admin ON public.projects AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_projects_update_designer ON public.projects AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_projects_update_sales ON public.projects AS PERMISSIVE FOR UPDATE TO authenticated USING (sales_id = auth.uid()) WITH CHECK (sales_id = auth.uid());

CREATE POLICY policy_quotations_delete_admin ON public.quotations AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_quotations_delete_operator ON public.quotations AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'operator'::text)));

CREATE POLICY policy_quotations_delete_sales ON public.quotations AS PERMISSIVE FOR DELETE TO authenticated USING (created_by = auth.uid());

CREATE POLICY policy_quotations_insert_admin ON public.quotations AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_quotations_insert_operator ON public.quotations AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'operator'::text)));

CREATE POLICY policy_quotations_insert_sales ON public.quotations AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid() AND (EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = quotations.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_quotations_select_admin ON public.quotations AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_quotations_select_finance ON public.quotations AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_quotations_select_sales ON public.quotations AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = quotations.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_quotations_update_admin ON public.quotations AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_quotations_update_operator ON public.quotations AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'operator'::text)));

CREATE POLICY policy_quotations_update_sales ON public.quotations AS PERMISSIVE FOR UPDATE TO authenticated USING (created_by = auth.uid());

CREATE POLICY policy_quotes_delete_admin ON public.quotes AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_quotes_insert_admin ON public.quotes AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_quotes_select_admin ON public.quotes AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_quotes_update_admin ON public.quotes AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY quotes_sales_insert ON public.quotes AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (get_my_role() = 'sales'::text AND (lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY quotes_sales_select ON public.quotes AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads l
  WHERE l.id = quotes.lead_id AND l.assigned_to = auth.uid())));

CREATE POLICY policy_tasks_delete_admin ON public.tasks AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_tasks_delete_operator ON public.tasks AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'operator'::text)));

CREATE POLICY policy_tasks_delete_sales ON public.tasks AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = tasks.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_tasks_insert_admin ON public.tasks AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_tasks_insert_operator ON public.tasks AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'operator'::text)));

CREATE POLICY policy_tasks_insert_sales ON public.tasks AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = tasks.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_tasks_select_admin ON public.tasks AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_tasks_select_operator ON public.tasks AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'operator'::text)));

CREATE POLICY policy_tasks_select_sales ON public.tasks AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = tasks.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_tasks_update_admin ON public.tasks AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_tasks_update_operator ON public.tasks AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'operator'::text)));

CREATE POLICY policy_tasks_update_sales ON public.tasks AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM leads
  WHERE leads.id = tasks.lead_id AND leads.assigned_to = auth.uid())));

CREATE POLICY policy_transfer_history_delete_admin ON public.transfer_history AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_transfer_history_insert_admin ON public.transfer_history AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_transfer_history_select_admin ON public.transfer_history AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text, 'operator'::text])))));

CREATE POLICY policy_transfer_history_select_designer ON public.transfer_history AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'designer'::text)));

CREATE POLICY policy_transfer_history_select_finance ON public.transfer_history AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND profiles.role = 'finance'::text)));

CREATE POLICY policy_transfer_history_update_admin ON public.transfer_history AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY transfer_sales_insert ON public.transfer_history AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (get_my_role() = 'sales'::text AND (lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY transfer_sales_select ON public.transfer_history AS PERMISSIVE FOR SELECT TO authenticated USING ((lead_id IN ( SELECT leads.id
   FROM leads
  WHERE leads.assigned_to = auth.uid())));

CREATE POLICY policy_user_features_delete_admin ON public.user_features AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_user_features_insert_admin ON public.user_features AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_user_features_select_admin ON public.user_features AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_user_features_select_owner ON public.user_features AS PERMISSIVE FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY policy_user_features_update_admin ON public.user_features AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY boss_admin_see_all_sessions ON public.user_session_daily AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['boss'::text, 'admin'::text])))));

CREATE POLICY policy_user_session_daily_delete_admin ON public.user_session_daily AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_user_session_daily_insert_authenticated ON public.user_session_daily AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY policy_user_session_daily_select_admin ON public.user_session_daily AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY policy_user_session_daily_select_owner ON public.user_session_daily AS PERMISSIVE FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY policy_user_session_daily_update_admin ON public.user_session_daily AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE profiles.id = auth.uid() AND (profiles.role = ANY (ARRAY['admin'::text, 'boss'::text])))));

CREATE POLICY sales_see_own_sessions ON public.user_session_daily AS PERMISSIVE FOR SELECT TO authenticated USING (user_id = auth.uid());

COMMENT ON SCHEMA public IS 'standard public schema';

COMMENT ON COLUMN public.follow_up_logs.next_followup_date IS '下次跟进日期（从 leads 同步），用于 auto_create_task trigger 读取';

COMMENT ON COLUMN public.leads.import_fingerprint IS 'SHA-256 fingerprint of a normalized source workbook row; prevents repeat-upload duplicates.';

COMMENT ON FUNCTION public.auto_create_task_from_followup() IS '从 follow_up_log 自动创建 task。due_at 优先读 next_followup_date，否则默认 24h 后。ON CONFLICT 只处理重复插入，约束违反会报错。蒸馏友好：无 SECURITY DEFINER。';

COMMENT ON FUNCTION public.sync_lead_next_followup() IS 'tasks 变更时同步 leads.next_followup_date。循环防护：pg_trigger_depth() > 1 时返回。蒸馏友好：无 SECURITY DEFINER。';

COMMENT ON FUNCTION public.sync_task_from_lead() IS 'leads.next_followup_date 变更时同步 tasks。循环防护：pg_trigger_depth() > 1。变化检测：OLD IS NOT DISTINCT FROM NEW。蒸馏友好：无 SECURITY DEFINER。';

REVOKE ALL PRIVILEGES ON TABLE public.activities FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.activities FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.activities FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.activities FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.activity_logs FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.activity_logs FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.activity_logs FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.activity_logs FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.ad_spend FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.ad_spend FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.ad_spend FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.ad_spend FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.audit_log_archived_20260615 FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.audit_log_archived_20260615 FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.audit_log_archived_20260615 FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.audit_log_archived_20260615 FROM service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE public.audit_log_id_seq FROM PUBLIC;

REVOKE ALL PRIVILEGES ON SEQUENCE public.audit_log_id_seq FROM anon;

REVOKE ALL PRIVILEGES ON SEQUENCE public.audit_log_id_seq FROM authenticated;

REVOKE ALL PRIVILEGES ON SEQUENCE public.audit_log_id_seq FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.audit_logs FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.audit_logs FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.audit_logs FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.audit_logs FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.business_events FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.business_events FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.business_events FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.business_events FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.chat_messages FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.chat_messages FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.chat_messages FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.chat_messages FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.contract_approvals FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.contract_approvals FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.contract_approvals FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.contract_approvals FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.contracts FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.contracts FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.contracts FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.contracts FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.crm_daily_funnel_snapshot FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.crm_daily_funnel_snapshot FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.crm_daily_funnel_snapshot FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.crm_daily_funnel_snapshot FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.customer_summary FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.customer_summary FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.customer_summary FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.customer_summary FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.customers FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.customers FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.customers FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.customers FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.follow_up_logs FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.follow_up_logs FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.follow_up_logs FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.follow_up_logs FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.installment_plans FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.installment_plans FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.installment_plans FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.installment_plans FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.knx_designs FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.knx_designs FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.knx_designs FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.knx_designs FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.kpi_targets FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.kpi_targets FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.kpi_targets FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.kpi_targets FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.lead_alerts FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.lead_alerts FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.lead_alerts FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.lead_alerts FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.lead_deletion_requests FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.lead_deletion_requests FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.lead_deletion_requests FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.lead_deletion_requests FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.lead_documents FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.lead_documents FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.lead_documents FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.lead_documents FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.lead_files FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.lead_files FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.lead_files FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.lead_files FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.lead_funnel_daily FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.lead_funnel_daily FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.lead_funnel_daily FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.lead_funnel_daily FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.lead_milestones FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.lead_milestones FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.lead_milestones FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.lead_milestones FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.lead_mutation_requests FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.lead_mutation_requests FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.lead_mutation_requests FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.lead_mutation_requests FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.lead_workflow_stages FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.lead_workflow_stages FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.lead_workflow_stages FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.lead_workflow_stages FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.leads FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.leads FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.leads FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.leads FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.marketing_campaigns FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.marketing_campaigns FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.marketing_campaigns FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.marketing_campaigns FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.meta_tokens FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.meta_tokens FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.meta_tokens FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.meta_tokens FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.notifications FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.notifications FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.notifications FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.notifications FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.payment_allocations FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.payment_allocations FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.payment_allocations FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.payment_allocations FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.payments FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.payments FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.payments FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.payments FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.pipeline_stages FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.pipeline_stages FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.pipeline_stages FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.pipeline_stages FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.pipeline_summary FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.pipeline_summary FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.pipeline_summary FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.pipeline_summary FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.products FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.products FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.products FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.products FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.projects FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.projects FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.projects FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.projects FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.quotations FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.quotations FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.quotations FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.quotations FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.quotes FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.quotes FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.quotes FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.quotes FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.revenue_forecast FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.revenue_forecast FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.revenue_forecast FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.revenue_forecast FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.sales_performance FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.sales_performance FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.sales_performance FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.sales_performance FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.tasks FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.tasks FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.tasks FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.tasks FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.transfer_history FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.transfer_history FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.transfer_history FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.transfer_history FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.user_features FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.user_features FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.user_features FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.user_features FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.user_session_daily FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.user_session_daily FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.user_session_daily FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.user_session_daily FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.v_account_receivable_aging FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.v_account_receivable_aging FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.v_account_receivable_aging FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.v_account_receivable_aging FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.v_funnel_conversion FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.v_funnel_conversion FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.v_funnel_conversion FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.v_funnel_conversion FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.v_lead_trace FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.v_lead_trace FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.v_lead_trace FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.v_lead_trace FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.v_risk_pool FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.v_risk_pool FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.v_risk_pool FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.v_risk_pool FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.v_sales_personal_stats FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.v_sales_personal_stats FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.v_sales_personal_stats FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.v_sales_personal_stats FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.v_stagnant_leads FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.v_stagnant_leads FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.v_stagnant_leads FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.v_stagnant_leads FROM service_role;

REVOKE ALL PRIVILEGES ON TABLE public.v_unified_timeline FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.v_unified_timeline FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.v_unified_timeline FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.v_unified_timeline FROM service_role;

GRANT DELETE ON TABLE public.activities TO anon;

GRANT INSERT ON TABLE public.activities TO anon;

GRANT MAINTAIN ON TABLE public.activities TO anon;

GRANT REFERENCES ON TABLE public.activities TO anon;

GRANT SELECT ON TABLE public.activities TO anon;

GRANT TRIGGER ON TABLE public.activities TO anon;

GRANT TRUNCATE ON TABLE public.activities TO anon;

GRANT UPDATE ON TABLE public.activities TO anon;

GRANT DELETE ON TABLE public.activities TO authenticated;

GRANT INSERT ON TABLE public.activities TO authenticated;

GRANT MAINTAIN ON TABLE public.activities TO authenticated;

GRANT REFERENCES ON TABLE public.activities TO authenticated;

GRANT SELECT ON TABLE public.activities TO authenticated;

GRANT TRIGGER ON TABLE public.activities TO authenticated;

GRANT TRUNCATE ON TABLE public.activities TO authenticated;

GRANT UPDATE ON TABLE public.activities TO authenticated;

GRANT DELETE ON TABLE public.activities TO service_role;

GRANT INSERT ON TABLE public.activities TO service_role;

GRANT MAINTAIN ON TABLE public.activities TO service_role;

GRANT REFERENCES ON TABLE public.activities TO service_role;

GRANT SELECT ON TABLE public.activities TO service_role;

GRANT TRIGGER ON TABLE public.activities TO service_role;

GRANT TRUNCATE ON TABLE public.activities TO service_role;

GRANT UPDATE ON TABLE public.activities TO service_role;

GRANT DELETE ON TABLE public.activity_logs TO anon;

GRANT INSERT ON TABLE public.activity_logs TO anon;

GRANT MAINTAIN ON TABLE public.activity_logs TO anon;

GRANT REFERENCES ON TABLE public.activity_logs TO anon;

GRANT SELECT ON TABLE public.activity_logs TO anon;

GRANT TRIGGER ON TABLE public.activity_logs TO anon;

GRANT TRUNCATE ON TABLE public.activity_logs TO anon;

GRANT UPDATE ON TABLE public.activity_logs TO anon;

GRANT DELETE ON TABLE public.activity_logs TO authenticated;

GRANT INSERT ON TABLE public.activity_logs TO authenticated;

GRANT MAINTAIN ON TABLE public.activity_logs TO authenticated;

GRANT REFERENCES ON TABLE public.activity_logs TO authenticated;

GRANT SELECT ON TABLE public.activity_logs TO authenticated;

GRANT TRIGGER ON TABLE public.activity_logs TO authenticated;

GRANT TRUNCATE ON TABLE public.activity_logs TO authenticated;

GRANT UPDATE ON TABLE public.activity_logs TO authenticated;

GRANT DELETE ON TABLE public.activity_logs TO service_role;

GRANT INSERT ON TABLE public.activity_logs TO service_role;

GRANT MAINTAIN ON TABLE public.activity_logs TO service_role;

GRANT REFERENCES ON TABLE public.activity_logs TO service_role;

GRANT SELECT ON TABLE public.activity_logs TO service_role;

GRANT TRIGGER ON TABLE public.activity_logs TO service_role;

GRANT TRUNCATE ON TABLE public.activity_logs TO service_role;

GRANT UPDATE ON TABLE public.activity_logs TO service_role;

GRANT DELETE ON TABLE public.ad_spend TO anon;

GRANT INSERT ON TABLE public.ad_spend TO anon;

GRANT MAINTAIN ON TABLE public.ad_spend TO anon;

GRANT REFERENCES ON TABLE public.ad_spend TO anon;

GRANT SELECT ON TABLE public.ad_spend TO anon;

GRANT TRIGGER ON TABLE public.ad_spend TO anon;

GRANT TRUNCATE ON TABLE public.ad_spend TO anon;

GRANT UPDATE ON TABLE public.ad_spend TO anon;

GRANT DELETE ON TABLE public.ad_spend TO authenticated;

GRANT INSERT ON TABLE public.ad_spend TO authenticated;

GRANT MAINTAIN ON TABLE public.ad_spend TO authenticated;

GRANT REFERENCES ON TABLE public.ad_spend TO authenticated;

GRANT SELECT ON TABLE public.ad_spend TO authenticated;

GRANT TRIGGER ON TABLE public.ad_spend TO authenticated;

GRANT TRUNCATE ON TABLE public.ad_spend TO authenticated;

GRANT UPDATE ON TABLE public.ad_spend TO authenticated;

GRANT DELETE ON TABLE public.ad_spend TO service_role;

GRANT INSERT ON TABLE public.ad_spend TO service_role;

GRANT MAINTAIN ON TABLE public.ad_spend TO service_role;

GRANT REFERENCES ON TABLE public.ad_spend TO service_role;

GRANT SELECT ON TABLE public.ad_spend TO service_role;

GRANT TRIGGER ON TABLE public.ad_spend TO service_role;

GRANT TRUNCATE ON TABLE public.ad_spend TO service_role;

GRANT UPDATE ON TABLE public.ad_spend TO service_role;

GRANT DELETE ON TABLE public.audit_log_archived_20260615 TO anon;

GRANT INSERT ON TABLE public.audit_log_archived_20260615 TO anon;

GRANT MAINTAIN ON TABLE public.audit_log_archived_20260615 TO anon;

GRANT REFERENCES ON TABLE public.audit_log_archived_20260615 TO anon;

GRANT SELECT ON TABLE public.audit_log_archived_20260615 TO anon;

GRANT TRIGGER ON TABLE public.audit_log_archived_20260615 TO anon;

GRANT TRUNCATE ON TABLE public.audit_log_archived_20260615 TO anon;

GRANT UPDATE ON TABLE public.audit_log_archived_20260615 TO anon;

GRANT DELETE ON TABLE public.audit_log_archived_20260615 TO authenticated;

GRANT INSERT ON TABLE public.audit_log_archived_20260615 TO authenticated;

GRANT MAINTAIN ON TABLE public.audit_log_archived_20260615 TO authenticated;

GRANT REFERENCES ON TABLE public.audit_log_archived_20260615 TO authenticated;

GRANT SELECT ON TABLE public.audit_log_archived_20260615 TO authenticated;

GRANT TRIGGER ON TABLE public.audit_log_archived_20260615 TO authenticated;

GRANT TRUNCATE ON TABLE public.audit_log_archived_20260615 TO authenticated;

GRANT UPDATE ON TABLE public.audit_log_archived_20260615 TO authenticated;

GRANT DELETE ON TABLE public.audit_log_archived_20260615 TO service_role;

GRANT INSERT ON TABLE public.audit_log_archived_20260615 TO service_role;

GRANT MAINTAIN ON TABLE public.audit_log_archived_20260615 TO service_role;

GRANT REFERENCES ON TABLE public.audit_log_archived_20260615 TO service_role;

GRANT SELECT ON TABLE public.audit_log_archived_20260615 TO service_role;

GRANT TRIGGER ON TABLE public.audit_log_archived_20260615 TO service_role;

GRANT TRUNCATE ON TABLE public.audit_log_archived_20260615 TO service_role;

GRANT UPDATE ON TABLE public.audit_log_archived_20260615 TO service_role;

GRANT SELECT ON SEQUENCE public.audit_log_id_seq TO anon;

GRANT UPDATE ON SEQUENCE public.audit_log_id_seq TO anon;

GRANT USAGE ON SEQUENCE public.audit_log_id_seq TO anon;

GRANT SELECT ON SEQUENCE public.audit_log_id_seq TO authenticated;

GRANT UPDATE ON SEQUENCE public.audit_log_id_seq TO authenticated;

GRANT USAGE ON SEQUENCE public.audit_log_id_seq TO authenticated;

GRANT SELECT ON SEQUENCE public.audit_log_id_seq TO service_role;

GRANT UPDATE ON SEQUENCE public.audit_log_id_seq TO service_role;

GRANT USAGE ON SEQUENCE public.audit_log_id_seq TO service_role;

GRANT DELETE ON TABLE public.audit_logs TO anon;

GRANT INSERT ON TABLE public.audit_logs TO anon;

GRANT MAINTAIN ON TABLE public.audit_logs TO anon;

GRANT REFERENCES ON TABLE public.audit_logs TO anon;

GRANT SELECT ON TABLE public.audit_logs TO anon;

GRANT TRIGGER ON TABLE public.audit_logs TO anon;

GRANT TRUNCATE ON TABLE public.audit_logs TO anon;

GRANT UPDATE ON TABLE public.audit_logs TO anon;

GRANT DELETE ON TABLE public.audit_logs TO authenticated;

GRANT INSERT ON TABLE public.audit_logs TO authenticated;

GRANT MAINTAIN ON TABLE public.audit_logs TO authenticated;

GRANT REFERENCES ON TABLE public.audit_logs TO authenticated;

GRANT SELECT ON TABLE public.audit_logs TO authenticated;

GRANT TRIGGER ON TABLE public.audit_logs TO authenticated;

GRANT TRUNCATE ON TABLE public.audit_logs TO authenticated;

GRANT UPDATE ON TABLE public.audit_logs TO authenticated;

GRANT DELETE ON TABLE public.audit_logs TO service_role;

GRANT INSERT ON TABLE public.audit_logs TO service_role;

GRANT MAINTAIN ON TABLE public.audit_logs TO service_role;

GRANT REFERENCES ON TABLE public.audit_logs TO service_role;

GRANT SELECT ON TABLE public.audit_logs TO service_role;

GRANT TRIGGER ON TABLE public.audit_logs TO service_role;

GRANT TRUNCATE ON TABLE public.audit_logs TO service_role;

GRANT UPDATE ON TABLE public.audit_logs TO service_role;

GRANT DELETE ON TABLE public.business_events TO anon;

GRANT INSERT ON TABLE public.business_events TO anon;

GRANT MAINTAIN ON TABLE public.business_events TO anon;

GRANT REFERENCES ON TABLE public.business_events TO anon;

GRANT SELECT ON TABLE public.business_events TO anon;

GRANT TRIGGER ON TABLE public.business_events TO anon;

GRANT TRUNCATE ON TABLE public.business_events TO anon;

GRANT UPDATE ON TABLE public.business_events TO anon;

GRANT DELETE ON TABLE public.business_events TO authenticated;

GRANT INSERT ON TABLE public.business_events TO authenticated;

GRANT MAINTAIN ON TABLE public.business_events TO authenticated;

GRANT REFERENCES ON TABLE public.business_events TO authenticated;

GRANT SELECT ON TABLE public.business_events TO authenticated;

GRANT TRIGGER ON TABLE public.business_events TO authenticated;

GRANT TRUNCATE ON TABLE public.business_events TO authenticated;

GRANT UPDATE ON TABLE public.business_events TO authenticated;

GRANT DELETE ON TABLE public.business_events TO service_role;

GRANT INSERT ON TABLE public.business_events TO service_role;

GRANT MAINTAIN ON TABLE public.business_events TO service_role;

GRANT REFERENCES ON TABLE public.business_events TO service_role;

GRANT SELECT ON TABLE public.business_events TO service_role;

GRANT TRIGGER ON TABLE public.business_events TO service_role;

GRANT TRUNCATE ON TABLE public.business_events TO service_role;

GRANT UPDATE ON TABLE public.business_events TO service_role;

GRANT DELETE ON TABLE public.chat_messages TO anon;

GRANT INSERT ON TABLE public.chat_messages TO anon;

GRANT MAINTAIN ON TABLE public.chat_messages TO anon;

GRANT REFERENCES ON TABLE public.chat_messages TO anon;

GRANT SELECT ON TABLE public.chat_messages TO anon;

GRANT TRIGGER ON TABLE public.chat_messages TO anon;

GRANT TRUNCATE ON TABLE public.chat_messages TO anon;

GRANT UPDATE ON TABLE public.chat_messages TO anon;

GRANT DELETE ON TABLE public.chat_messages TO authenticated;

GRANT INSERT ON TABLE public.chat_messages TO authenticated;

GRANT MAINTAIN ON TABLE public.chat_messages TO authenticated;

GRANT REFERENCES ON TABLE public.chat_messages TO authenticated;

GRANT SELECT ON TABLE public.chat_messages TO authenticated;

GRANT TRIGGER ON TABLE public.chat_messages TO authenticated;

GRANT TRUNCATE ON TABLE public.chat_messages TO authenticated;

GRANT UPDATE ON TABLE public.chat_messages TO authenticated;

GRANT DELETE ON TABLE public.chat_messages TO service_role;

GRANT INSERT ON TABLE public.chat_messages TO service_role;

GRANT MAINTAIN ON TABLE public.chat_messages TO service_role;

GRANT REFERENCES ON TABLE public.chat_messages TO service_role;

GRANT SELECT ON TABLE public.chat_messages TO service_role;

GRANT TRIGGER ON TABLE public.chat_messages TO service_role;

GRANT TRUNCATE ON TABLE public.chat_messages TO service_role;

GRANT UPDATE ON TABLE public.chat_messages TO service_role;

GRANT DELETE ON TABLE public.contract_approvals TO anon;

GRANT INSERT ON TABLE public.contract_approvals TO anon;

GRANT MAINTAIN ON TABLE public.contract_approvals TO anon;

GRANT REFERENCES ON TABLE public.contract_approvals TO anon;

GRANT SELECT ON TABLE public.contract_approvals TO anon;

GRANT TRIGGER ON TABLE public.contract_approvals TO anon;

GRANT TRUNCATE ON TABLE public.contract_approvals TO anon;

GRANT UPDATE ON TABLE public.contract_approvals TO anon;

GRANT DELETE ON TABLE public.contract_approvals TO authenticated;

GRANT INSERT ON TABLE public.contract_approvals TO authenticated;

GRANT MAINTAIN ON TABLE public.contract_approvals TO authenticated;

GRANT REFERENCES ON TABLE public.contract_approvals TO authenticated;

GRANT SELECT ON TABLE public.contract_approvals TO authenticated;

GRANT TRIGGER ON TABLE public.contract_approvals TO authenticated;

GRANT TRUNCATE ON TABLE public.contract_approvals TO authenticated;

GRANT UPDATE ON TABLE public.contract_approvals TO authenticated;

GRANT DELETE ON TABLE public.contract_approvals TO service_role;

GRANT INSERT ON TABLE public.contract_approvals TO service_role;

GRANT MAINTAIN ON TABLE public.contract_approvals TO service_role;

GRANT REFERENCES ON TABLE public.contract_approvals TO service_role;

GRANT SELECT ON TABLE public.contract_approvals TO service_role;

GRANT TRIGGER ON TABLE public.contract_approvals TO service_role;

GRANT TRUNCATE ON TABLE public.contract_approvals TO service_role;

GRANT UPDATE ON TABLE public.contract_approvals TO service_role;

GRANT DELETE ON TABLE public.contracts TO anon;

GRANT INSERT ON TABLE public.contracts TO anon;

GRANT MAINTAIN ON TABLE public.contracts TO anon;

GRANT REFERENCES ON TABLE public.contracts TO anon;

GRANT SELECT ON TABLE public.contracts TO anon;

GRANT TRIGGER ON TABLE public.contracts TO anon;

GRANT TRUNCATE ON TABLE public.contracts TO anon;

GRANT UPDATE ON TABLE public.contracts TO anon;

GRANT DELETE ON TABLE public.contracts TO authenticated;

GRANT INSERT ON TABLE public.contracts TO authenticated;

GRANT MAINTAIN ON TABLE public.contracts TO authenticated;

GRANT REFERENCES ON TABLE public.contracts TO authenticated;

GRANT SELECT ON TABLE public.contracts TO authenticated;

GRANT TRIGGER ON TABLE public.contracts TO authenticated;

GRANT TRUNCATE ON TABLE public.contracts TO authenticated;

GRANT UPDATE ON TABLE public.contracts TO authenticated;

GRANT DELETE ON TABLE public.contracts TO service_role;

GRANT INSERT ON TABLE public.contracts TO service_role;

GRANT MAINTAIN ON TABLE public.contracts TO service_role;

GRANT REFERENCES ON TABLE public.contracts TO service_role;

GRANT SELECT ON TABLE public.contracts TO service_role;

GRANT TRIGGER ON TABLE public.contracts TO service_role;

GRANT TRUNCATE ON TABLE public.contracts TO service_role;

GRANT UPDATE ON TABLE public.contracts TO service_role;

GRANT DELETE ON TABLE public.crm_daily_funnel_snapshot TO anon;

GRANT INSERT ON TABLE public.crm_daily_funnel_snapshot TO anon;

GRANT MAINTAIN ON TABLE public.crm_daily_funnel_snapshot TO anon;

GRANT REFERENCES ON TABLE public.crm_daily_funnel_snapshot TO anon;

GRANT SELECT ON TABLE public.crm_daily_funnel_snapshot TO anon;

GRANT TRIGGER ON TABLE public.crm_daily_funnel_snapshot TO anon;

GRANT TRUNCATE ON TABLE public.crm_daily_funnel_snapshot TO anon;

GRANT UPDATE ON TABLE public.crm_daily_funnel_snapshot TO anon;

GRANT DELETE ON TABLE public.crm_daily_funnel_snapshot TO authenticated;

GRANT INSERT ON TABLE public.crm_daily_funnel_snapshot TO authenticated;

GRANT MAINTAIN ON TABLE public.crm_daily_funnel_snapshot TO authenticated;

GRANT REFERENCES ON TABLE public.crm_daily_funnel_snapshot TO authenticated;

GRANT SELECT ON TABLE public.crm_daily_funnel_snapshot TO authenticated;

GRANT TRIGGER ON TABLE public.crm_daily_funnel_snapshot TO authenticated;

GRANT TRUNCATE ON TABLE public.crm_daily_funnel_snapshot TO authenticated;

GRANT UPDATE ON TABLE public.crm_daily_funnel_snapshot TO authenticated;

GRANT DELETE ON TABLE public.crm_daily_funnel_snapshot TO service_role;

GRANT INSERT ON TABLE public.crm_daily_funnel_snapshot TO service_role;

GRANT MAINTAIN ON TABLE public.crm_daily_funnel_snapshot TO service_role;

GRANT REFERENCES ON TABLE public.crm_daily_funnel_snapshot TO service_role;

GRANT SELECT ON TABLE public.crm_daily_funnel_snapshot TO service_role;

GRANT TRIGGER ON TABLE public.crm_daily_funnel_snapshot TO service_role;

GRANT TRUNCATE ON TABLE public.crm_daily_funnel_snapshot TO service_role;

GRANT UPDATE ON TABLE public.crm_daily_funnel_snapshot TO service_role;

GRANT DELETE ON TABLE public.customer_summary TO anon;

GRANT INSERT ON TABLE public.customer_summary TO anon;

GRANT MAINTAIN ON TABLE public.customer_summary TO anon;

GRANT REFERENCES ON TABLE public.customer_summary TO anon;

GRANT SELECT ON TABLE public.customer_summary TO anon;

GRANT TRIGGER ON TABLE public.customer_summary TO anon;

GRANT TRUNCATE ON TABLE public.customer_summary TO anon;

GRANT UPDATE ON TABLE public.customer_summary TO anon;

GRANT DELETE ON TABLE public.customer_summary TO authenticated;

GRANT INSERT ON TABLE public.customer_summary TO authenticated;

GRANT MAINTAIN ON TABLE public.customer_summary TO authenticated;

GRANT REFERENCES ON TABLE public.customer_summary TO authenticated;

GRANT SELECT ON TABLE public.customer_summary TO authenticated;

GRANT TRIGGER ON TABLE public.customer_summary TO authenticated;

GRANT TRUNCATE ON TABLE public.customer_summary TO authenticated;

GRANT UPDATE ON TABLE public.customer_summary TO authenticated;

GRANT DELETE ON TABLE public.customer_summary TO service_role;

GRANT INSERT ON TABLE public.customer_summary TO service_role;

GRANT MAINTAIN ON TABLE public.customer_summary TO service_role;

GRANT REFERENCES ON TABLE public.customer_summary TO service_role;

GRANT SELECT ON TABLE public.customer_summary TO service_role;

GRANT TRIGGER ON TABLE public.customer_summary TO service_role;

GRANT TRUNCATE ON TABLE public.customer_summary TO service_role;

GRANT UPDATE ON TABLE public.customer_summary TO service_role;

GRANT DELETE ON TABLE public.customers TO anon;

GRANT INSERT ON TABLE public.customers TO anon;

GRANT MAINTAIN ON TABLE public.customers TO anon;

GRANT REFERENCES ON TABLE public.customers TO anon;

GRANT SELECT ON TABLE public.customers TO anon;

GRANT TRIGGER ON TABLE public.customers TO anon;

GRANT TRUNCATE ON TABLE public.customers TO anon;

GRANT UPDATE ON TABLE public.customers TO anon;

GRANT DELETE ON TABLE public.customers TO authenticated;

GRANT INSERT ON TABLE public.customers TO authenticated;

GRANT MAINTAIN ON TABLE public.customers TO authenticated;

GRANT REFERENCES ON TABLE public.customers TO authenticated;

GRANT SELECT ON TABLE public.customers TO authenticated;

GRANT TRIGGER ON TABLE public.customers TO authenticated;

GRANT TRUNCATE ON TABLE public.customers TO authenticated;

GRANT UPDATE ON TABLE public.customers TO authenticated;

GRANT DELETE ON TABLE public.customers TO service_role;

GRANT INSERT ON TABLE public.customers TO service_role;

GRANT MAINTAIN ON TABLE public.customers TO service_role;

GRANT REFERENCES ON TABLE public.customers TO service_role;

GRANT SELECT ON TABLE public.customers TO service_role;

GRANT TRIGGER ON TABLE public.customers TO service_role;

GRANT TRUNCATE ON TABLE public.customers TO service_role;

GRANT UPDATE ON TABLE public.customers TO service_role;

GRANT DELETE ON TABLE public.follow_up_logs TO anon;

GRANT INSERT ON TABLE public.follow_up_logs TO anon;

GRANT MAINTAIN ON TABLE public.follow_up_logs TO anon;

GRANT REFERENCES ON TABLE public.follow_up_logs TO anon;

GRANT SELECT ON TABLE public.follow_up_logs TO anon;

GRANT TRIGGER ON TABLE public.follow_up_logs TO anon;

GRANT TRUNCATE ON TABLE public.follow_up_logs TO anon;

GRANT UPDATE ON TABLE public.follow_up_logs TO anon;

GRANT DELETE ON TABLE public.follow_up_logs TO authenticated;

GRANT INSERT ON TABLE public.follow_up_logs TO authenticated;

GRANT MAINTAIN ON TABLE public.follow_up_logs TO authenticated;

GRANT REFERENCES ON TABLE public.follow_up_logs TO authenticated;

GRANT SELECT ON TABLE public.follow_up_logs TO authenticated;

GRANT TRIGGER ON TABLE public.follow_up_logs TO authenticated;

GRANT TRUNCATE ON TABLE public.follow_up_logs TO authenticated;

GRANT UPDATE ON TABLE public.follow_up_logs TO authenticated;

GRANT DELETE ON TABLE public.follow_up_logs TO service_role;

GRANT INSERT ON TABLE public.follow_up_logs TO service_role;

GRANT MAINTAIN ON TABLE public.follow_up_logs TO service_role;

GRANT REFERENCES ON TABLE public.follow_up_logs TO service_role;

GRANT SELECT ON TABLE public.follow_up_logs TO service_role;

GRANT TRIGGER ON TABLE public.follow_up_logs TO service_role;

GRANT TRUNCATE ON TABLE public.follow_up_logs TO service_role;

GRANT UPDATE ON TABLE public.follow_up_logs TO service_role;

GRANT DELETE ON TABLE public.installment_plans TO anon;

GRANT INSERT ON TABLE public.installment_plans TO anon;

GRANT MAINTAIN ON TABLE public.installment_plans TO anon;

GRANT REFERENCES ON TABLE public.installment_plans TO anon;

GRANT SELECT ON TABLE public.installment_plans TO anon;

GRANT TRIGGER ON TABLE public.installment_plans TO anon;

GRANT TRUNCATE ON TABLE public.installment_plans TO anon;

GRANT UPDATE ON TABLE public.installment_plans TO anon;

GRANT DELETE ON TABLE public.installment_plans TO authenticated;

GRANT INSERT ON TABLE public.installment_plans TO authenticated;

GRANT MAINTAIN ON TABLE public.installment_plans TO authenticated;

GRANT REFERENCES ON TABLE public.installment_plans TO authenticated;

GRANT SELECT ON TABLE public.installment_plans TO authenticated;

GRANT TRIGGER ON TABLE public.installment_plans TO authenticated;

GRANT TRUNCATE ON TABLE public.installment_plans TO authenticated;

GRANT UPDATE ON TABLE public.installment_plans TO authenticated;

GRANT DELETE ON TABLE public.installment_plans TO service_role;

GRANT INSERT ON TABLE public.installment_plans TO service_role;

GRANT MAINTAIN ON TABLE public.installment_plans TO service_role;

GRANT REFERENCES ON TABLE public.installment_plans TO service_role;

GRANT SELECT ON TABLE public.installment_plans TO service_role;

GRANT TRIGGER ON TABLE public.installment_plans TO service_role;

GRANT TRUNCATE ON TABLE public.installment_plans TO service_role;

GRANT UPDATE ON TABLE public.installment_plans TO service_role;

GRANT DELETE ON TABLE public.knx_designs TO anon;

GRANT INSERT ON TABLE public.knx_designs TO anon;

GRANT MAINTAIN ON TABLE public.knx_designs TO anon;

GRANT REFERENCES ON TABLE public.knx_designs TO anon;

GRANT SELECT ON TABLE public.knx_designs TO anon;

GRANT TRIGGER ON TABLE public.knx_designs TO anon;

GRANT TRUNCATE ON TABLE public.knx_designs TO anon;

GRANT UPDATE ON TABLE public.knx_designs TO anon;

GRANT DELETE ON TABLE public.knx_designs TO authenticated;

GRANT INSERT ON TABLE public.knx_designs TO authenticated;

GRANT MAINTAIN ON TABLE public.knx_designs TO authenticated;

GRANT REFERENCES ON TABLE public.knx_designs TO authenticated;

GRANT SELECT ON TABLE public.knx_designs TO authenticated;

GRANT TRIGGER ON TABLE public.knx_designs TO authenticated;

GRANT TRUNCATE ON TABLE public.knx_designs TO authenticated;

GRANT UPDATE ON TABLE public.knx_designs TO authenticated;

GRANT DELETE ON TABLE public.knx_designs TO service_role;

GRANT INSERT ON TABLE public.knx_designs TO service_role;

GRANT MAINTAIN ON TABLE public.knx_designs TO service_role;

GRANT REFERENCES ON TABLE public.knx_designs TO service_role;

GRANT SELECT ON TABLE public.knx_designs TO service_role;

GRANT TRIGGER ON TABLE public.knx_designs TO service_role;

GRANT TRUNCATE ON TABLE public.knx_designs TO service_role;

GRANT UPDATE ON TABLE public.knx_designs TO service_role;

GRANT DELETE ON TABLE public.kpi_targets TO anon;

GRANT INSERT ON TABLE public.kpi_targets TO anon;

GRANT MAINTAIN ON TABLE public.kpi_targets TO anon;

GRANT REFERENCES ON TABLE public.kpi_targets TO anon;

GRANT SELECT ON TABLE public.kpi_targets TO anon;

GRANT TRIGGER ON TABLE public.kpi_targets TO anon;

GRANT TRUNCATE ON TABLE public.kpi_targets TO anon;

GRANT UPDATE ON TABLE public.kpi_targets TO anon;

GRANT DELETE ON TABLE public.kpi_targets TO authenticated;

GRANT INSERT ON TABLE public.kpi_targets TO authenticated;

GRANT MAINTAIN ON TABLE public.kpi_targets TO authenticated;

GRANT REFERENCES ON TABLE public.kpi_targets TO authenticated;

GRANT SELECT ON TABLE public.kpi_targets TO authenticated;

GRANT TRIGGER ON TABLE public.kpi_targets TO authenticated;

GRANT TRUNCATE ON TABLE public.kpi_targets TO authenticated;

GRANT UPDATE ON TABLE public.kpi_targets TO authenticated;

GRANT DELETE ON TABLE public.kpi_targets TO service_role;

GRANT INSERT ON TABLE public.kpi_targets TO service_role;

GRANT MAINTAIN ON TABLE public.kpi_targets TO service_role;

GRANT REFERENCES ON TABLE public.kpi_targets TO service_role;

GRANT SELECT ON TABLE public.kpi_targets TO service_role;

GRANT TRIGGER ON TABLE public.kpi_targets TO service_role;

GRANT TRUNCATE ON TABLE public.kpi_targets TO service_role;

GRANT UPDATE ON TABLE public.kpi_targets TO service_role;

GRANT DELETE ON TABLE public.lead_alerts TO authenticated;

GRANT INSERT ON TABLE public.lead_alerts TO authenticated;

GRANT MAINTAIN ON TABLE public.lead_alerts TO authenticated;

GRANT REFERENCES ON TABLE public.lead_alerts TO authenticated;

GRANT SELECT ON TABLE public.lead_alerts TO authenticated;

GRANT TRIGGER ON TABLE public.lead_alerts TO authenticated;

GRANT TRUNCATE ON TABLE public.lead_alerts TO authenticated;

GRANT UPDATE ON TABLE public.lead_alerts TO authenticated;

GRANT DELETE ON TABLE public.lead_alerts TO service_role;

GRANT INSERT ON TABLE public.lead_alerts TO service_role;

GRANT MAINTAIN ON TABLE public.lead_alerts TO service_role;

GRANT REFERENCES ON TABLE public.lead_alerts TO service_role;

GRANT SELECT ON TABLE public.lead_alerts TO service_role;

GRANT TRIGGER ON TABLE public.lead_alerts TO service_role;

GRANT TRUNCATE ON TABLE public.lead_alerts TO service_role;

GRANT UPDATE ON TABLE public.lead_alerts TO service_role;

GRANT DELETE ON TABLE public.lead_deletion_requests TO service_role;

GRANT INSERT ON TABLE public.lead_deletion_requests TO service_role;

GRANT MAINTAIN ON TABLE public.lead_deletion_requests TO service_role;

GRANT REFERENCES ON TABLE public.lead_deletion_requests TO service_role;

GRANT SELECT ON TABLE public.lead_deletion_requests TO service_role;

GRANT TRIGGER ON TABLE public.lead_deletion_requests TO service_role;

GRANT TRUNCATE ON TABLE public.lead_deletion_requests TO service_role;

GRANT UPDATE ON TABLE public.lead_deletion_requests TO service_role;

GRANT DELETE ON TABLE public.lead_documents TO anon;

GRANT INSERT ON TABLE public.lead_documents TO anon;

GRANT MAINTAIN ON TABLE public.lead_documents TO anon;

GRANT REFERENCES ON TABLE public.lead_documents TO anon;

GRANT SELECT ON TABLE public.lead_documents TO anon;

GRANT TRIGGER ON TABLE public.lead_documents TO anon;

GRANT TRUNCATE ON TABLE public.lead_documents TO anon;

GRANT UPDATE ON TABLE public.lead_documents TO anon;

GRANT DELETE ON TABLE public.lead_documents TO authenticated;

GRANT INSERT ON TABLE public.lead_documents TO authenticated;

GRANT MAINTAIN ON TABLE public.lead_documents TO authenticated;

GRANT REFERENCES ON TABLE public.lead_documents TO authenticated;

GRANT SELECT ON TABLE public.lead_documents TO authenticated;

GRANT TRIGGER ON TABLE public.lead_documents TO authenticated;

GRANT TRUNCATE ON TABLE public.lead_documents TO authenticated;

GRANT UPDATE ON TABLE public.lead_documents TO authenticated;

GRANT DELETE ON TABLE public.lead_documents TO service_role;

GRANT INSERT ON TABLE public.lead_documents TO service_role;

GRANT MAINTAIN ON TABLE public.lead_documents TO service_role;

GRANT REFERENCES ON TABLE public.lead_documents TO service_role;

GRANT SELECT ON TABLE public.lead_documents TO service_role;

GRANT TRIGGER ON TABLE public.lead_documents TO service_role;

GRANT TRUNCATE ON TABLE public.lead_documents TO service_role;

GRANT UPDATE ON TABLE public.lead_documents TO service_role;

GRANT DELETE ON TABLE public.lead_files TO anon;

GRANT INSERT ON TABLE public.lead_files TO anon;

GRANT MAINTAIN ON TABLE public.lead_files TO anon;

GRANT REFERENCES ON TABLE public.lead_files TO anon;

GRANT SELECT ON TABLE public.lead_files TO anon;

GRANT TRIGGER ON TABLE public.lead_files TO anon;

GRANT TRUNCATE ON TABLE public.lead_files TO anon;

GRANT UPDATE ON TABLE public.lead_files TO anon;

GRANT DELETE ON TABLE public.lead_files TO authenticated;

GRANT INSERT ON TABLE public.lead_files TO authenticated;

GRANT MAINTAIN ON TABLE public.lead_files TO authenticated;

GRANT REFERENCES ON TABLE public.lead_files TO authenticated;

GRANT SELECT ON TABLE public.lead_files TO authenticated;

GRANT TRIGGER ON TABLE public.lead_files TO authenticated;

GRANT TRUNCATE ON TABLE public.lead_files TO authenticated;

GRANT UPDATE ON TABLE public.lead_files TO authenticated;

GRANT DELETE ON TABLE public.lead_files TO service_role;

GRANT INSERT ON TABLE public.lead_files TO service_role;

GRANT MAINTAIN ON TABLE public.lead_files TO service_role;

GRANT REFERENCES ON TABLE public.lead_files TO service_role;

GRANT SELECT ON TABLE public.lead_files TO service_role;

GRANT TRIGGER ON TABLE public.lead_files TO service_role;

GRANT TRUNCATE ON TABLE public.lead_files TO service_role;

GRANT UPDATE ON TABLE public.lead_files TO service_role;

GRANT DELETE ON TABLE public.lead_funnel_daily TO anon;

GRANT INSERT ON TABLE public.lead_funnel_daily TO anon;

GRANT MAINTAIN ON TABLE public.lead_funnel_daily TO anon;

GRANT REFERENCES ON TABLE public.lead_funnel_daily TO anon;

GRANT SELECT ON TABLE public.lead_funnel_daily TO anon;

GRANT TRIGGER ON TABLE public.lead_funnel_daily TO anon;

GRANT TRUNCATE ON TABLE public.lead_funnel_daily TO anon;

GRANT UPDATE ON TABLE public.lead_funnel_daily TO anon;

GRANT DELETE ON TABLE public.lead_funnel_daily TO authenticated;

GRANT INSERT ON TABLE public.lead_funnel_daily TO authenticated;

GRANT MAINTAIN ON TABLE public.lead_funnel_daily TO authenticated;

GRANT REFERENCES ON TABLE public.lead_funnel_daily TO authenticated;

GRANT SELECT ON TABLE public.lead_funnel_daily TO authenticated;

GRANT TRIGGER ON TABLE public.lead_funnel_daily TO authenticated;

GRANT TRUNCATE ON TABLE public.lead_funnel_daily TO authenticated;

GRANT UPDATE ON TABLE public.lead_funnel_daily TO authenticated;

GRANT DELETE ON TABLE public.lead_funnel_daily TO service_role;

GRANT INSERT ON TABLE public.lead_funnel_daily TO service_role;

GRANT MAINTAIN ON TABLE public.lead_funnel_daily TO service_role;

GRANT REFERENCES ON TABLE public.lead_funnel_daily TO service_role;

GRANT SELECT ON TABLE public.lead_funnel_daily TO service_role;

GRANT TRIGGER ON TABLE public.lead_funnel_daily TO service_role;

GRANT TRUNCATE ON TABLE public.lead_funnel_daily TO service_role;

GRANT UPDATE ON TABLE public.lead_funnel_daily TO service_role;

GRANT DELETE ON TABLE public.lead_milestones TO anon;

GRANT INSERT ON TABLE public.lead_milestones TO anon;

GRANT MAINTAIN ON TABLE public.lead_milestones TO anon;

GRANT REFERENCES ON TABLE public.lead_milestones TO anon;

GRANT SELECT ON TABLE public.lead_milestones TO anon;

GRANT TRIGGER ON TABLE public.lead_milestones TO anon;

GRANT TRUNCATE ON TABLE public.lead_milestones TO anon;

GRANT UPDATE ON TABLE public.lead_milestones TO anon;

GRANT DELETE ON TABLE public.lead_milestones TO authenticated;

GRANT INSERT ON TABLE public.lead_milestones TO authenticated;

GRANT MAINTAIN ON TABLE public.lead_milestones TO authenticated;

GRANT REFERENCES ON TABLE public.lead_milestones TO authenticated;

GRANT SELECT ON TABLE public.lead_milestones TO authenticated;

GRANT TRIGGER ON TABLE public.lead_milestones TO authenticated;

GRANT TRUNCATE ON TABLE public.lead_milestones TO authenticated;

GRANT UPDATE ON TABLE public.lead_milestones TO authenticated;

GRANT DELETE ON TABLE public.lead_milestones TO service_role;

GRANT INSERT ON TABLE public.lead_milestones TO service_role;

GRANT MAINTAIN ON TABLE public.lead_milestones TO service_role;

GRANT REFERENCES ON TABLE public.lead_milestones TO service_role;

GRANT SELECT ON TABLE public.lead_milestones TO service_role;

GRANT TRIGGER ON TABLE public.lead_milestones TO service_role;

GRANT TRUNCATE ON TABLE public.lead_milestones TO service_role;

GRANT UPDATE ON TABLE public.lead_milestones TO service_role;

GRANT DELETE ON TABLE public.lead_mutation_requests TO service_role;

GRANT INSERT ON TABLE public.lead_mutation_requests TO service_role;

GRANT MAINTAIN ON TABLE public.lead_mutation_requests TO service_role;

GRANT REFERENCES ON TABLE public.lead_mutation_requests TO service_role;

GRANT SELECT ON TABLE public.lead_mutation_requests TO service_role;

GRANT TRIGGER ON TABLE public.lead_mutation_requests TO service_role;

GRANT TRUNCATE ON TABLE public.lead_mutation_requests TO service_role;

GRANT UPDATE ON TABLE public.lead_mutation_requests TO service_role;

GRANT DELETE ON TABLE public.lead_workflow_stages TO anon;

GRANT INSERT ON TABLE public.lead_workflow_stages TO anon;

GRANT MAINTAIN ON TABLE public.lead_workflow_stages TO anon;

GRANT REFERENCES ON TABLE public.lead_workflow_stages TO anon;

GRANT SELECT ON TABLE public.lead_workflow_stages TO anon;

GRANT TRIGGER ON TABLE public.lead_workflow_stages TO anon;

GRANT TRUNCATE ON TABLE public.lead_workflow_stages TO anon;

GRANT UPDATE ON TABLE public.lead_workflow_stages TO anon;

GRANT DELETE ON TABLE public.lead_workflow_stages TO authenticated;

GRANT INSERT ON TABLE public.lead_workflow_stages TO authenticated;

GRANT MAINTAIN ON TABLE public.lead_workflow_stages TO authenticated;

GRANT REFERENCES ON TABLE public.lead_workflow_stages TO authenticated;

GRANT SELECT ON TABLE public.lead_workflow_stages TO authenticated;

GRANT TRIGGER ON TABLE public.lead_workflow_stages TO authenticated;

GRANT TRUNCATE ON TABLE public.lead_workflow_stages TO authenticated;

GRANT UPDATE ON TABLE public.lead_workflow_stages TO authenticated;

GRANT DELETE ON TABLE public.lead_workflow_stages TO service_role;

GRANT INSERT ON TABLE public.lead_workflow_stages TO service_role;

GRANT MAINTAIN ON TABLE public.lead_workflow_stages TO service_role;

GRANT REFERENCES ON TABLE public.lead_workflow_stages TO service_role;

GRANT SELECT ON TABLE public.lead_workflow_stages TO service_role;

GRANT TRIGGER ON TABLE public.lead_workflow_stages TO service_role;

GRANT TRUNCATE ON TABLE public.lead_workflow_stages TO service_role;

GRANT UPDATE ON TABLE public.lead_workflow_stages TO service_role;

GRANT DELETE ON TABLE public.leads TO anon;

GRANT INSERT ON TABLE public.leads TO anon;

GRANT MAINTAIN ON TABLE public.leads TO anon;

GRANT REFERENCES ON TABLE public.leads TO anon;

GRANT SELECT ON TABLE public.leads TO anon;

GRANT TRIGGER ON TABLE public.leads TO anon;

GRANT TRUNCATE ON TABLE public.leads TO anon;

GRANT UPDATE ON TABLE public.leads TO anon;

GRANT DELETE ON TABLE public.leads TO authenticated;

GRANT INSERT ON TABLE public.leads TO authenticated;

GRANT MAINTAIN ON TABLE public.leads TO authenticated;

GRANT REFERENCES ON TABLE public.leads TO authenticated;

GRANT SELECT ON TABLE public.leads TO authenticated;

GRANT TRIGGER ON TABLE public.leads TO authenticated;

GRANT TRUNCATE ON TABLE public.leads TO authenticated;

GRANT UPDATE ON TABLE public.leads TO authenticated;

GRANT DELETE ON TABLE public.leads TO service_role;

GRANT INSERT ON TABLE public.leads TO service_role;

GRANT MAINTAIN ON TABLE public.leads TO service_role;

GRANT REFERENCES ON TABLE public.leads TO service_role;

GRANT SELECT ON TABLE public.leads TO service_role;

GRANT TRIGGER ON TABLE public.leads TO service_role;

GRANT TRUNCATE ON TABLE public.leads TO service_role;

GRANT UPDATE ON TABLE public.leads TO service_role;

GRANT DELETE ON TABLE public.marketing_campaigns TO anon;

GRANT INSERT ON TABLE public.marketing_campaigns TO anon;

GRANT MAINTAIN ON TABLE public.marketing_campaigns TO anon;

GRANT REFERENCES ON TABLE public.marketing_campaigns TO anon;

GRANT SELECT ON TABLE public.marketing_campaigns TO anon;

GRANT TRIGGER ON TABLE public.marketing_campaigns TO anon;

GRANT TRUNCATE ON TABLE public.marketing_campaigns TO anon;

GRANT UPDATE ON TABLE public.marketing_campaigns TO anon;

GRANT DELETE ON TABLE public.marketing_campaigns TO authenticated;

GRANT INSERT ON TABLE public.marketing_campaigns TO authenticated;

GRANT MAINTAIN ON TABLE public.marketing_campaigns TO authenticated;

GRANT REFERENCES ON TABLE public.marketing_campaigns TO authenticated;

GRANT SELECT ON TABLE public.marketing_campaigns TO authenticated;

GRANT TRIGGER ON TABLE public.marketing_campaigns TO authenticated;

GRANT TRUNCATE ON TABLE public.marketing_campaigns TO authenticated;

GRANT UPDATE ON TABLE public.marketing_campaigns TO authenticated;

GRANT DELETE ON TABLE public.marketing_campaigns TO service_role;

GRANT INSERT ON TABLE public.marketing_campaigns TO service_role;

GRANT MAINTAIN ON TABLE public.marketing_campaigns TO service_role;

GRANT REFERENCES ON TABLE public.marketing_campaigns TO service_role;

GRANT SELECT ON TABLE public.marketing_campaigns TO service_role;

GRANT TRIGGER ON TABLE public.marketing_campaigns TO service_role;

GRANT TRUNCATE ON TABLE public.marketing_campaigns TO service_role;

GRANT UPDATE ON TABLE public.marketing_campaigns TO service_role;

GRANT DELETE ON TABLE public.meta_tokens TO anon;

GRANT INSERT ON TABLE public.meta_tokens TO anon;

GRANT MAINTAIN ON TABLE public.meta_tokens TO anon;

GRANT REFERENCES ON TABLE public.meta_tokens TO anon;

GRANT SELECT ON TABLE public.meta_tokens TO anon;

GRANT TRIGGER ON TABLE public.meta_tokens TO anon;

GRANT TRUNCATE ON TABLE public.meta_tokens TO anon;

GRANT UPDATE ON TABLE public.meta_tokens TO anon;

GRANT DELETE ON TABLE public.meta_tokens TO authenticated;

GRANT INSERT ON TABLE public.meta_tokens TO authenticated;

GRANT MAINTAIN ON TABLE public.meta_tokens TO authenticated;

GRANT REFERENCES ON TABLE public.meta_tokens TO authenticated;

GRANT SELECT ON TABLE public.meta_tokens TO authenticated;

GRANT TRIGGER ON TABLE public.meta_tokens TO authenticated;

GRANT TRUNCATE ON TABLE public.meta_tokens TO authenticated;

GRANT UPDATE ON TABLE public.meta_tokens TO authenticated;

GRANT DELETE ON TABLE public.meta_tokens TO service_role;

GRANT INSERT ON TABLE public.meta_tokens TO service_role;

GRANT MAINTAIN ON TABLE public.meta_tokens TO service_role;

GRANT REFERENCES ON TABLE public.meta_tokens TO service_role;

GRANT SELECT ON TABLE public.meta_tokens TO service_role;

GRANT TRIGGER ON TABLE public.meta_tokens TO service_role;

GRANT TRUNCATE ON TABLE public.meta_tokens TO service_role;

GRANT UPDATE ON TABLE public.meta_tokens TO service_role;

GRANT DELETE ON TABLE public.notifications TO anon;

GRANT INSERT ON TABLE public.notifications TO anon;

GRANT MAINTAIN ON TABLE public.notifications TO anon;

GRANT REFERENCES ON TABLE public.notifications TO anon;

GRANT SELECT ON TABLE public.notifications TO anon;

GRANT TRIGGER ON TABLE public.notifications TO anon;

GRANT TRUNCATE ON TABLE public.notifications TO anon;

GRANT UPDATE ON TABLE public.notifications TO anon;

GRANT DELETE ON TABLE public.notifications TO authenticated;

GRANT INSERT ON TABLE public.notifications TO authenticated;

GRANT MAINTAIN ON TABLE public.notifications TO authenticated;

GRANT REFERENCES ON TABLE public.notifications TO authenticated;

GRANT SELECT ON TABLE public.notifications TO authenticated;

GRANT TRIGGER ON TABLE public.notifications TO authenticated;

GRANT TRUNCATE ON TABLE public.notifications TO authenticated;

GRANT UPDATE ON TABLE public.notifications TO authenticated;

GRANT DELETE ON TABLE public.notifications TO service_role;

GRANT INSERT ON TABLE public.notifications TO service_role;

GRANT MAINTAIN ON TABLE public.notifications TO service_role;

GRANT REFERENCES ON TABLE public.notifications TO service_role;

GRANT SELECT ON TABLE public.notifications TO service_role;

GRANT TRIGGER ON TABLE public.notifications TO service_role;

GRANT TRUNCATE ON TABLE public.notifications TO service_role;

GRANT UPDATE ON TABLE public.notifications TO service_role;

GRANT DELETE ON TABLE public.payment_allocations TO anon;

GRANT INSERT ON TABLE public.payment_allocations TO anon;

GRANT MAINTAIN ON TABLE public.payment_allocations TO anon;

GRANT REFERENCES ON TABLE public.payment_allocations TO anon;

GRANT SELECT ON TABLE public.payment_allocations TO anon;

GRANT TRIGGER ON TABLE public.payment_allocations TO anon;

GRANT TRUNCATE ON TABLE public.payment_allocations TO anon;

GRANT UPDATE ON TABLE public.payment_allocations TO anon;

GRANT DELETE ON TABLE public.payment_allocations TO authenticated;

GRANT INSERT ON TABLE public.payment_allocations TO authenticated;

GRANT MAINTAIN ON TABLE public.payment_allocations TO authenticated;

GRANT REFERENCES ON TABLE public.payment_allocations TO authenticated;

GRANT SELECT ON TABLE public.payment_allocations TO authenticated;

GRANT TRIGGER ON TABLE public.payment_allocations TO authenticated;

GRANT TRUNCATE ON TABLE public.payment_allocations TO authenticated;

GRANT UPDATE ON TABLE public.payment_allocations TO authenticated;

GRANT DELETE ON TABLE public.payment_allocations TO service_role;

GRANT INSERT ON TABLE public.payment_allocations TO service_role;

GRANT MAINTAIN ON TABLE public.payment_allocations TO service_role;

GRANT REFERENCES ON TABLE public.payment_allocations TO service_role;

GRANT SELECT ON TABLE public.payment_allocations TO service_role;

GRANT TRIGGER ON TABLE public.payment_allocations TO service_role;

GRANT TRUNCATE ON TABLE public.payment_allocations TO service_role;

GRANT UPDATE ON TABLE public.payment_allocations TO service_role;

GRANT DELETE ON TABLE public.payments TO anon;

GRANT INSERT ON TABLE public.payments TO anon;

GRANT MAINTAIN ON TABLE public.payments TO anon;

GRANT REFERENCES ON TABLE public.payments TO anon;

GRANT SELECT ON TABLE public.payments TO anon;

GRANT TRIGGER ON TABLE public.payments TO anon;

GRANT TRUNCATE ON TABLE public.payments TO anon;

GRANT UPDATE ON TABLE public.payments TO anon;

GRANT DELETE ON TABLE public.payments TO authenticated;

GRANT INSERT ON TABLE public.payments TO authenticated;

GRANT MAINTAIN ON TABLE public.payments TO authenticated;

GRANT REFERENCES ON TABLE public.payments TO authenticated;

GRANT SELECT ON TABLE public.payments TO authenticated;

GRANT TRIGGER ON TABLE public.payments TO authenticated;

GRANT TRUNCATE ON TABLE public.payments TO authenticated;

GRANT UPDATE ON TABLE public.payments TO authenticated;

GRANT DELETE ON TABLE public.payments TO service_role;

GRANT INSERT ON TABLE public.payments TO service_role;

GRANT MAINTAIN ON TABLE public.payments TO service_role;

GRANT REFERENCES ON TABLE public.payments TO service_role;

GRANT SELECT ON TABLE public.payments TO service_role;

GRANT TRIGGER ON TABLE public.payments TO service_role;

GRANT TRUNCATE ON TABLE public.payments TO service_role;

GRANT UPDATE ON TABLE public.payments TO service_role;

GRANT DELETE ON TABLE public.pipeline_stages TO anon;

GRANT INSERT ON TABLE public.pipeline_stages TO anon;

GRANT MAINTAIN ON TABLE public.pipeline_stages TO anon;

GRANT REFERENCES ON TABLE public.pipeline_stages TO anon;

GRANT SELECT ON TABLE public.pipeline_stages TO anon;

GRANT TRIGGER ON TABLE public.pipeline_stages TO anon;

GRANT TRUNCATE ON TABLE public.pipeline_stages TO anon;

GRANT UPDATE ON TABLE public.pipeline_stages TO anon;

GRANT DELETE ON TABLE public.pipeline_stages TO authenticated;

GRANT INSERT ON TABLE public.pipeline_stages TO authenticated;

GRANT MAINTAIN ON TABLE public.pipeline_stages TO authenticated;

GRANT REFERENCES ON TABLE public.pipeline_stages TO authenticated;

GRANT SELECT ON TABLE public.pipeline_stages TO authenticated;

GRANT TRIGGER ON TABLE public.pipeline_stages TO authenticated;

GRANT TRUNCATE ON TABLE public.pipeline_stages TO authenticated;

GRANT UPDATE ON TABLE public.pipeline_stages TO authenticated;

GRANT DELETE ON TABLE public.pipeline_stages TO service_role;

GRANT INSERT ON TABLE public.pipeline_stages TO service_role;

GRANT MAINTAIN ON TABLE public.pipeline_stages TO service_role;

GRANT REFERENCES ON TABLE public.pipeline_stages TO service_role;

GRANT SELECT ON TABLE public.pipeline_stages TO service_role;

GRANT TRIGGER ON TABLE public.pipeline_stages TO service_role;

GRANT TRUNCATE ON TABLE public.pipeline_stages TO service_role;

GRANT UPDATE ON TABLE public.pipeline_stages TO service_role;

GRANT DELETE ON TABLE public.pipeline_summary TO anon;

GRANT INSERT ON TABLE public.pipeline_summary TO anon;

GRANT MAINTAIN ON TABLE public.pipeline_summary TO anon;

GRANT REFERENCES ON TABLE public.pipeline_summary TO anon;

GRANT SELECT ON TABLE public.pipeline_summary TO anon;

GRANT TRIGGER ON TABLE public.pipeline_summary TO anon;

GRANT TRUNCATE ON TABLE public.pipeline_summary TO anon;

GRANT UPDATE ON TABLE public.pipeline_summary TO anon;

GRANT DELETE ON TABLE public.pipeline_summary TO authenticated;

GRANT INSERT ON TABLE public.pipeline_summary TO authenticated;

GRANT MAINTAIN ON TABLE public.pipeline_summary TO authenticated;

GRANT REFERENCES ON TABLE public.pipeline_summary TO authenticated;

GRANT SELECT ON TABLE public.pipeline_summary TO authenticated;

GRANT TRIGGER ON TABLE public.pipeline_summary TO authenticated;

GRANT TRUNCATE ON TABLE public.pipeline_summary TO authenticated;

GRANT UPDATE ON TABLE public.pipeline_summary TO authenticated;

GRANT DELETE ON TABLE public.pipeline_summary TO service_role;

GRANT INSERT ON TABLE public.pipeline_summary TO service_role;

GRANT MAINTAIN ON TABLE public.pipeline_summary TO service_role;

GRANT REFERENCES ON TABLE public.pipeline_summary TO service_role;

GRANT SELECT ON TABLE public.pipeline_summary TO service_role;

GRANT TRIGGER ON TABLE public.pipeline_summary TO service_role;

GRANT TRUNCATE ON TABLE public.pipeline_summary TO service_role;

GRANT UPDATE ON TABLE public.pipeline_summary TO service_role;

GRANT DELETE ON TABLE public.products TO anon;

GRANT INSERT ON TABLE public.products TO anon;

GRANT MAINTAIN ON TABLE public.products TO anon;

GRANT REFERENCES ON TABLE public.products TO anon;

GRANT SELECT ON TABLE public.products TO anon;

GRANT TRIGGER ON TABLE public.products TO anon;

GRANT TRUNCATE ON TABLE public.products TO anon;

GRANT UPDATE ON TABLE public.products TO anon;

GRANT DELETE ON TABLE public.products TO authenticated;

GRANT INSERT ON TABLE public.products TO authenticated;

GRANT MAINTAIN ON TABLE public.products TO authenticated;

GRANT REFERENCES ON TABLE public.products TO authenticated;

GRANT SELECT ON TABLE public.products TO authenticated;

GRANT TRIGGER ON TABLE public.products TO authenticated;

GRANT TRUNCATE ON TABLE public.products TO authenticated;

GRANT UPDATE ON TABLE public.products TO authenticated;

GRANT DELETE ON TABLE public.products TO service_role;

GRANT INSERT ON TABLE public.products TO service_role;

GRANT MAINTAIN ON TABLE public.products TO service_role;

GRANT REFERENCES ON TABLE public.products TO service_role;

GRANT SELECT ON TABLE public.products TO service_role;

GRANT TRIGGER ON TABLE public.products TO service_role;

GRANT TRUNCATE ON TABLE public.products TO service_role;

GRANT UPDATE ON TABLE public.products TO service_role;

GRANT DELETE ON TABLE public.profiles TO anon;

GRANT INSERT ON TABLE public.profiles TO anon;

GRANT MAINTAIN ON TABLE public.profiles TO anon;

GRANT REFERENCES ON TABLE public.profiles TO anon;

GRANT SELECT ON TABLE public.profiles TO anon;

GRANT TRIGGER ON TABLE public.profiles TO anon;

GRANT TRUNCATE ON TABLE public.profiles TO anon;

GRANT UPDATE ON TABLE public.profiles TO anon;

GRANT DELETE ON TABLE public.profiles TO authenticated;

GRANT INSERT ON TABLE public.profiles TO authenticated;

GRANT MAINTAIN ON TABLE public.profiles TO authenticated;

GRANT REFERENCES ON TABLE public.profiles TO authenticated;

GRANT SELECT ON TABLE public.profiles TO authenticated;

GRANT TRIGGER ON TABLE public.profiles TO authenticated;

GRANT TRUNCATE ON TABLE public.profiles TO authenticated;

GRANT UPDATE ON TABLE public.profiles TO authenticated;

GRANT DELETE ON TABLE public.profiles TO service_role;

GRANT INSERT ON TABLE public.profiles TO service_role;

GRANT MAINTAIN ON TABLE public.profiles TO service_role;

GRANT REFERENCES ON TABLE public.profiles TO service_role;

GRANT SELECT ON TABLE public.profiles TO service_role;

GRANT TRIGGER ON TABLE public.profiles TO service_role;

GRANT TRUNCATE ON TABLE public.profiles TO service_role;

GRANT UPDATE ON TABLE public.profiles TO service_role;

GRANT DELETE ON TABLE public.projects TO anon;

GRANT INSERT ON TABLE public.projects TO anon;

GRANT MAINTAIN ON TABLE public.projects TO anon;

GRANT REFERENCES ON TABLE public.projects TO anon;

GRANT SELECT ON TABLE public.projects TO anon;

GRANT TRIGGER ON TABLE public.projects TO anon;

GRANT TRUNCATE ON TABLE public.projects TO anon;

GRANT UPDATE ON TABLE public.projects TO anon;

GRANT DELETE ON TABLE public.projects TO authenticated;

GRANT INSERT ON TABLE public.projects TO authenticated;

GRANT MAINTAIN ON TABLE public.projects TO authenticated;

GRANT REFERENCES ON TABLE public.projects TO authenticated;

GRANT SELECT ON TABLE public.projects TO authenticated;

GRANT TRIGGER ON TABLE public.projects TO authenticated;

GRANT TRUNCATE ON TABLE public.projects TO authenticated;

GRANT UPDATE ON TABLE public.projects TO authenticated;

GRANT DELETE ON TABLE public.projects TO service_role;

GRANT INSERT ON TABLE public.projects TO service_role;

GRANT MAINTAIN ON TABLE public.projects TO service_role;

GRANT REFERENCES ON TABLE public.projects TO service_role;

GRANT SELECT ON TABLE public.projects TO service_role;

GRANT TRIGGER ON TABLE public.projects TO service_role;

GRANT TRUNCATE ON TABLE public.projects TO service_role;

GRANT UPDATE ON TABLE public.projects TO service_role;

GRANT DELETE ON TABLE public.quotations TO anon;

GRANT INSERT ON TABLE public.quotations TO anon;

GRANT MAINTAIN ON TABLE public.quotations TO anon;

GRANT REFERENCES ON TABLE public.quotations TO anon;

GRANT SELECT ON TABLE public.quotations TO anon;

GRANT TRIGGER ON TABLE public.quotations TO anon;

GRANT TRUNCATE ON TABLE public.quotations TO anon;

GRANT UPDATE ON TABLE public.quotations TO anon;

GRANT DELETE ON TABLE public.quotations TO authenticated;

GRANT INSERT ON TABLE public.quotations TO authenticated;

GRANT MAINTAIN ON TABLE public.quotations TO authenticated;

GRANT REFERENCES ON TABLE public.quotations TO authenticated;

GRANT SELECT ON TABLE public.quotations TO authenticated;

GRANT TRIGGER ON TABLE public.quotations TO authenticated;

GRANT TRUNCATE ON TABLE public.quotations TO authenticated;

GRANT UPDATE ON TABLE public.quotations TO authenticated;

GRANT DELETE ON TABLE public.quotations TO service_role;

GRANT INSERT ON TABLE public.quotations TO service_role;

GRANT MAINTAIN ON TABLE public.quotations TO service_role;

GRANT REFERENCES ON TABLE public.quotations TO service_role;

GRANT SELECT ON TABLE public.quotations TO service_role;

GRANT TRIGGER ON TABLE public.quotations TO service_role;

GRANT TRUNCATE ON TABLE public.quotations TO service_role;

GRANT UPDATE ON TABLE public.quotations TO service_role;

GRANT DELETE ON TABLE public.quotes TO anon;

GRANT INSERT ON TABLE public.quotes TO anon;

GRANT MAINTAIN ON TABLE public.quotes TO anon;

GRANT REFERENCES ON TABLE public.quotes TO anon;

GRANT SELECT ON TABLE public.quotes TO anon;

GRANT TRIGGER ON TABLE public.quotes TO anon;

GRANT TRUNCATE ON TABLE public.quotes TO anon;

GRANT UPDATE ON TABLE public.quotes TO anon;

GRANT DELETE ON TABLE public.quotes TO authenticated;

GRANT INSERT ON TABLE public.quotes TO authenticated;

GRANT MAINTAIN ON TABLE public.quotes TO authenticated;

GRANT REFERENCES ON TABLE public.quotes TO authenticated;

GRANT SELECT ON TABLE public.quotes TO authenticated;

GRANT TRIGGER ON TABLE public.quotes TO authenticated;

GRANT TRUNCATE ON TABLE public.quotes TO authenticated;

GRANT UPDATE ON TABLE public.quotes TO authenticated;

GRANT DELETE ON TABLE public.quotes TO service_role;

GRANT INSERT ON TABLE public.quotes TO service_role;

GRANT MAINTAIN ON TABLE public.quotes TO service_role;

GRANT REFERENCES ON TABLE public.quotes TO service_role;

GRANT SELECT ON TABLE public.quotes TO service_role;

GRANT TRIGGER ON TABLE public.quotes TO service_role;

GRANT TRUNCATE ON TABLE public.quotes TO service_role;

GRANT UPDATE ON TABLE public.quotes TO service_role;

GRANT DELETE ON TABLE public.revenue_forecast TO anon;

GRANT INSERT ON TABLE public.revenue_forecast TO anon;

GRANT MAINTAIN ON TABLE public.revenue_forecast TO anon;

GRANT REFERENCES ON TABLE public.revenue_forecast TO anon;

GRANT SELECT ON TABLE public.revenue_forecast TO anon;

GRANT TRIGGER ON TABLE public.revenue_forecast TO anon;

GRANT TRUNCATE ON TABLE public.revenue_forecast TO anon;

GRANT UPDATE ON TABLE public.revenue_forecast TO anon;

GRANT DELETE ON TABLE public.revenue_forecast TO authenticated;

GRANT INSERT ON TABLE public.revenue_forecast TO authenticated;

GRANT MAINTAIN ON TABLE public.revenue_forecast TO authenticated;

GRANT REFERENCES ON TABLE public.revenue_forecast TO authenticated;

GRANT SELECT ON TABLE public.revenue_forecast TO authenticated;

GRANT TRIGGER ON TABLE public.revenue_forecast TO authenticated;

GRANT TRUNCATE ON TABLE public.revenue_forecast TO authenticated;

GRANT UPDATE ON TABLE public.revenue_forecast TO authenticated;

GRANT DELETE ON TABLE public.revenue_forecast TO service_role;

GRANT INSERT ON TABLE public.revenue_forecast TO service_role;

GRANT MAINTAIN ON TABLE public.revenue_forecast TO service_role;

GRANT REFERENCES ON TABLE public.revenue_forecast TO service_role;

GRANT SELECT ON TABLE public.revenue_forecast TO service_role;

GRANT TRIGGER ON TABLE public.revenue_forecast TO service_role;

GRANT TRUNCATE ON TABLE public.revenue_forecast TO service_role;

GRANT UPDATE ON TABLE public.revenue_forecast TO service_role;

GRANT DELETE ON TABLE public.sales_performance TO anon;

GRANT INSERT ON TABLE public.sales_performance TO anon;

GRANT MAINTAIN ON TABLE public.sales_performance TO anon;

GRANT REFERENCES ON TABLE public.sales_performance TO anon;

GRANT SELECT ON TABLE public.sales_performance TO anon;

GRANT TRIGGER ON TABLE public.sales_performance TO anon;

GRANT TRUNCATE ON TABLE public.sales_performance TO anon;

GRANT UPDATE ON TABLE public.sales_performance TO anon;

GRANT DELETE ON TABLE public.sales_performance TO authenticated;

GRANT INSERT ON TABLE public.sales_performance TO authenticated;

GRANT MAINTAIN ON TABLE public.sales_performance TO authenticated;

GRANT REFERENCES ON TABLE public.sales_performance TO authenticated;

GRANT SELECT ON TABLE public.sales_performance TO authenticated;

GRANT TRIGGER ON TABLE public.sales_performance TO authenticated;

GRANT TRUNCATE ON TABLE public.sales_performance TO authenticated;

GRANT UPDATE ON TABLE public.sales_performance TO authenticated;

GRANT DELETE ON TABLE public.sales_performance TO service_role;

GRANT INSERT ON TABLE public.sales_performance TO service_role;

GRANT MAINTAIN ON TABLE public.sales_performance TO service_role;

GRANT REFERENCES ON TABLE public.sales_performance TO service_role;

GRANT SELECT ON TABLE public.sales_performance TO service_role;

GRANT TRIGGER ON TABLE public.sales_performance TO service_role;

GRANT TRUNCATE ON TABLE public.sales_performance TO service_role;

GRANT UPDATE ON TABLE public.sales_performance TO service_role;

GRANT DELETE ON TABLE public.tasks TO anon;

GRANT INSERT ON TABLE public.tasks TO anon;

GRANT MAINTAIN ON TABLE public.tasks TO anon;

GRANT REFERENCES ON TABLE public.tasks TO anon;

GRANT SELECT ON TABLE public.tasks TO anon;

GRANT TRIGGER ON TABLE public.tasks TO anon;

GRANT TRUNCATE ON TABLE public.tasks TO anon;

GRANT UPDATE ON TABLE public.tasks TO anon;

GRANT DELETE ON TABLE public.tasks TO authenticated;

GRANT INSERT ON TABLE public.tasks TO authenticated;

GRANT MAINTAIN ON TABLE public.tasks TO authenticated;

GRANT REFERENCES ON TABLE public.tasks TO authenticated;

GRANT SELECT ON TABLE public.tasks TO authenticated;

GRANT TRIGGER ON TABLE public.tasks TO authenticated;

GRANT TRUNCATE ON TABLE public.tasks TO authenticated;

GRANT UPDATE ON TABLE public.tasks TO authenticated;

GRANT DELETE ON TABLE public.tasks TO service_role;

GRANT INSERT ON TABLE public.tasks TO service_role;

GRANT MAINTAIN ON TABLE public.tasks TO service_role;

GRANT REFERENCES ON TABLE public.tasks TO service_role;

GRANT SELECT ON TABLE public.tasks TO service_role;

GRANT TRIGGER ON TABLE public.tasks TO service_role;

GRANT TRUNCATE ON TABLE public.tasks TO service_role;

GRANT UPDATE ON TABLE public.tasks TO service_role;

GRANT DELETE ON TABLE public.transfer_history TO anon;

GRANT INSERT ON TABLE public.transfer_history TO anon;

GRANT MAINTAIN ON TABLE public.transfer_history TO anon;

GRANT REFERENCES ON TABLE public.transfer_history TO anon;

GRANT SELECT ON TABLE public.transfer_history TO anon;

GRANT TRIGGER ON TABLE public.transfer_history TO anon;

GRANT TRUNCATE ON TABLE public.transfer_history TO anon;

GRANT UPDATE ON TABLE public.transfer_history TO anon;

GRANT DELETE ON TABLE public.transfer_history TO authenticated;

GRANT INSERT ON TABLE public.transfer_history TO authenticated;

GRANT MAINTAIN ON TABLE public.transfer_history TO authenticated;

GRANT REFERENCES ON TABLE public.transfer_history TO authenticated;

GRANT SELECT ON TABLE public.transfer_history TO authenticated;

GRANT TRIGGER ON TABLE public.transfer_history TO authenticated;

GRANT TRUNCATE ON TABLE public.transfer_history TO authenticated;

GRANT UPDATE ON TABLE public.transfer_history TO authenticated;

GRANT DELETE ON TABLE public.transfer_history TO service_role;

GRANT INSERT ON TABLE public.transfer_history TO service_role;

GRANT MAINTAIN ON TABLE public.transfer_history TO service_role;

GRANT REFERENCES ON TABLE public.transfer_history TO service_role;

GRANT SELECT ON TABLE public.transfer_history TO service_role;

GRANT TRIGGER ON TABLE public.transfer_history TO service_role;

GRANT TRUNCATE ON TABLE public.transfer_history TO service_role;

GRANT UPDATE ON TABLE public.transfer_history TO service_role;

GRANT DELETE ON TABLE public.user_features TO anon;

GRANT INSERT ON TABLE public.user_features TO anon;

GRANT MAINTAIN ON TABLE public.user_features TO anon;

GRANT REFERENCES ON TABLE public.user_features TO anon;

GRANT SELECT ON TABLE public.user_features TO anon;

GRANT TRIGGER ON TABLE public.user_features TO anon;

GRANT TRUNCATE ON TABLE public.user_features TO anon;

GRANT UPDATE ON TABLE public.user_features TO anon;

GRANT DELETE ON TABLE public.user_features TO authenticated;

GRANT INSERT ON TABLE public.user_features TO authenticated;

GRANT MAINTAIN ON TABLE public.user_features TO authenticated;

GRANT REFERENCES ON TABLE public.user_features TO authenticated;

GRANT SELECT ON TABLE public.user_features TO authenticated;

GRANT TRIGGER ON TABLE public.user_features TO authenticated;

GRANT TRUNCATE ON TABLE public.user_features TO authenticated;

GRANT UPDATE ON TABLE public.user_features TO authenticated;

GRANT DELETE ON TABLE public.user_features TO service_role;

GRANT INSERT ON TABLE public.user_features TO service_role;

GRANT MAINTAIN ON TABLE public.user_features TO service_role;

GRANT REFERENCES ON TABLE public.user_features TO service_role;

GRANT SELECT ON TABLE public.user_features TO service_role;

GRANT TRIGGER ON TABLE public.user_features TO service_role;

GRANT TRUNCATE ON TABLE public.user_features TO service_role;

GRANT UPDATE ON TABLE public.user_features TO service_role;

GRANT DELETE ON TABLE public.user_session_daily TO anon;

GRANT INSERT ON TABLE public.user_session_daily TO anon;

GRANT MAINTAIN ON TABLE public.user_session_daily TO anon;

GRANT REFERENCES ON TABLE public.user_session_daily TO anon;

GRANT SELECT ON TABLE public.user_session_daily TO anon;

GRANT TRIGGER ON TABLE public.user_session_daily TO anon;

GRANT TRUNCATE ON TABLE public.user_session_daily TO anon;

GRANT UPDATE ON TABLE public.user_session_daily TO anon;

GRANT DELETE ON TABLE public.user_session_daily TO authenticated;

GRANT INSERT ON TABLE public.user_session_daily TO authenticated;

GRANT MAINTAIN ON TABLE public.user_session_daily TO authenticated;

GRANT REFERENCES ON TABLE public.user_session_daily TO authenticated;

GRANT SELECT ON TABLE public.user_session_daily TO authenticated;

GRANT TRIGGER ON TABLE public.user_session_daily TO authenticated;

GRANT TRUNCATE ON TABLE public.user_session_daily TO authenticated;

GRANT UPDATE ON TABLE public.user_session_daily TO authenticated;

GRANT DELETE ON TABLE public.user_session_daily TO service_role;

GRANT INSERT ON TABLE public.user_session_daily TO service_role;

GRANT MAINTAIN ON TABLE public.user_session_daily TO service_role;

GRANT REFERENCES ON TABLE public.user_session_daily TO service_role;

GRANT SELECT ON TABLE public.user_session_daily TO service_role;

GRANT TRIGGER ON TABLE public.user_session_daily TO service_role;

GRANT TRUNCATE ON TABLE public.user_session_daily TO service_role;

GRANT UPDATE ON TABLE public.user_session_daily TO service_role;

GRANT DELETE ON TABLE public.v_account_receivable_aging TO anon;

GRANT INSERT ON TABLE public.v_account_receivable_aging TO anon;

GRANT MAINTAIN ON TABLE public.v_account_receivable_aging TO anon;

GRANT REFERENCES ON TABLE public.v_account_receivable_aging TO anon;

GRANT SELECT ON TABLE public.v_account_receivable_aging TO anon;

GRANT TRIGGER ON TABLE public.v_account_receivable_aging TO anon;

GRANT TRUNCATE ON TABLE public.v_account_receivable_aging TO anon;

GRANT UPDATE ON TABLE public.v_account_receivable_aging TO anon;

GRANT DELETE ON TABLE public.v_account_receivable_aging TO authenticated;

GRANT INSERT ON TABLE public.v_account_receivable_aging TO authenticated;

GRANT MAINTAIN ON TABLE public.v_account_receivable_aging TO authenticated;

GRANT REFERENCES ON TABLE public.v_account_receivable_aging TO authenticated;

GRANT SELECT ON TABLE public.v_account_receivable_aging TO authenticated;

GRANT TRIGGER ON TABLE public.v_account_receivable_aging TO authenticated;

GRANT TRUNCATE ON TABLE public.v_account_receivable_aging TO authenticated;

GRANT UPDATE ON TABLE public.v_account_receivable_aging TO authenticated;

GRANT DELETE ON TABLE public.v_account_receivable_aging TO service_role;

GRANT INSERT ON TABLE public.v_account_receivable_aging TO service_role;

GRANT MAINTAIN ON TABLE public.v_account_receivable_aging TO service_role;

GRANT REFERENCES ON TABLE public.v_account_receivable_aging TO service_role;

GRANT SELECT ON TABLE public.v_account_receivable_aging TO service_role;

GRANT TRIGGER ON TABLE public.v_account_receivable_aging TO service_role;

GRANT TRUNCATE ON TABLE public.v_account_receivable_aging TO service_role;

GRANT UPDATE ON TABLE public.v_account_receivable_aging TO service_role;

GRANT DELETE ON TABLE public.v_funnel_conversion TO anon;

GRANT INSERT ON TABLE public.v_funnel_conversion TO anon;

GRANT MAINTAIN ON TABLE public.v_funnel_conversion TO anon;

GRANT REFERENCES ON TABLE public.v_funnel_conversion TO anon;

GRANT SELECT ON TABLE public.v_funnel_conversion TO anon;

GRANT TRIGGER ON TABLE public.v_funnel_conversion TO anon;

GRANT TRUNCATE ON TABLE public.v_funnel_conversion TO anon;

GRANT UPDATE ON TABLE public.v_funnel_conversion TO anon;

GRANT DELETE ON TABLE public.v_funnel_conversion TO authenticated;

GRANT INSERT ON TABLE public.v_funnel_conversion TO authenticated;

GRANT MAINTAIN ON TABLE public.v_funnel_conversion TO authenticated;

GRANT REFERENCES ON TABLE public.v_funnel_conversion TO authenticated;

GRANT SELECT ON TABLE public.v_funnel_conversion TO authenticated;

GRANT TRIGGER ON TABLE public.v_funnel_conversion TO authenticated;

GRANT TRUNCATE ON TABLE public.v_funnel_conversion TO authenticated;

GRANT UPDATE ON TABLE public.v_funnel_conversion TO authenticated;

GRANT DELETE ON TABLE public.v_funnel_conversion TO service_role;

GRANT INSERT ON TABLE public.v_funnel_conversion TO service_role;

GRANT MAINTAIN ON TABLE public.v_funnel_conversion TO service_role;

GRANT REFERENCES ON TABLE public.v_funnel_conversion TO service_role;

GRANT SELECT ON TABLE public.v_funnel_conversion TO service_role;

GRANT TRIGGER ON TABLE public.v_funnel_conversion TO service_role;

GRANT TRUNCATE ON TABLE public.v_funnel_conversion TO service_role;

GRANT UPDATE ON TABLE public.v_funnel_conversion TO service_role;

GRANT DELETE ON TABLE public.v_lead_trace TO anon;

GRANT INSERT ON TABLE public.v_lead_trace TO anon;

GRANT MAINTAIN ON TABLE public.v_lead_trace TO anon;

GRANT REFERENCES ON TABLE public.v_lead_trace TO anon;

GRANT SELECT ON TABLE public.v_lead_trace TO anon;

GRANT TRIGGER ON TABLE public.v_lead_trace TO anon;

GRANT TRUNCATE ON TABLE public.v_lead_trace TO anon;

GRANT UPDATE ON TABLE public.v_lead_trace TO anon;

GRANT DELETE ON TABLE public.v_lead_trace TO authenticated;

GRANT INSERT ON TABLE public.v_lead_trace TO authenticated;

GRANT MAINTAIN ON TABLE public.v_lead_trace TO authenticated;

GRANT REFERENCES ON TABLE public.v_lead_trace TO authenticated;

GRANT SELECT ON TABLE public.v_lead_trace TO authenticated;

GRANT TRIGGER ON TABLE public.v_lead_trace TO authenticated;

GRANT TRUNCATE ON TABLE public.v_lead_trace TO authenticated;

GRANT UPDATE ON TABLE public.v_lead_trace TO authenticated;

GRANT DELETE ON TABLE public.v_lead_trace TO service_role;

GRANT INSERT ON TABLE public.v_lead_trace TO service_role;

GRANT MAINTAIN ON TABLE public.v_lead_trace TO service_role;

GRANT REFERENCES ON TABLE public.v_lead_trace TO service_role;

GRANT SELECT ON TABLE public.v_lead_trace TO service_role;

GRANT TRIGGER ON TABLE public.v_lead_trace TO service_role;

GRANT TRUNCATE ON TABLE public.v_lead_trace TO service_role;

GRANT UPDATE ON TABLE public.v_lead_trace TO service_role;

GRANT DELETE ON TABLE public.v_risk_pool TO anon;

GRANT INSERT ON TABLE public.v_risk_pool TO anon;

GRANT MAINTAIN ON TABLE public.v_risk_pool TO anon;

GRANT REFERENCES ON TABLE public.v_risk_pool TO anon;

GRANT SELECT ON TABLE public.v_risk_pool TO anon;

GRANT TRIGGER ON TABLE public.v_risk_pool TO anon;

GRANT TRUNCATE ON TABLE public.v_risk_pool TO anon;

GRANT UPDATE ON TABLE public.v_risk_pool TO anon;

GRANT DELETE ON TABLE public.v_risk_pool TO authenticated;

GRANT INSERT ON TABLE public.v_risk_pool TO authenticated;

GRANT MAINTAIN ON TABLE public.v_risk_pool TO authenticated;

GRANT REFERENCES ON TABLE public.v_risk_pool TO authenticated;

GRANT SELECT ON TABLE public.v_risk_pool TO authenticated;

GRANT TRIGGER ON TABLE public.v_risk_pool TO authenticated;

GRANT TRUNCATE ON TABLE public.v_risk_pool TO authenticated;

GRANT UPDATE ON TABLE public.v_risk_pool TO authenticated;

GRANT DELETE ON TABLE public.v_risk_pool TO service_role;

GRANT INSERT ON TABLE public.v_risk_pool TO service_role;

GRANT MAINTAIN ON TABLE public.v_risk_pool TO service_role;

GRANT REFERENCES ON TABLE public.v_risk_pool TO service_role;

GRANT SELECT ON TABLE public.v_risk_pool TO service_role;

GRANT TRIGGER ON TABLE public.v_risk_pool TO service_role;

GRANT TRUNCATE ON TABLE public.v_risk_pool TO service_role;

GRANT UPDATE ON TABLE public.v_risk_pool TO service_role;

GRANT DELETE ON TABLE public.v_sales_personal_stats TO anon;

GRANT INSERT ON TABLE public.v_sales_personal_stats TO anon;

GRANT MAINTAIN ON TABLE public.v_sales_personal_stats TO anon;

GRANT REFERENCES ON TABLE public.v_sales_personal_stats TO anon;

GRANT SELECT ON TABLE public.v_sales_personal_stats TO anon;

GRANT TRIGGER ON TABLE public.v_sales_personal_stats TO anon;

GRANT TRUNCATE ON TABLE public.v_sales_personal_stats TO anon;

GRANT UPDATE ON TABLE public.v_sales_personal_stats TO anon;

GRANT DELETE ON TABLE public.v_sales_personal_stats TO authenticated;

GRANT INSERT ON TABLE public.v_sales_personal_stats TO authenticated;

GRANT MAINTAIN ON TABLE public.v_sales_personal_stats TO authenticated;

GRANT REFERENCES ON TABLE public.v_sales_personal_stats TO authenticated;

GRANT SELECT ON TABLE public.v_sales_personal_stats TO authenticated;

GRANT TRIGGER ON TABLE public.v_sales_personal_stats TO authenticated;

GRANT TRUNCATE ON TABLE public.v_sales_personal_stats TO authenticated;

GRANT UPDATE ON TABLE public.v_sales_personal_stats TO authenticated;

GRANT DELETE ON TABLE public.v_sales_personal_stats TO service_role;

GRANT INSERT ON TABLE public.v_sales_personal_stats TO service_role;

GRANT MAINTAIN ON TABLE public.v_sales_personal_stats TO service_role;

GRANT REFERENCES ON TABLE public.v_sales_personal_stats TO service_role;

GRANT SELECT ON TABLE public.v_sales_personal_stats TO service_role;

GRANT TRIGGER ON TABLE public.v_sales_personal_stats TO service_role;

GRANT TRUNCATE ON TABLE public.v_sales_personal_stats TO service_role;

GRANT UPDATE ON TABLE public.v_sales_personal_stats TO service_role;

GRANT DELETE ON TABLE public.v_stagnant_leads TO anon;

GRANT INSERT ON TABLE public.v_stagnant_leads TO anon;

GRANT MAINTAIN ON TABLE public.v_stagnant_leads TO anon;

GRANT REFERENCES ON TABLE public.v_stagnant_leads TO anon;

GRANT SELECT ON TABLE public.v_stagnant_leads TO anon;

GRANT TRIGGER ON TABLE public.v_stagnant_leads TO anon;

GRANT TRUNCATE ON TABLE public.v_stagnant_leads TO anon;

GRANT UPDATE ON TABLE public.v_stagnant_leads TO anon;

GRANT DELETE ON TABLE public.v_stagnant_leads TO authenticated;

GRANT INSERT ON TABLE public.v_stagnant_leads TO authenticated;

GRANT MAINTAIN ON TABLE public.v_stagnant_leads TO authenticated;

GRANT REFERENCES ON TABLE public.v_stagnant_leads TO authenticated;

GRANT SELECT ON TABLE public.v_stagnant_leads TO authenticated;

GRANT TRIGGER ON TABLE public.v_stagnant_leads TO authenticated;

GRANT TRUNCATE ON TABLE public.v_stagnant_leads TO authenticated;

GRANT UPDATE ON TABLE public.v_stagnant_leads TO authenticated;

GRANT DELETE ON TABLE public.v_stagnant_leads TO service_role;

GRANT INSERT ON TABLE public.v_stagnant_leads TO service_role;

GRANT MAINTAIN ON TABLE public.v_stagnant_leads TO service_role;

GRANT REFERENCES ON TABLE public.v_stagnant_leads TO service_role;

GRANT SELECT ON TABLE public.v_stagnant_leads TO service_role;

GRANT TRIGGER ON TABLE public.v_stagnant_leads TO service_role;

GRANT TRUNCATE ON TABLE public.v_stagnant_leads TO service_role;

GRANT UPDATE ON TABLE public.v_stagnant_leads TO service_role;

GRANT DELETE ON TABLE public.v_unified_timeline TO anon;

GRANT INSERT ON TABLE public.v_unified_timeline TO anon;

GRANT MAINTAIN ON TABLE public.v_unified_timeline TO anon;

GRANT REFERENCES ON TABLE public.v_unified_timeline TO anon;

GRANT SELECT ON TABLE public.v_unified_timeline TO anon;

GRANT TRIGGER ON TABLE public.v_unified_timeline TO anon;

GRANT TRUNCATE ON TABLE public.v_unified_timeline TO anon;

GRANT UPDATE ON TABLE public.v_unified_timeline TO anon;

GRANT DELETE ON TABLE public.v_unified_timeline TO authenticated;

GRANT INSERT ON TABLE public.v_unified_timeline TO authenticated;

GRANT MAINTAIN ON TABLE public.v_unified_timeline TO authenticated;

GRANT REFERENCES ON TABLE public.v_unified_timeline TO authenticated;

GRANT SELECT ON TABLE public.v_unified_timeline TO authenticated;

GRANT TRIGGER ON TABLE public.v_unified_timeline TO authenticated;

GRANT TRUNCATE ON TABLE public.v_unified_timeline TO authenticated;

GRANT UPDATE ON TABLE public.v_unified_timeline TO authenticated;

GRANT DELETE ON TABLE public.v_unified_timeline TO service_role;

GRANT INSERT ON TABLE public.v_unified_timeline TO service_role;

GRANT MAINTAIN ON TABLE public.v_unified_timeline TO service_role;

GRANT REFERENCES ON TABLE public.v_unified_timeline TO service_role;

GRANT SELECT ON TABLE public.v_unified_timeline TO service_role;

GRANT TRIGGER ON TABLE public.v_unified_timeline TO service_role;

GRANT TRUNCATE ON TABLE public.v_unified_timeline TO service_role;

GRANT UPDATE ON TABLE public.v_unified_timeline TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.apply_standard_rls(table_name text) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.apply_standard_rls(table_name text) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.apply_standard_rls(table_name text) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.apply_standard_rls(table_name text) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.auto_create_task_from_followup() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.auto_create_task_from_followup() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.auto_create_task_from_followup() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.auto_create_task_from_followup() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.auto_enable_rls() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.auto_enable_rls() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.auto_enable_rls() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.auto_enable_rls() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.check_milestone_order() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.check_milestone_order() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.check_milestone_order() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.check_milestone_order() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.days_since_last_contact(lead_id uuid) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.days_since_last_contact(lead_id uuid) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.days_since_last_contact(lead_id uuid) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.days_since_last_contact(lead_id uuid) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.delete_lead_atomic(p_lead_id uuid, p_idempotency_key uuid) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.delete_lead_atomic(p_lead_id uuid, p_idempotency_key uuid) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.delete_lead_atomic(p_lead_id uuid, p_idempotency_key uuid) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.delete_lead_atomic(p_lead_id uuid, p_idempotency_key uuid) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.derive_lead_status() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.derive_lead_status() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.derive_lead_status() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.derive_lead_status() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.detect_stale_leads(stale_days integer) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.detect_stale_leads(stale_days integer) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.detect_stale_leads(stale_days integer) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.detect_stale_leads(stale_days integer) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.enforce_active_lead_transfer_candidate() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.enforce_active_lead_transfer_candidate() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.enforce_active_lead_transfer_candidate() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.enforce_active_lead_transfer_candidate() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.enforce_followup_required() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.enforce_followup_required() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.enforce_followup_required() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.enforce_followup_required() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.generate_quote_no(year_param integer) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.generate_quote_no(year_param integer) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.generate_quote_no(year_param integer) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.generate_quote_no(year_param integer) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_my_role() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_my_role() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_my_role() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_my_role() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_team_activity(p_date date) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_team_activity(p_date date) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_team_activity(p_date date) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.get_team_activity(p_date date) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_auth_login() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_auth_login() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_auth_login() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_auth_login() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_new_user() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_new_user() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_new_user() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_new_user() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_user_login() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_user_login() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_user_login() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.handle_user_login() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_activity(p_action text, p_entity_type text, p_entity_id uuid, p_details jsonb, p_page_path text, p_duration_seconds integer) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_activity(p_action text, p_entity_type text, p_entity_id uuid, p_details jsonb, p_page_path text, p_duration_seconds integer) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_activity(p_action text, p_entity_type text, p_entity_id uuid, p_details jsonb, p_page_path text, p_duration_seconds integer) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_activity(p_action text, p_entity_type text, p_entity_id uuid, p_details jsonb, p_page_path text, p_duration_seconds integer) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_activity(p_lead_id uuid, p_type text, p_content text, p_user_id uuid) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_activity(p_lead_id uuid, p_type text, p_content text, p_user_id uuid) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_activity(p_lead_id uuid, p_type text, p_content text, p_user_id uuid) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_activity(p_lead_id uuid, p_type text, p_content text, p_user_id uuid) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_auth_event() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_auth_event() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_auth_event() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.log_auth_event() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.milestone_order(milestone text) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.milestone_order(milestone text) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.milestone_order(milestone text) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.milestone_order(milestone text) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.next_quote_no() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.next_quote_no() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.next_quote_no() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.next_quote_no() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.on_lead_won() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.on_lead_won() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.on_lead_won() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.on_lead_won() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.reassign_lead(p_lead_id uuid, p_new_sales uuid, p_reason text) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.reassign_lead(p_lead_id uuid, p_new_sales uuid, p_reason text) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.reassign_lead(p_lead_id uuid, p_new_sales uuid, p_reason text) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.reassign_lead(p_lead_id uuid, p_new_sales uuid, p_reason text) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.reassign_lead_atomic(p_lead_id uuid, p_new_assignee uuid, p_expected_updated_at timestamp with time zone, p_idempotency_key uuid, p_reason text) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.reassign_lead_atomic(p_lead_id uuid, p_new_assignee uuid, p_expected_updated_at timestamp with time zone, p_idempotency_key uuid, p_reason text) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.reassign_lead_atomic(p_lead_id uuid, p_new_assignee uuid, p_expected_updated_at timestamp with time zone, p_idempotency_key uuid, p_reason text) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.reassign_lead_atomic(p_lead_id uuid, p_new_assignee uuid, p_expected_updated_at timestamp with time zone, p_idempotency_key uuid, p_reason text) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.recomplete_lead_milestone(p_lead_id uuid, p_milestone_key text, p_notes text) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.recomplete_lead_milestone(p_lead_id uuid, p_milestone_key text, p_notes text) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.recomplete_lead_milestone(p_lead_id uuid, p_milestone_key text, p_notes text) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.recomplete_lead_milestone(p_lead_id uuid, p_milestone_key text, p_notes text) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_lead_contact_atomic(p_lead_id uuid, p_contact_method text, p_contact_time timestamp with time zone, p_contact_result text, p_summary text, p_contact_fingerprint text, p_idempotency_key uuid) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_lead_contact_atomic(p_lead_id uuid, p_contact_method text, p_contact_time timestamp with time zone, p_contact_result text, p_summary text, p_contact_fingerprint text, p_idempotency_key uuid) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_lead_contact_atomic(p_lead_id uuid, p_contact_method text, p_contact_time timestamp with time zone, p_contact_result text, p_summary text, p_contact_fingerprint text, p_idempotency_key uuid) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_lead_contact_atomic(p_lead_id uuid, p_contact_method text, p_contact_time timestamp with time zone, p_contact_result text, p_summary text, p_contact_fingerprint text, p_idempotency_key uuid) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_lead_note_atomic(p_lead_id uuid, p_note text, p_idempotency_key uuid) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_lead_note_atomic(p_lead_id uuid, p_note text, p_idempotency_key uuid) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_lead_note_atomic(p_lead_id uuid, p_note text, p_idempotency_key uuid) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_lead_note_atomic(p_lead_id uuid, p_note text, p_idempotency_key uuid) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.reopen_lead_milestone(p_lead_id uuid, p_milestone_key text, p_reason text) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.reopen_lead_milestone(p_lead_id uuid, p_milestone_key text, p_reason text) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.reopen_lead_milestone(p_lead_id uuid, p_milestone_key text, p_reason text) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.reopen_lead_milestone(p_lead_id uuid, p_milestone_key text, p_reason text) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.set_lost_reasons() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.set_lost_reasons() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.set_lost_reasons() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.set_lost_reasons() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.set_updated_at() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.set_updated_at() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.set_updated_at() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.set_updated_at() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_lead_next_followup() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_lead_next_followup() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_lead_next_followup() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_lead_next_followup() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_task_from_lead() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_task_from_lead() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_task_from_lead() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_task_from_lead() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_user_email_to_profile() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_user_email_to_profile() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_user_email_to_profile() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.sync_user_email_to_profile() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.transition_lead_stage(p_lead_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_idempotency_key uuid) FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.transition_lead_stage(p_lead_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_idempotency_key uuid) FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.transition_lead_stage(p_lead_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_idempotency_key uuid) FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.transition_lead_stage(p_lead_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_idempotency_key uuid) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_check_first_contact_gate() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_check_first_contact_gate() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_check_first_contact_gate() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_check_first_contact_gate() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_check_stage_sequence() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_check_stage_sequence() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_check_stage_sequence() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_check_stage_sequence() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_enforce_first_contact_milestone() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_enforce_first_contact_milestone() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_enforce_first_contact_milestone() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_enforce_first_contact_milestone() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_prevent_first_contact_delete() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_prevent_first_contact_delete() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_prevent_first_contact_delete() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_prevent_first_contact_delete() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_set_won_at() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_set_won_at() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_set_won_at() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.trg_set_won_at() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_installment_status() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_installment_status() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_installment_status() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_installment_status() FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_lead_metrics() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_lead_metrics() FROM anon;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_lead_metrics() FROM authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_lead_metrics() FROM service_role;

GRANT EXECUTE ON FUNCTION public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid) TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.apply_standard_rls(table_name text) TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.apply_standard_rls(table_name text) TO anon;

GRANT EXECUTE ON FUNCTION public.apply_standard_rls(table_name text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.apply_standard_rls(table_name text) TO service_role;

GRANT EXECUTE ON FUNCTION public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text) TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text) TO anon;

GRANT EXECUTE ON FUNCTION public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text) TO service_role;

GRANT EXECUTE ON FUNCTION public.auto_create_task_from_followup() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.auto_create_task_from_followup() TO anon;

GRANT EXECUTE ON FUNCTION public.auto_create_task_from_followup() TO authenticated;

GRANT EXECUTE ON FUNCTION public.auto_create_task_from_followup() TO service_role;

GRANT EXECUTE ON FUNCTION public.auto_enable_rls() TO service_role;

GRANT EXECUTE ON FUNCTION public.check_milestone_order() TO service_role;

GRANT EXECUTE ON FUNCTION public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid) TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.days_since_last_contact(lead_id uuid) TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.days_since_last_contact(lead_id uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.days_since_last_contact(lead_id uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.days_since_last_contact(lead_id uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.delete_lead_atomic(p_lead_id uuid, p_idempotency_key uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.delete_lead_atomic(p_lead_id uuid, p_idempotency_key uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.derive_lead_status() TO service_role;

GRANT EXECUTE ON FUNCTION public.detect_stale_leads(stale_days integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.enforce_active_lead_transfer_candidate() TO service_role;

GRANT EXECUTE ON FUNCTION public.enforce_followup_required() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.enforce_followup_required() TO anon;

GRANT EXECUTE ON FUNCTION public.enforce_followup_required() TO authenticated;

GRANT EXECUTE ON FUNCTION public.enforce_followup_required() TO service_role;

GRANT EXECUTE ON FUNCTION public.generate_quote_no(year_param integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_my_role() TO service_role;

GRANT EXECUTE ON FUNCTION public.get_team_activity(p_date date) TO service_role;

GRANT EXECUTE ON FUNCTION public.handle_auth_login() TO service_role;

GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

GRANT EXECUTE ON FUNCTION public.handle_user_login() TO service_role;

GRANT EXECUTE ON FUNCTION public.log_activity(p_action text, p_entity_type text, p_entity_id uuid, p_details jsonb, p_page_path text, p_duration_seconds integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.log_activity(p_lead_id uuid, p_type text, p_content text, p_user_id uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.log_auth_event() TO service_role;

GRANT EXECUTE ON FUNCTION public.milestone_order(milestone text) TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.milestone_order(milestone text) TO anon;

GRANT EXECUTE ON FUNCTION public.milestone_order(milestone text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.milestone_order(milestone text) TO service_role;

GRANT EXECUTE ON FUNCTION public.next_quote_no() TO authenticated;

GRANT EXECUTE ON FUNCTION public.next_quote_no() TO service_role;

GRANT EXECUTE ON FUNCTION public.on_lead_won() TO service_role;

GRANT EXECUTE ON FUNCTION public.reassign_lead(p_lead_id uuid, p_new_sales uuid, p_reason text) TO service_role;

GRANT EXECUTE ON FUNCTION public.reassign_lead_atomic(p_lead_id uuid, p_new_assignee uuid, p_expected_updated_at timestamp with time zone, p_idempotency_key uuid, p_reason text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.reassign_lead_atomic(p_lead_id uuid, p_new_assignee uuid, p_expected_updated_at timestamp with time zone, p_idempotency_key uuid, p_reason text) TO service_role;

GRANT EXECUTE ON FUNCTION public.recomplete_lead_milestone(p_lead_id uuid, p_milestone_key text, p_notes text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.recomplete_lead_milestone(p_lead_id uuid, p_milestone_key text, p_notes text) TO service_role;

GRANT EXECUTE ON FUNCTION public.record_lead_contact_atomic(p_lead_id uuid, p_contact_method text, p_contact_time timestamp with time zone, p_contact_result text, p_summary text, p_contact_fingerprint text, p_idempotency_key uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.record_lead_contact_atomic(p_lead_id uuid, p_contact_method text, p_contact_time timestamp with time zone, p_contact_result text, p_summary text, p_contact_fingerprint text, p_idempotency_key uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.record_lead_note_atomic(p_lead_id uuid, p_note text, p_idempotency_key uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.record_lead_note_atomic(p_lead_id uuid, p_note text, p_idempotency_key uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.reopen_lead_milestone(p_lead_id uuid, p_milestone_key text, p_reason text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.reopen_lead_milestone(p_lead_id uuid, p_milestone_key text, p_reason text) TO service_role;

GRANT EXECUTE ON FUNCTION public.set_lost_reasons() TO service_role;

GRANT EXECUTE ON FUNCTION public.set_updated_at() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.set_updated_at() TO anon;

GRANT EXECUTE ON FUNCTION public.set_updated_at() TO authenticated;

GRANT EXECUTE ON FUNCTION public.set_updated_at() TO service_role;

GRANT EXECUTE ON FUNCTION public.sync_lead_next_followup() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.sync_lead_next_followup() TO anon;

GRANT EXECUTE ON FUNCTION public.sync_lead_next_followup() TO authenticated;

GRANT EXECUTE ON FUNCTION public.sync_lead_next_followup() TO service_role;

GRANT EXECUTE ON FUNCTION public.sync_task_from_lead() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.sync_task_from_lead() TO anon;

GRANT EXECUTE ON FUNCTION public.sync_task_from_lead() TO authenticated;

GRANT EXECUTE ON FUNCTION public.sync_task_from_lead() TO service_role;

GRANT EXECUTE ON FUNCTION public.sync_user_email_to_profile() TO service_role;

GRANT EXECUTE ON FUNCTION public.transition_lead_stage(p_lead_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_idempotency_key uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.transition_lead_stage(p_lead_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_idempotency_key uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.trg_check_first_contact_gate() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.trg_check_first_contact_gate() TO anon;

GRANT EXECUTE ON FUNCTION public.trg_check_first_contact_gate() TO authenticated;

GRANT EXECUTE ON FUNCTION public.trg_check_first_contact_gate() TO service_role;

GRANT EXECUTE ON FUNCTION public.trg_check_stage_sequence() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.trg_check_stage_sequence() TO anon;

GRANT EXECUTE ON FUNCTION public.trg_check_stage_sequence() TO authenticated;

GRANT EXECUTE ON FUNCTION public.trg_check_stage_sequence() TO service_role;

GRANT EXECUTE ON FUNCTION public.trg_enforce_first_contact_milestone() TO service_role;

GRANT EXECUTE ON FUNCTION public.trg_prevent_first_contact_delete() TO service_role;

GRANT EXECUTE ON FUNCTION public.trg_set_won_at() TO service_role;

GRANT EXECUTE ON FUNCTION public.update_installment_status() TO service_role;

GRANT EXECUTE ON FUNCTION public.update_lead_metrics() TO service_role;

RESET check_function_bodies;
RESET search_path;
