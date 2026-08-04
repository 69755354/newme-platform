\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.activity_logs
    WHERE id = '78000000-3088-4000-8000-000000000088'
      AND tenant_id = '00000000-0000-0000-0000-000000000000'
      AND organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.user_session_daily
    WHERE id = '78000000-3288-4000-8000-000000000088'
      AND tenant_id = '00000000-0000-0000-0000-000000000000'
      AND organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'
  ) THEN
    RAISE EXCEPTION 'legacy_zero_tenant_organization_backfill_failed';
  END IF;
END
$$;

INSERT INTO auth.users(id) VALUES
  ('78000000-0000-4000-8000-000000000011'),
  ('78000000-0000-4000-8000-000000000012'),
  ('78000000-0000-4000-8000-000000000013'),
  ('78000000-0000-4000-8000-000000000014'),
  ('78000000-0000-4000-8000-000000000015'),
  ('78000000-0000-4000-8000-000000000016'),
  ('78000000-0000-4000-8000-000000000017'),
  ('78000000-0000-4000-8000-000000000018'),
  ('78000000-0000-4000-8000-000000000019');
INSERT INTO public.profiles(id, role, is_active) VALUES
  ('78000000-0000-4000-8000-000000000011', 'admin', true),
  ('78000000-0000-4000-8000-000000000012', 'sales', true),
  ('78000000-0000-4000-8000-000000000013', 'admin', true),
  ('78000000-0000-4000-8000-000000000014', 'operator', true),
  ('78000000-0000-4000-8000-000000000015', 'admin', true),
  ('78000000-0000-4000-8000-000000000016', 'operator', true),
  ('78000000-0000-4000-8000-000000000017', 'admin', true),
  ('78000000-0000-4000-8000-000000000018', 'sales', true),
  ('78000000-0000-4000-8000-000000000019', 'sales', true);
INSERT INTO public.platform_staff(id, user_id, status, staff_ref, role_key) VALUES
  ('78000000-0014-4000-8000-000000000014',
    '78000000-0000-4000-8000-000000000014', 'active', 'sam78-actor',
    'platform_ops'),
  ('78000000-0015-4000-8000-000000000015',
    '78000000-0000-4000-8000-000000000015', 'active', 'sam78-approver',
    'platform_owner'),
  ('78000000-0016-4000-8000-000000000016',
    '78000000-0000-4000-8000-000000000016', 'active', 'sam78-support',
    'platform_support'),
  ('78000000-0017-4000-8000-000000000017',
    '78000000-0000-4000-8000-000000000017', 'active', 'sam78-auditor',
    'platform_auditor');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_document_sequences
    WHERE organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'
      AND document_kind = 'contract' AND document_date = DATE '2026-08-02'
      AND next_value = 8
  ) THEN RAISE EXCEPTION 'legacy contract sequence was not backfilled to max suffix plus one'; END IF;
END
$$;

DO $$
DECLARE
  missing_force_table text;
BEGIN
  SELECT required.table_name INTO missing_force_table
  FROM unnest(ARRAY[
    'membership_roles', 'activities', 'activity_logs', 'ad_spend',
    'audit_logs', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'kpi_targets',
    'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'notifications', 'quotes', 'transfer_history', 'user_session_daily',
    'leads', 'organization_lifecycle_requests'
  ]::text[]) required(table_name)
  LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
  LEFT JOIN pg_class relation
    ON relation.relnamespace = namespace.oid
   AND relation.relname = required.table_name
  WHERE relation.oid IS NULL OR relation.relforcerowsecurity IS DISTINCT FROM true
  ORDER BY required.table_name
  LIMIT 1;
  IF missing_force_table IS NOT NULL THEN
    RAISE EXCEPTION 'required FORCE RLS missing on %', missing_force_table;
  END IF;
END
$$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
SELECT set_config(
  'v4.approval_org_a',
  public.v4_request_platform_action_approval(
    'organization.provision', 'sam78-closure-a',
    jsonb_build_object(
      'slug', 'sam78-closure-a', 'name', 'SAM-78 Closure A',
      'industry_key', 'real_estate', 'plan_key', 'starter',
      'billable_seat_limit', 3,
      'owner_user_id', '78000000-0000-4000-8000-000000000011'::uuid
    ),
    'sam78-approval-provision-org-a'
  ) ->> 'approval_request_id',
  false
);

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000016';
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_request_platform_action_approval(
      'organization.provision', 'sam78-denied-support',
      jsonb_build_object(
        'slug', 'sam78-denied-support', 'name', 'Denied Support',
        'industry_key', 'retail', 'plan_key', 'starter',
        'billable_seat_limit', 1,
        'owner_user_id', '78000000-0000-4000-8000-000000000011'::uuid
      ),
      'sam78-support-request-denied'
    );
    RAISE EXCEPTION 'platform support requested organization action';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'platform_action_request_permission_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.v4_approve_platform_action(
      current_setting('v4.approval_org_a')::uuid,
      'sam78-support-approve-denied'
    );
    RAISE EXCEPTION 'platform support approved organization action';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'platform_action_approve_permission_required' THEN RAISE; END IF;
  END;
END
$$;

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000017';
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_request_platform_action_approval(
      'organization.provision', 'sam78-denied-auditor',
      jsonb_build_object(
        'slug', 'sam78-denied-auditor', 'name', 'Denied Auditor',
        'industry_key', 'retail', 'plan_key', 'starter',
        'billable_seat_limit', 1,
        'owner_user_id', '78000000-0000-4000-8000-000000000011'::uuid
      ),
      'sam78-auditor-request-denied'
    );
    RAISE EXCEPTION 'platform auditor requested organization action';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'platform_action_request_permission_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.v4_approve_platform_action(
      current_setting('v4.approval_org_a')::uuid,
      'sam78-auditor-approve-denied'
    );
    RAISE EXCEPTION 'platform auditor approved organization action';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'platform_action_approve_permission_required' THEN RAISE; END IF;
  END;
END
$$;

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_approve_platform_action(
      current_setting('v4.approval_org_a')::uuid,
      'sam78-self-approve-denied'
    );
    RAISE EXCEPTION 'platform requester self-approved organization action';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'independent_platform_approver_required' THEN RAISE; END IF;
  END;
END
$$;

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
SELECT public.v4_approve_platform_action(
  current_setting('v4.approval_org_a')::uuid,
  'sam78-approve-provision-org-a'
);

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
SELECT set_config(
  'v4.org_a',
  public.v4_execute_approved_platform_action(
    current_setting('v4.approval_org_a')::uuid,
    'sam78:closure:org-a'
  ) ->> 'organization_id',
  false
);

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
SELECT set_config(
  'v4.approval_org_b',
  public.v4_request_platform_action_approval(
    'organization.provision', 'sam78-closure-b',
    jsonb_build_object(
      'slug', 'sam78-closure-b', 'name', 'SAM-78 Closure B',
      'industry_key', 'retail', 'plan_key', 'starter',
      'billable_seat_limit', 4,
      'owner_user_id', '78000000-0000-4000-8000-000000000013'::uuid
    ),
    'sam78-approval-provision-org-b'
  ) ->> 'approval_request_id',
  false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
SELECT public.v4_approve_platform_action(
  current_setting('v4.approval_org_b')::uuid,
  'sam78-approve-provision-org-b'
);
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
SELECT set_config(
  'v4.org_b',
  public.v4_execute_approved_platform_action(
    current_setting('v4.approval_org_b')::uuid,
    'sam78:closure:org-b'
  ) ->> 'organization_id',
  false
);

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT set_config(
  'v4.member_a',
  public.v4_invite_organization_member(
    current_setting('v4.org_a')::uuid,
    '78000000-0000-4000-8000-000000000012',
    'operations',
    'sam78-invite-member-a'
  ) ->> 'membership_id',
  false
);

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000012';
SELECT public.v4_accept_organization_membership(
  current_setting('v4.org_a')::uuid,
  current_setting('v4.member_a')::uuid,
  'sam78-accept-member-a'
);

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000013';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
SELECT set_config(
  'v4.member_b',
  public.v4_invite_organization_member(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000012',
    'specialist',
    'sam78-invite-member-b'
  ) ->> 'membership_id',
  false
);

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000012';
SELECT public.v4_accept_organization_membership(
  current_setting('v4.org_b')::uuid,
  current_setting('v4.member_b')::uuid,
  'sam78-accept-member-b'
);

-- This user is a legacy global admin and organization A owner, but only a
-- sales agent in organization B. High-risk B permissions must therefore be
-- derived exclusively from the B membership role.
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000013';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
SELECT set_config(
  'v4.member_global_admin_sales_b',
  public.v4_invite_organization_member(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000011',
    'sales_agent',
    'sam78-invite-global-admin-as-sales-b'
  ) ->> 'membership_id',
  false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT public.v4_accept_organization_membership(
  current_setting('v4.org_b')::uuid,
  current_setting('v4.member_global_admin_sales_b')::uuid,
  'sam78-accept-global-admin-as-sales-b'
);

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000013';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
SELECT set_config(
  'v4.member_global_sales_admin_b',
  public.v4_invite_organization_member(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000019',
    'org_admin',
    'sam78-invite-global-sales-as-admin-b'
  ) ->> 'membership_id', false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000019';
SELECT public.v4_accept_organization_membership(
  current_setting('v4.org_b')::uuid,
  current_setting('v4.member_global_sales_admin_b')::uuid,
  'sam78-accept-global-sales-as-admin-b'
);

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT set_config(
  'v4.member_sales_a',
  public.v4_invite_organization_member(
    current_setting('v4.org_a')::uuid,
    '78000000-0000-4000-8000-000000000018',
    'sales_agent',
    'sam78-invite-sales-a'
  ) ->> 'membership_id',
  false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000018';
SELECT public.v4_accept_organization_membership(
  current_setting('v4.org_a')::uuid,
  current_setting('v4.member_sales_a')::uuid,
  'sam78-accept-sales-a'
);

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000012';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
DO $$
BEGIN
  IF NOT public.v4_actor_has_capability(
    current_setting('v4.org_a')::uuid,
    '78000000-0000-4000-8000-000000000012',
    'leads.import', 'write'
  ) THEN
    RAISE EXCEPTION 'organization A capability selection failed';
  END IF;
END
$$;

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
INSERT INTO public.activity_logs(
  id, tenant_id, organization_id, user_id, action
) VALUES (
  '78000000-3019-4000-8000-000000000019',
  current_setting('v4.org_b')::uuid, current_setting('v4.org_b')::uuid,
  '78000000-0000-4000-8000-000000000019', 'immutable_activity_seed'
);
INSERT INTO public.audit_logs(
  id, organization_id, actor_id, action
) VALUES (
  '78000000-3119-4000-8000-000000000019',
  current_setting('v4.org_b')::uuid,
  '78000000-0000-4000-8000-000000000019', 'immutable_audit_seed'
);
INSERT INTO public.user_session_daily(
  id, tenant_id, organization_id, user_id
) VALUES (
  '78000000-3219-4000-8000-000000000019',
  current_setting('v4.org_b')::uuid, current_setting('v4.org_b')::uuid,
  '78000000-0000-4000-8000-000000000019'
);
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000019';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.activity_logs(tenant_id, organization_id, user_id, action)
    VALUES (
      current_setting('v4.org_b')::uuid, current_setting('v4.org_b')::uuid,
      '78000000-0000-4000-8000-000000000019', 'forged_activity'
    );
    RAISE EXCEPTION 'authenticated organization admin inserted activity evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.activity_logs SET action = 'forged_update'
    WHERE id = '78000000-3019-4000-8000-000000000019';
    RAISE EXCEPTION 'authenticated organization admin updated activity evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.activity_logs
    WHERE id = '78000000-3019-4000-8000-000000000019';
    RAISE EXCEPTION 'authenticated organization admin deleted activity evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.audit_logs(organization_id, actor_id, action)
    VALUES (
      current_setting('v4.org_b')::uuid,
      '78000000-0000-4000-8000-000000000019', 'forged_audit'
    );
    RAISE EXCEPTION 'authenticated organization admin inserted audit evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.audit_logs SET action = 'forged_update'
    WHERE id = '78000000-3119-4000-8000-000000000019';
    RAISE EXCEPTION 'authenticated organization admin updated audit evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.audit_logs
    WHERE id = '78000000-3119-4000-8000-000000000019';
    RAISE EXCEPTION 'authenticated organization admin deleted audit evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.user_session_daily(
      tenant_id, organization_id, user_id
    ) VALUES (
      current_setting('v4.org_b')::uuid, current_setting('v4.org_b')::uuid,
      '78000000-0000-4000-8000-000000000019'
    );
    RAISE EXCEPTION 'authenticated organization admin inserted session evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.user_session_daily SET actions_count = 999
    WHERE id = '78000000-3219-4000-8000-000000000019';
    RAISE EXCEPTION 'authenticated organization admin updated session evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.user_session_daily
    WHERE id = '78000000-3219-4000-8000-000000000019';
    RAISE EXCEPTION 'authenticated organization admin deleted session evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;
RESET request.jwt.claim.sub;
RESET request.headers;
INSERT INTO auth.users(id) VALUES ('78000000-0026-4000-8000-000000000026');
INSERT INTO public.profiles(id, email, role, is_active) VALUES (
  '78000000-0026-4000-8000-000000000026',
  'sam26-1785832451012-e811cec8-admin@example.test',
  'admin', true
);
INSERT INTO public.organizations(
  id, slug, name, industry_key, plan_key, status,
  data_region, timezone, billable_seat_limit
) VALUES (
  '78000000-2026-4000-8000-000000000026',
  'sam26-1785832451012-e811cec8', 'SAM-26 audit cleanup fixture',
  'real_estate', 'starter', 'active', 'UAE', 'Asia/Dubai', 6
);
INSERT INTO public.audit_logs(
  id, organization_id, actor_id, action, details
) VALUES (
  '78000000-2126-4000-8000-000000000026',
  '78000000-2026-4000-8000-000000000026',
  '78000000-0026-4000-8000-000000000026',
  'PAGE_VISIT',
  '{"page":"/dashboard","fixture_scope":"sam26-staging-uat","fixture_run_id":"1785832451012-e811cec8"}'::jsonb
);
SET ROLE service_role;
DELETE FROM public.audit_logs
WHERE id = '78000000-2126-4000-8000-000000000026';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.audit_logs
    WHERE id = '78000000-2126-4000-8000-000000000026'
  ) THEN RAISE EXCEPTION 'SAM-26 exact synthetic audit cleanup was rejected'; END IF;
END
$$;
INSERT INTO public.audit_logs(
  id, organization_id, actor_id, action, details
) VALUES (
  '78000000-2226-4000-8000-000000000026',
  '78000000-2026-4000-8000-000000000026',
  '78000000-0026-4000-8000-000000000026',
  'PAGE_VISIT', '{"page":"/dashboard"}'::jsonb
);
DO $$
BEGIN
  BEGIN
    DELETE FROM public.audit_logs
    WHERE id = '78000000-2226-4000-8000-000000000026';
    RAISE EXCEPTION 'unmarked service-role audit deletion accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'immutable_record' THEN RAISE; END IF;
  END;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.activity_logs
    WHERE id = '78000000-3019-4000-8000-000000000019'
      AND action = 'immutable_activity_seed'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.audit_logs
    WHERE id = '78000000-3119-4000-8000-000000000019'
      AND action = 'immutable_audit_seed'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.user_session_daily
    WHERE id = '78000000-3219-4000-8000-000000000019'
  ) THEN RAISE EXCEPTION 'immutable evidence row changed after browser writes'; END IF;
END
$$;
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
DO $$
BEGIN
  IF public.v4_actor_has_capability(
    current_setting('v4.org_a')::uuid,
    '78000000-0000-4000-8000-000000000012',
    'leads.import', 'write'
  ) OR public.v4_actor_has_capability(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000012',
    'leads.write', 'write'
  ) THEN
    RAISE EXCEPTION 'selected organization or specialist capability boundary failed';
  END IF;
END
$$;

SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT set_config(
  'v4.lead_a',
  (public.v4_import_leads_for_organization(
    current_setting('v4.org_a')::uuid,
    jsonb_build_array(jsonb_build_object(
      'customer_name', 'SAM-78 Tenant A Lead',
      'source', 'offline',
      'quality', 'pending',
      'lead_status', 'pending',
      'notes', 'Authorized organization A import',
      'import_fingerprint', repeat('a', 64)
    )),
    '78000000-1012-4000-8000-000000000012',
    'sam78-import-org-a'
  ) -> 'imported_ids' ->> 0),
  false
);

DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.leads
  WHERE id = current_setting('v4.lead_a')::uuid
    AND customer_name ILIKE '%Tenant A%';
  IF visible_count <> 1 THEN RAISE EXCEPTION 'authorized lead search failed'; END IF;
END
$$;

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
INSERT INTO public.leads(
  id, organization_id, customer_name, source, stage, quality, lead_status
) VALUES (
  '78000000-1013-4000-8000-000000000013',
  current_setting('v4.org_b')::uuid,
  'SAM-78 Tenant B Protected Lead', 'offline', 'new', 'pending', 'pending'
);
INSERT INTO public.contracts(
  id, organization_id, lead_id, contract_no, contract_amount,
  party_a_name, party_b_name, sales_id
) VALUES (
  '78000000-2013-4000-8000-000000000013',
  current_setting('v4.org_b')::uuid,
  '78000000-1013-4000-8000-000000000013',
  'SAM78-CONTRACT-B', 2000, 'Tenant B', 'NewMe',
  '78000000-0000-4000-8000-000000000013'
);
INSERT INTO public.installment_plans(
  id, organization_id, contract_id, seq, amount, due_date, status
) VALUES (
  '78000000-2113-4000-8000-000000000013',
  current_setting('v4.org_b')::uuid,
  '78000000-2013-4000-8000-000000000013',
  1, 2000, current_date + 30, 'pending'
);
INSERT INTO public.payments(
  id, organization_id, contract_id, created_by, amount,
  payment_date, confirmed
) VALUES (
  '78000000-2213-4000-8000-000000000013',
  current_setting('v4.org_b')::uuid,
  '78000000-2013-4000-8000-000000000013',
  '78000000-0000-4000-8000-000000000013',
  500, current_date, false
);
INSERT INTO public.leads(
  id, organization_id, customer_name, source, stage, quality, lead_status,
  assigned_to, created_by
) VALUES (
  '78000000-1011-4000-8000-000000000011',
  current_setting('v4.org_b')::uuid,
  'SAM-78 Tenant B Sales-Owned Lead', 'offline', 'new', 'pending', 'pending',
  '78000000-0000-4000-8000-000000000011',
  '78000000-0000-4000-8000-000000000011'
);
INSERT INTO public.contracts(
  id, organization_id, lead_id, contract_no, contract_amount,
  party_a_name, party_b_name, sales_id, created_by
) VALUES (
  '78000000-2011-4000-8000-000000000011',
  current_setting('v4.org_b')::uuid,
  '78000000-1011-4000-8000-000000000011',
  'SAM78-CONTRACT-B-OWN', 1000, 'Tenant B Own', 'NewMe',
  '78000000-0000-4000-8000-000000000011',
  '78000000-0000-4000-8000-000000000011'
);
INSERT INTO public.payments(
  id, organization_id, contract_id, created_by, amount, payment_date, confirmed
) VALUES (
  '78000000-2211-4000-8000-000000000011',
  current_setting('v4.org_b')::uuid,
  '78000000-2011-4000-8000-000000000011',
  '78000000-0000-4000-8000-000000000011', 100, current_date, false
);

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
DO $$
DECLARE affected_count integer; visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.leads
  WHERE id IN (
    '78000000-1013-4000-8000-000000000013',
    '78000000-1011-4000-8000-000000000011'
  );
  IF visible_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.leads
    WHERE id = '78000000-1011-4000-8000-000000000011'
  ) THEN RAISE EXCEPTION 'organization sales owner/self lead policy changed'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.contracts
    WHERE id = '78000000-2013-4000-8000-000000000013'
  ) OR EXISTS (
    SELECT 1 FROM public.payments
    WHERE id = '78000000-2213-4000-8000-000000000013'
  ) THEN RAISE EXCEPTION 'global admin leaked another salesperson commercial rows'; END IF;
  IF public.v4_actor_has_capability(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000011',
    'payments.confirm', 'write'
  ) OR public.v4_actor_has_capability(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000011',
    'payments.allocate', 'write'
  ) OR public.v4_actor_has_capability(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000011',
    'kpi.targets.manage', 'write'
  ) OR public.v4_actor_has_capability(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000011',
    'contracts.write_any', 'write'
  ) THEN
    RAISE EXCEPTION 'global or organization A authority leaked into B capabilities';
  END IF;
  BEGIN
    PERFORM public.v4_confirm_payment_for_organization(
      current_setting('v4.org_b')::uuid,
      '78000000-2213-4000-8000-000000000013',
      'sam78-global-admin-b-confirm-denied'
    );
    RAISE EXCEPTION 'B sales role confirmed payment through global admin role';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'payment_confirm_capability_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.v4_allocate_payment_for_organization(
      current_setting('v4.org_b')::uuid,
      '78000000-2213-4000-8000-000000000013',
      jsonb_build_array(jsonb_build_object(
        'plan_id', '78000000-2113-4000-8000-000000000013', 'amount', 500
      )),
      'sam78-global-admin-b-allocate-denied'
    );
    RAISE EXCEPTION 'B sales role allocated payment through global admin role';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'payment_allocate_capability_required' THEN RAISE; END IF;
  END;
  UPDATE public.payments SET confirmed = true
  WHERE id = '78000000-2213-4000-8000-000000000013';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 0 THEN
    RAISE EXCEPTION 'B sales role directly confirmed payment through global admin role';
  END IF;
  UPDATE public.contracts SET party_a_name = 'forged by global admin'
  WHERE id = '78000000-2013-4000-8000-000000000013';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 0 THEN
    RAISE EXCEPTION 'B sales role updated another sales contract through global admin role';
  END IF;
  BEGIN
    PERFORM public.v4_replace_kpi_targets(
      current_setting('v4.org_b')::uuid, '2026-08',
      jsonb_build_array(jsonb_build_object(
        'target_type', 'signing', 'target_amount', 1,
        'assigned_to', NULL, 'notes', 'must be denied'
      )),
      'sam78-global-admin-b-kpi-denied'
    );
    RAISE EXCEPTION 'B sales role replaced KPI through global admin role';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'kpi_targets_manage_capability_required' THEN RAISE; END IF;
  END;
END
$$;

RESET ROLE;
RESET request.jwt.claim.sub;
RESET request.headers;
-- Fixture setup is intentionally performed by the disposable database owner;
-- authenticated and service_role both lack direct profile mutation rights.
UPDATE public.profiles SET role = 'designer'
WHERE id = '78000000-0000-4000-8000-000000000019';
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000019';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.leads
    WHERE id = '78000000-1013-4000-8000-000000000013'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.contracts
    WHERE id = '78000000-2013-4000-8000-000000000013'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.payments
    WHERE id = '78000000-2213-4000-8000-000000000013'
  ) THEN RAISE EXCEPTION 'organization admin remained dependent on global profile role'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename IN (
        'membership_roles', 'activities', 'activity_logs', 'ad_spend',
        'audit_logs', 'business_events', 'chat_messages', 'customers',
        'follow_up_logs', 'knx_designs', 'kpi_targets',
        'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
        'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
        'notifications', 'quotes', 'transfer_history', 'user_session_daily',
        'leads', 'contracts', 'payments'
      )
      AND (
        COALESCE(policy.qual, '') ILIKE '%profiles%role%'
        OR COALESCE(policy.with_check, '') ILIKE '%profiles%role%'
        OR COALESCE(policy.qual, '') ILIKE '%get_my_role%'
        OR COALESCE(policy.with_check, '') ILIKE '%get_my_role%'
      )
  ) THEN RAISE EXCEPTION 'V4 policy coverage retained profiles.role dependency'; END IF;
END
$$;

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT public.v4_replace_kpi_targets(
  current_setting('v4.org_a')::uuid, '2026-08',
  jsonb_build_array(jsonb_build_object(
    'target_type', 'signing', 'target_amount', 10,
    'assigned_to', NULL, 'notes', 'organization A atomic baseline'
  )),
  'sam78-kpi-org-a-baseline'
);
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
INSERT INTO public.kpi_targets(
  organization_id, period, target_type, target_amount, assigned_to, set_by
) VALUES (
  current_setting('v4.org_b')::uuid, '2026-08', 'signing', 20,
  NULL, '78000000-0000-4000-8000-000000000013'
);
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_replace_kpi_targets(
      current_setting('v4.org_a')::uuid, '2026-08',
      jsonb_build_array(
        jsonb_build_object(
          'target_type', 'collection', 'target_amount', 30,
          'assigned_to', NULL,
          'notes', 'duplicate team-wide one'
        ),
        jsonb_build_object(
          'target_type', 'collection', 'target_amount', 40,
          'assigned_to', NULL,
          'notes', 'duplicate team-wide two'
        )
      ),
      'sam78-kpi-atomic-failure'
    );
    RAISE EXCEPTION 'KPI replacement accepted duplicate team-wide target';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$$;
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
DO $$
BEGIN
  IF (
    SELECT count(*) FROM public.kpi_targets
    WHERE organization_id = current_setting('v4.org_a')::uuid
      AND period = '2026-08' AND target_type = 'signing'
      AND target_amount = 10
  ) <> 1 THEN
    RAISE EXCEPTION 'failed NULL-assignee KPI replacement deleted organization A baseline';
  END IF;
  IF (
    SELECT count(*) FROM public.kpi_targets
    WHERE organization_id = current_setting('v4.org_b')::uuid
      AND period = '2026-08' AND target_amount = 20
  ) <> 1 THEN
    RAISE EXCEPTION 'organization A KPI replacement changed organization B';
  END IF;
END
$$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000012';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
DO $$
DECLARE
  visible_count integer;
  affected_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.leads
  WHERE id = current_setting('v4.lead_a')::uuid
     OR customer_name ILIKE '%Tenant A%';
  IF visible_count <> 0 THEN RAISE EXCEPTION 'cross-organization direct-id/search leak'; END IF;
  BEGIN
    INSERT INTO public.leads(
      id, organization_id, customer_name, source, stage, quality, lead_status
    ) VALUES (
      '78000000-1014-4000-8000-000000000014',
      current_setting('v4.org_b')::uuid,
      'specialist direct insert', 'offline', 'new', 'pending', 'pending'
    );
    RAISE EXCEPTION 'specialist direct lead insert accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.leads SET customer_name = 'specialist direct update'
  WHERE id = '78000000-1013-4000-8000-000000000013';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 0 THEN RAISE EXCEPTION 'specialist direct lead update accepted'; END IF;
  DELETE FROM public.leads
  WHERE id = '78000000-1013-4000-8000-000000000013';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 0 THEN RAISE EXCEPTION 'specialist direct lead delete accepted'; END IF;
  BEGIN
    INSERT INTO public.follow_up_logs(
      organization_id, lead_id, contact_time, summary
    ) VALUES (
      current_setting('v4.org_b')::uuid,
      current_setting('v4.lead_a')::uuid,
      now(), 'cross-organization child write'
    );
    RAISE EXCEPTION 'cross-organization child write accepted';
  EXCEPTION
    WHEN check_violation OR foreign_key_violation OR insufficient_privilege THEN NULL;
  END;
END
$$;

SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    UPDATE public.leads
    SET organization_id = current_setting('v4.org_b')::uuid
    WHERE id = current_setting('v4.lead_a')::uuid;
    RAISE EXCEPTION 'lead organization reassignment accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'tenant_organization_id_immutable' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.leads
    WHERE id = current_setting('v4.lead_a')::uuid
      AND organization_id = current_setting('v4.org_a')::uuid
  ) THEN RAISE EXCEPTION 'lead organization changed after rejected reassignment'; END IF;
END
$$;

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
INSERT INTO public.contracts(
  id, organization_id, lead_id, contract_no, contract_amount,
  party_a_name, party_b_name, sales_id
) VALUES (
  '78000000-2012-4000-8000-000000000012',
  current_setting('v4.org_a')::uuid,
  current_setting('v4.lead_a')::uuid,
  'SAM78-CONTRACT-A', 1000, 'Tenant A', 'NewMe',
  '78000000-0000-4000-8000-000000000018'
);

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000018';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT set_config(
  'v4.file_id',
  public.v4_register_tenant_file(
    current_setting('v4.org_a')::uuid, 'contract',
    '78000000-2012-4000-8000-000000000012', 'contract.pdf', 'draft',
    'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
    'sam78-storage-register-a'
  ) ->> 'id',
  false
);
SELECT set_config(
  'v4.file_key',
  public.v4_register_tenant_file(
    current_setting('v4.org_a')::uuid, 'contract',
    '78000000-2012-4000-8000-000000000012', 'contract.pdf', 'draft',
    'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
    'sam78-storage-register-a'
  ) ->> 'key',
  false
);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.tenant_file_objects(
      organization_id, record_type, record_id, object_key, original_filename,
      version, content_type, expected_size_bytes, expected_content_md5,
      created_by, request_id
    ) VALUES (
      current_setting('v4.org_a')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012',
      'organizations/' || current_setting('v4.org_a') || '/forged.pdf',
      'forged.pdf', 'draft', 'application/pdf', 0,
      '1B2M2Y8AsgTpgAmY7PhCfg==',
      '78000000-0000-4000-8000-000000000018', 'sam78-forged-direct-insert'
    );
    RAISE EXCEPTION 'authenticated registry insert accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.tenant_file_objects SET status = 'available'
    WHERE id = current_setting('v4.file_id')::uuid;
    RAISE EXCEPTION 'authenticated registry update accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.v4_finalize_tenant_file(
      current_setting('v4.org_a')::uuid,
      current_setting('v4.file_id')::uuid,
      0, 'application/pdf', '1B2M2Y8AsgTpgAmY7PhCfg==',
      '"d41d8cd98f00b204e9800998ecf8427e"', NULL,
      '78000000-0000-4000-8000-000000000018',
      'sam78-browser-finalize-denied'
    );
    RAISE EXCEPTION 'authenticated finalize RPC accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000012';
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_a')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012', 'ops-sealed.pdf', 'sealed',
      'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
      'sam78-storage-ops-sealed-denied'
    );
    RAISE EXCEPTION 'operations sealed contract registration accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sealed_contract_admin_required' THEN RAISE; END IF;
  END;
END
$$;

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000018';
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_a')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012', 'sales-sealed.pdf', 'sealed',
      'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
      'sam78-storage-sales-sealed-denied'
    );
    RAISE EXCEPTION 'sales sealed contract registration accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sealed_contract_admin_required' THEN RAISE; END IF;
  END;
END
$$;

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'v4.sealed_file_id',
  public.v4_register_tenant_file(
    current_setting('v4.org_a')::uuid, 'contract',
    '78000000-2012-4000-8000-000000000012', 'owner-sealed.pdf', 'sealed',
    'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
    'sam78-storage-owner-sealed'
  ) ->> 'id',
  false
);

SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_b')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012', 'cross.pdf', 'draft',
      'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
      'sam78-storage-cross-org'
    );
    RAISE EXCEPTION 'cross-organization storage registration accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT IN ('storage_write_capability_required', 'storage_record_not_found') THEN
      RAISE;
    END IF;
  END;
END
$$;

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
INSERT INTO public.tenant_file_objects(
  id, organization_id, record_type, record_id, object_key, original_filename,
  version, status, content_type, expected_size_bytes, expected_content_md5,
  created_by, request_id
)
SELECT gen_random_uuid(), current_setting('v4.org_a')::uuid, 'contract',
  '78000000-2012-4000-8000-000000000012',
  'organizations/' || current_setting('v4.org_a') || '/contracts/quota-actor-count-'
    || offset_value || '.pdf',
  'quota-actor-count-' || offset_value || '.pdf', 'draft', 'pending',
  'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
  '78000000-0000-4000-8000-000000000011',
  'sam78-quota-actor-count-' || offset_value
FROM generate_series(1, 19) offset_value;
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_a')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012', 'actor-count-overflow.pdf', 'draft',
      'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
      'sam78-quota-actor-count-overflow'
    );
    RAISE EXCEPTION 'actor pending count quota accepted overflow';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_pending_actor_quota_exceeded' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
DELETE FROM public.tenant_file_objects
WHERE request_id LIKE 'sam78-quota-actor-count-%';

INSERT INTO public.tenant_file_objects(
  id, organization_id, record_type, record_id, object_key, original_filename,
  version, status, content_type, expected_size_bytes, expected_content_md5,
  created_by, request_id
) VALUES (
  gen_random_uuid(), current_setting('v4.org_a')::uuid, 'contract',
  '78000000-2012-4000-8000-000000000012',
  'organizations/' || current_setting('v4.org_a') || '/contracts/quota-actor-bytes.pdf',
  'quota-actor-bytes.pdf', 'draft', 'pending', 'application/pdf', 1073741824,
  '1B2M2Y8AsgTpgAmY7PhCfg==', '78000000-0000-4000-8000-000000000011',
  'sam78-quota-actor-bytes-seed'
);
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_a')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012', 'actor-bytes-overflow.pdf', 'draft',
      'application/pdf', 1, '1B2M2Y8AsgTpgAmY7PhCfg==',
      'sam78-quota-actor-bytes-overflow'
    );
    RAISE EXCEPTION 'actor pending bytes quota accepted overflow';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_pending_actor_quota_exceeded' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
DELETE FROM public.tenant_file_objects
WHERE request_id LIKE 'sam78-quota-actor-bytes-%';

INSERT INTO public.tenant_file_objects(
  id, organization_id, record_type, record_id, object_key, original_filename,
  version, status, content_type, expected_size_bytes, expected_content_md5,
  created_by, request_id
)
SELECT gen_random_uuid(), current_setting('v4.org_a')::uuid, 'contract',
  '78000000-2012-4000-8000-000000000012',
  'organizations/' || current_setting('v4.org_a') || '/contracts/quota-org-count-'
    || offset_value || '.pdf',
  'quota-org-count-' || offset_value || '.pdf', 'draft', 'pending',
  'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
  '78000000-0000-4000-8000-000000000012',
  'sam78-quota-org-count-' || offset_value
FROM generate_series(1, 98) offset_value;
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_a')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012', 'org-count-overflow.pdf', 'draft',
      'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
      'sam78-quota-org-count-overflow'
    );
    RAISE EXCEPTION 'organization pending count quota accepted overflow';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_pending_organization_quota_exceeded' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
DELETE FROM public.tenant_file_objects
WHERE request_id LIKE 'sam78-quota-org-count-%';

INSERT INTO public.tenant_file_objects(
  id, organization_id, record_type, record_id, object_key, original_filename,
  version, status, content_type, expected_size_bytes, expected_content_md5,
  created_by, request_id
)
SELECT gen_random_uuid(), current_setting('v4.org_a')::uuid, 'contract',
  '78000000-2012-4000-8000-000000000012',
  'organizations/' || current_setting('v4.org_a') || '/contracts/quota-org-bytes-'
    || offset_value || '.pdf',
  'quota-org-bytes-' || offset_value || '.pdf', 'draft', 'pending',
  'application/pdf', 1073741824, '1B2M2Y8AsgTpgAmY7PhCfg==',
  '78000000-0000-4000-8000-000000000012',
  'sam78-quota-org-bytes-' || offset_value
FROM generate_series(1, 5) offset_value;
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_a')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012', 'org-bytes-overflow.pdf', 'draft',
      'application/pdf', 1, '1B2M2Y8AsgTpgAmY7PhCfg==',
      'sam78-quota-org-bytes-overflow'
    );
    RAISE EXCEPTION 'organization pending bytes quota accepted overflow';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_pending_organization_quota_exceeded' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
DELETE FROM public.tenant_file_objects
WHERE request_id LIKE 'sam78-quota-org-bytes-%';

-- Expired uploads stay quota-bearing until the durable COS deletion outbox
-- records provider absence. A failed delete is retryable and organization-bound.
INSERT INTO public.tenant_file_objects(
  id, organization_id, record_type, record_id, object_key, original_filename,
  version, status, content_type, expected_size_bytes, expected_content_md5,
  created_by, request_id, created_at, pending_expires_at, upload_url_expires_at
)
SELECT gen_random_uuid(), current_setting('v4.org_a')::uuid, 'contract',
  '78000000-2012-4000-8000-000000000012',
  'organizations/' || current_setting('v4.org_a') || '/contracts/recovery-expired-'
    || offset_value || '.pdf',
  'recovery-expired-' || offset_value || '.pdf', 'draft', 'pending',
  'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
  '78000000-0000-4000-8000-000000000011',
  'sam78-recovery-expired-a-' || offset_value, now() - interval '1 hour',
  now() - interval '1 minute', now() - interval '20 minutes'
FROM generate_series(1, 19) offset_value;
INSERT INTO public.tenant_file_objects(
  id, organization_id, record_type, record_id, object_key, original_filename,
  version, status, content_type, expected_size_bytes, expected_content_md5,
  created_by, request_id, created_at, pending_expires_at, upload_url_expires_at
) VALUES (
  '78000000-2313-4000-8000-000000000013',
  current_setting('v4.org_b')::uuid, 'contract',
  '78000000-2013-4000-8000-000000000013',
  'organizations/' || current_setting('v4.org_b') || '/contracts/recovery-expired-b.pdf',
  'recovery-expired-b.pdf', 'draft', 'pending', 'application/pdf', 0,
  '1B2M2Y8AsgTpgAmY7PhCfg==', '78000000-0000-4000-8000-000000000011',
  'sam78-recovery-expired-b', now() - interval '1 hour',
  now() - interval '1 minute', now() - interval '20 minutes'
);
SELECT public.v4_expire_tenant_file_uploads(
  current_setting('v4.org_a')::uuid, 10, 'sam78-expire-before-delete-org-a-1'
);
SELECT public.v4_expire_tenant_file_uploads(
  current_setting('v4.org_a')::uuid, 10, 'sam78-expire-before-delete-org-a-2'
);
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_a')::uuid,
      'contract', '78000000-2012-4000-8000-000000000012',
      'quota-not-released-before-delete.pdf', 'draft', 'application/pdf', 0,
      '1B2M2Y8AsgTpgAmY7PhCfg==', 'sam78-quota-before-provider-delete'
    );
    RAISE EXCEPTION 'expired upload released quota before provider deletion';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_pending_actor_quota_exceeded' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.v4_claim_tenant_file_deletions(10, 'authenticated-worker', 60);
    RAISE EXCEPTION 'authenticated actor claimed deletion outbox';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
SELECT public.v4_claim_tenant_file_deletions(10, 'sam78-delete-worker-a', 60);
SELECT public.v4_claim_tenant_file_deletions(10, 'sam78-delete-worker-b', 60);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.tenant_file_deletion_outbox
      WHERE lease_owner = 'sam78-delete-worker-a') <> 10
    OR (SELECT count(*) FROM public.tenant_file_deletion_outbox
      WHERE lease_owner = 'sam78-delete-worker-b') <> 9
  THEN RAISE EXCEPTION 'bounded deletion claims overlapped or exceeded ten'; END IF;
END
$$;
SELECT set_config(
  'v4.retry_queue_id',
  (SELECT id::text FROM public.tenant_file_deletion_outbox
    WHERE organization_id = current_setting('v4.org_a')::uuid
      AND lease_owner = 'sam78-delete-worker-a'
    ORDER BY id LIMIT 1), false
);
SELECT set_config(
  'v4.retry_file_id',
  (SELECT file_id::text FROM public.tenant_file_deletion_outbox
    WHERE id = current_setting('v4.retry_queue_id')::uuid), false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_complete_tenant_file_deletion(
      current_setting('v4.org_b')::uuid,
      current_setting('v4.retry_queue_id')::uuid,
      current_setting('v4.retry_file_id')::uuid,
      'sam78-delete-worker-a', 'cos_delete_204_head_404',
      'sam78-cross-org-delete-complete'
    );
    RAISE EXCEPTION 'cross-organization deletion completion accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_deletion_not_found' THEN RAISE; END IF;
  END;
END
$$;
SELECT public.v4_retry_tenant_file_deletion(
  current_setting('v4.retry_queue_id')::uuid,
  'sam78-delete-worker-a', 'cos_delete_failed', 'sam78-delete-retry-a'
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_file_deletion_outbox deletion
    JOIN public.tenant_file_objects file_object ON file_object.id = deletion.file_id
    WHERE deletion.id = current_setting('v4.retry_queue_id')::uuid
      AND deletion.status = 'pending' AND deletion.attempt_count = 1
      AND file_object.status = 'deletion_pending'
  ) THEN RAISE EXCEPTION 'failed deletion was not retained for retry'; END IF;
END
$$;
SELECT set_config(
  'v4.recovery_queue_id',
  (SELECT id::text FROM public.tenant_file_deletion_outbox
    WHERE lease_owner = 'sam78-delete-worker-a'
    ORDER BY id LIMIT 1), false
);
UPDATE public.tenant_file_deletion_outbox
SET lease_expires_at = now() - interval '1 second'
WHERE id = current_setting('v4.recovery_queue_id')::uuid;
SELECT public.v4_claim_tenant_file_deletions(1, 'sam78-lease-recovery', 60);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_file_deletion_outbox
    WHERE id = current_setting('v4.recovery_queue_id')::uuid
      AND lease_owner = 'sam78-lease-recovery' AND attempt_count = 2
  ) THEN RAISE EXCEPTION 'expired deletion lease was not safely recovered'; END IF;
END
$$;
UPDATE public.tenant_file_deletion_outbox
SET next_attempt_at = now() - interval '1 second'
WHERE id = current_setting('v4.retry_queue_id')::uuid;
SELECT public.v4_claim_tenant_file_deletions(1, 'sam78-delete-retry', 60);
DO $$
DECLARE deletion record; completed jsonb;
BEGIN
  FOR deletion IN
    SELECT * FROM public.tenant_file_deletion_outbox
    WHERE organization_id = current_setting('v4.org_a')::uuid
      AND status = 'leased'
  LOOP
    completed := public.v4_complete_tenant_file_deletion(
      deletion.organization_id, deletion.id, deletion.file_id,
      deletion.lease_owner, 'cos_delete_204_head_404',
      'sam78-delete-complete-' || deletion.id::text
    );
  END LOOP;
  completed := public.v4_complete_tenant_file_deletion(
    current_setting('v4.org_a')::uuid,
    current_setting('v4.retry_queue_id')::uuid,
    current_setting('v4.retry_file_id')::uuid,
    'idempotent-replay', 'cos_delete_404_head_404',
    'sam78-delete-complete-idempotent'
  );
  IF completed ->> 'idempotent' <> 'true' THEN
    RAISE EXCEPTION 'provider deletion completion was not idempotent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tenant_file_objects
    WHERE request_id LIKE 'sam78-recovery-expired-a-%' AND status <> 'expired'
  ) OR EXISTS (
    SELECT 1 FROM public.tenant_file_objects
    WHERE id = '78000000-2313-4000-8000-000000000013' AND status <> 'pending'
  ) THEN RAISE EXCEPTION 'deletion worker crossed organization or skipped terminal state'; END IF;
END
$$;
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT set_config(
  'v4.recovered_file_id',
  public.v4_register_tenant_file(
    current_setting('v4.org_a')::uuid, 'contract',
    '78000000-2012-4000-8000-000000000012', 'recovered-after-delete.pdf', 'draft',
    'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
    'sam78-recovered-after-delete'
  ) ->> 'id', false
);
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_b'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_cancel_tenant_file_upload(
      current_setting('v4.org_a')::uuid,
      current_setting('v4.recovered_file_id')::uuid,
      'cross organization cancellation attempt',
      'sam78-cross-org-cancel-denied'
    );
    RAISE EXCEPTION 'cross-organization pending upload cancellation accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_write_capability_required' THEN RAISE; END IF;
  END;
END
$$;
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT public.v4_cancel_tenant_file_upload(
  current_setting('v4.org_a')::uuid,
  current_setting('v4.recovered_file_id')::uuid,
  'client compensated failed provider upload',
  'sam78-recovered-file-cancelled'
);

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_file_deletion_outbox deletion
    JOIN public.tenant_file_objects file_object ON file_object.id = deletion.file_id
    WHERE deletion.file_id = current_setting('v4.recovered_file_id')::uuid
      AND deletion.provider_delete_not_before
        >= file_object.upload_url_expires_at + interval '2 minutes'
      AND file_object.status = 'deletion_pending'
  ) THEN RAISE EXCEPTION 'cancel deletion was not delayed beyond signed PUT expiry'; END IF;
END
$$;
UPDATE public.tenant_file_objects
SET created_at = now() - interval '4 minutes',
  upload_url_expires_at = now() - interval '3 minutes'
WHERE id = current_setting('v4.recovered_file_id')::uuid;
UPDATE public.tenant_file_deletion_outbox
SET provider_delete_not_before = now() - interval '1 minute'
WHERE file_id = current_setting('v4.recovered_file_id')::uuid;
SELECT public.v4_claim_tenant_file_deletions(1, 'sam78-cancel-worker', 60);
DO $$
DECLARE deletion record;
BEGIN
  SELECT * INTO deletion FROM public.tenant_file_deletion_outbox
  WHERE file_id = current_setting('v4.recovered_file_id')::uuid;
  PERFORM public.v4_complete_tenant_file_deletion(
    deletion.organization_id, deletion.id, deletion.file_id,
    'sam78-cancel-worker', 'cos_delete_404_head_404',
    'sam78-cancel-delete-complete'
  );
END
$$;
INSERT INTO public.tenant_file_objects(
  id, organization_id, record_type, record_id, object_key, original_filename,
  version, status, content_type, expected_size_bytes, expected_content_md5,
  created_by, request_id
)
SELECT gen_random_uuid(), current_setting('v4.org_a')::uuid, 'contract',
  '78000000-2012-4000-8000-000000000012',
  'organizations/' || current_setting('v4.org_a') || '/contracts/recovery-active-'
    || offset_value || '.pdf',
  'recovery-active-' || offset_value || '.pdf', 'draft', 'pending',
  'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
  '78000000-0000-4000-8000-000000000011',
  'sam78-recovery-active-' || offset_value
FROM generate_series(1, 18) offset_value;
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT set_config(
  'v4.cancel_quota_file_id',
  public.v4_register_tenant_file(
    current_setting('v4.org_a')::uuid, 'contract',
    '78000000-2012-4000-8000-000000000012', 'cancel-quota.pdf', 'draft',
    'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
    'sam78-cancel-quota-seed'
  ) ->> 'id',
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_a')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012', 'cancel-quota-blocked.pdf', 'draft',
      'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
      'sam78-cancel-quota-blocked'
    );
    RAISE EXCEPTION 'pending quota overflow before cancellation accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_pending_actor_quota_exceeded' THEN RAISE; END IF;
  END;
END
$$;
SELECT public.v4_cancel_tenant_file_upload(
  current_setting('v4.org_a')::uuid,
  current_setting('v4.cancel_quota_file_id')::uuid,
  'release pending quota after provider failure',
  'sam78-cancel-quota-release'
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_register_tenant_file(
      current_setting('v4.org_a')::uuid, 'contract',
      '78000000-2012-4000-8000-000000000012',
      'cancel-quota-still-blocked.pdf', 'draft', 'application/pdf', 0,
      '1B2M2Y8AsgTpgAmY7PhCfg==', 'sam78-cancel-quota-still-blocked'
    );
    RAISE EXCEPTION 'cancelled upload released quota before object absence';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_pending_actor_quota_exceeded' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
UPDATE public.tenant_file_objects
SET created_at = now() - interval '4 minutes',
  upload_url_expires_at = now() - interval '3 minutes'
WHERE id = current_setting('v4.cancel_quota_file_id')::uuid;
UPDATE public.tenant_file_deletion_outbox
SET provider_delete_not_before = now() - interval '1 minute'
WHERE file_id = current_setting('v4.cancel_quota_file_id')::uuid;
SELECT public.v4_claim_tenant_file_deletions(1, 'sam78-quota-delete-worker', 60);
DO $$
DECLARE deletion record;
BEGIN
  SELECT * INTO deletion FROM public.tenant_file_deletion_outbox
  WHERE file_id = current_setting('v4.cancel_quota_file_id')::uuid;
  PERFORM public.v4_complete_tenant_file_deletion(
    deletion.organization_id, deletion.id, deletion.file_id,
    'sam78-quota-delete-worker', 'cos_delete_204_head_404',
    'sam78-quota-delete-complete'
  );
END
$$;
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000011';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT set_config(
  'v4.cancel_recovered_file_id',
  public.v4_register_tenant_file(
    current_setting('v4.org_a')::uuid, 'contract',
    '78000000-2012-4000-8000-000000000012', 'cancel-quota-recovered.pdf', 'draft',
    'application/pdf', 0, '1B2M2Y8AsgTpgAmY7PhCfg==',
    'sam78-cancel-quota-recovered'
  ) ->> 'id',
  false
);

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
INSERT INTO public.tenant_file_objects(
  id, organization_id, record_type, record_id, object_key, original_filename,
  version, status, content_type, expected_size_bytes, expected_content_md5,
  created_by, request_id, created_at, pending_expires_at, upload_url_expires_at
) VALUES (
  '78000000-2312-4000-8000-000000000012',
  current_setting('v4.org_a')::uuid, 'contract',
  '78000000-2012-4000-8000-000000000012',
  'organizations/' || current_setting('v4.org_a') || '/contracts/worker-expired-a.pdf',
  'worker-expired-a.pdf', 'draft', 'pending', 'application/pdf', 0,
  '1B2M2Y8AsgTpgAmY7PhCfg==', '78000000-0000-4000-8000-000000000011',
  'sam78-worker-expired-a', now() - interval '1 hour',
  now() - interval '1 minute', now() - interval '20 minutes'
);
SELECT public.v4_expire_tenant_file_uploads(
  current_setting('v4.org_a')::uuid, 10, 'sam78-worker-expire-org-a'
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_file_objects
    WHERE id = '78000000-2312-4000-8000-000000000012'
      AND status = 'deletion_pending'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.tenant_file_objects
    WHERE id = '78000000-2313-4000-8000-000000000013' AND status = 'pending'
  ) THEN RAISE EXCEPTION 'bounded expiry worker crossed organization boundary'; END IF;
END
$$;
SELECT public.v4_expire_tenant_file_uploads(
  current_setting('v4.org_b')::uuid, 10, 'sam78-worker-expire-org-b'
);
SELECT public.v4_claim_tenant_file_deletions(10, 'sam78-expiry-delete-worker', 60);
DO $$
DECLARE deletion record;
BEGIN
  FOR deletion IN
    SELECT * FROM public.tenant_file_deletion_outbox
    WHERE status = 'leased'
  LOOP
    PERFORM public.v4_complete_tenant_file_deletion(
      deletion.organization_id, deletion.id, deletion.file_id,
      'sam78-expiry-delete-worker', 'cos_delete_404_head_404',
      'sam78-expiry-delete-' || deletion.id::text
    );
  END LOOP;
END
$$;

-- Direct service writers remain compatible only when they carry the owning
-- organization explicitly; no request header is available in this worker role.
INSERT INTO public.notifications(
  organization_id, user_id, type, title, related_type
) VALUES
  (current_setting('v4.org_a')::uuid,
   '78000000-0000-4000-8000-000000000011', 'payment_overdue',
   'service writer org A', 'payment'),
  (current_setting('v4.org_b')::uuid,
   '78000000-0000-4000-8000-000000000013', 'payment_overdue',
   'service writer org B', 'payment');
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.notifications
    WHERE title = 'service writer org A'
      AND organization_id <> current_setting('v4.org_a')::uuid
  ) OR EXISTS (
    SELECT 1 FROM public.notifications
    WHERE title = 'service writer org B'
      AND organization_id <> current_setting('v4.org_b')::uuid
  ) THEN
    RAISE EXCEPTION 'service notification writer lost organization ownership';
  END IF;
END
$$;
DELETE FROM public.notifications WHERE title LIKE 'service writer org %';
DELETE FROM public.tenant_file_deletion_outbox
WHERE file_id IN (
  SELECT id FROM public.tenant_file_objects
  WHERE request_id LIKE 'sam78-recovery-%'
    OR request_id LIKE 'sam78-recovered-%'
    OR request_id LIKE 'sam78-cancel-%'
    OR request_id LIKE 'sam78-worker-expired-%'
);
DELETE FROM public.tenant_file_objects
WHERE request_id LIKE 'sam78-recovery-%'
  OR request_id LIKE 'sam78-recovered-%'
  OR request_id LIKE 'sam78-cancel-%'
  OR request_id LIKE 'sam78-worker-expired-%';

DO $$
BEGIN
  BEGIN
    PERFORM public.v4_finalize_tenant_file(
      current_setting('v4.org_a')::uuid,
      current_setting('v4.file_id')::uuid,
      1, 'application/pdf', '1B2M2Y8AsgTpgAmY7PhCfg==',
      '"d41d8cd98f00b204e9800998ecf8427e"', NULL,
      '78000000-0000-4000-8000-000000000011',
      'sam78-finalize-size-mismatch'
    );
    RAISE EXCEPTION 'storage finalize accepted mismatched provider size';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'storage_size_mismatch' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.v4_finalize_tenant_file(
      current_setting('v4.org_a')::uuid,
      current_setting('v4.sealed_file_id')::uuid,
      0, 'application/pdf', '1B2M2Y8AsgTpgAmY7PhCfg==',
      '"d41d8cd98f00b204e9800998ecf8427e"', NULL,
      '78000000-0000-4000-8000-000000000018',
      'sam78-finalize-sealed-sales-denied'
    );
    RAISE EXCEPTION 'storage finalize accepted sales actor for sealed file';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sealed_contract_admin_required' THEN RAISE; END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.tenant_file_objects
    WHERE id IN (
      current_setting('v4.file_id')::uuid,
      current_setting('v4.sealed_file_id')::uuid
    ) AND status <> 'pending'
  ) THEN RAISE EXCEPTION 'failed storage verification changed registry status'; END IF;
END
$$;

DO $$
DECLARE worker_result jsonb;
BEGIN
  worker_result := public.v4_process_no_answer_worker(
    current_setting('v4.org_b')::uuid, 'sam78-worker-org-b'
  );
  IF (worker_result ->> 'marked_no_answer')::integer <> 0
    OR EXISTS (
      SELECT 1 FROM public.leads
      WHERE id = current_setting('v4.lead_a')::uuid AND no_answer_flag IS TRUE
    )
  THEN RAISE EXCEPTION 'worker crossed organization boundary'; END IF;
END
$$;
UPDATE public.follow_up_logs
SET contact_time = now() - interval '1 hour',
  created_at = now() - interval '1 hour'
WHERE organization_id = current_setting('v4.org_a')::uuid
  AND lead_id = current_setting('v4.lead_a')::uuid
  AND contact_type = 'note';
INSERT INTO public.follow_up_logs(
  organization_id, lead_id, contact_time, summary, no_answer
) SELECT current_setting('v4.org_a')::uuid,
    current_setting('v4.lead_a')::uuid,
    now() - make_interval(mins => offset_value),
    'SAM-78 no answer', true
  FROM generate_series(1, 3) offset_value;
DO $$
DECLARE worker_result jsonb;
BEGIN
  worker_result := public.v4_process_no_answer_worker(
    current_setting('v4.org_a')::uuid, 'sam78-worker-org-a'
  );
  IF (worker_result ->> 'marked_no_answer')::integer <> 1 THEN
    RAISE EXCEPTION 'active organization worker did not mark lead: %',
      worker_result;
  END IF;
END
$$;

SELECT set_config(
  'v4.support_expires_at',
  (statement_timestamp() + interval '30 minutes')::text,
  false
);

RESET ROLE;
RESET request.jwt.claim.sub;
UPDATE public.profiles SET is_active = false
WHERE id = '78000000-0000-4000-8000-000000000014';
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_request_platform_action_approval(
      'support.session.start', current_setting('v4.org_a'),
      jsonb_build_object(
        'support_user_id', '78000000-0000-4000-8000-000000000016'::uuid,
        'organization_id', current_setting('v4.org_a')::uuid,
        'ticket_ref', 'SAM78-inactive-requester',
        'reason', 'Inactive requester profile must fail before approval creation',
        'scope', '["lead:read"]'::jsonb,
        'expires_at', current_setting('v4.support_expires_at')
      ),
      'sam78-support-inactive-request'
    );
    RAISE EXCEPTION 'inactive profile requested support approval';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'platform_staff_required' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.platform_action_approvals
    WHERE request_id = 'sam78-support-inactive-request'
  ) OR EXISTS (
    SELECT 1 FROM public.platform_action_approval_events
    WHERE request_id = 'approval-request:sam78-support-inactive-request'
  ) THEN RAISE EXCEPTION 'inactive support request left approval side effects'; END IF;
END
$$;
RESET ROLE;
UPDATE public.profiles SET is_active = true
WHERE id = '78000000-0000-4000-8000-000000000014';

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_request_platform_action_approval(
      'support.session.start', current_setting('v4.org_a'),
      jsonb_build_object(
        'support_user_id', '78000000-0000-4000-8000-000000000099'::uuid,
        'organization_id', current_setting('v4.org_a')::uuid,
        'ticket_ref', 'SAM78-forged-support-user',
        'reason', 'A caller supplied support UUID must resolve to active authorized staff',
        'scope', '["lead:read"]'::jsonb,
        'expires_at', current_setting('v4.support_expires_at')
      ),
      'sam78-support-forged-user'
    );
    RAISE EXCEPTION 'forged support user UUID accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'active_support_actor_required' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.v4_request_platform_action_approval(
      'support.session.start', current_setting('v4.org_a'),
      jsonb_build_object(
        'support_user_id', '78000000-0000-4000-8000-000000000016'::uuid,
        'organization_id', current_setting('v4.org_a')::uuid,
        'ticket_ref', 'SAM78-expired-support',
        'reason', 'An already expired support session request must be rejected',
        'scope', '["lead:read"]'::jsonb,
        'expires_at', (statement_timestamp() - interval '1 minute')::text
      ),
      'sam78-support-expired-request'
    );
    RAISE EXCEPTION 'expired support request accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'support_expiry_invalid' THEN RAISE; END IF;
  END;
END
$$;
SELECT set_config(
  'v4.approval_support',
  public.v4_request_platform_action_approval(
    'support.session.start', current_setting('v4.org_a'),
    jsonb_build_object(
      'support_user_id', '78000000-0000-4000-8000-000000000016'::uuid,
      'organization_id', current_setting('v4.org_a')::uuid,
      'ticket_ref', 'SAM78-support',
      'reason', 'Time bounded SAM-78 support verification',
      'scope', '["lead:read"]'::jsonb,
      'expires_at', current_setting('v4.support_expires_at')
    ),
    'sam78-support-approval-request'
  ) ->> 'approval_request_id',
  false
);
DO $$
DECLARE replay jsonb;
BEGIN
  replay := public.v4_request_platform_action_approval(
    'support.session.start', current_setting('v4.org_a'),
    jsonb_build_object(
      'support_user_id', '78000000-0000-4000-8000-000000000016'::uuid,
      'organization_id', current_setting('v4.org_a')::uuid,
      'ticket_ref', 'SAM78-support',
      'reason', 'Time bounded SAM-78 support verification',
      'scope', '["lead:read"]'::jsonb,
      'expires_at', current_setting('v4.support_expires_at')
    ),
    'sam78-support-approval-request'
  );
  IF replay ->> 'approval_request_id' <> current_setting('v4.approval_support')
    OR (replay ->> 'idempotent')::boolean IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'support approval request was not idempotent'; END IF;
  BEGIN
    PERFORM public.v4_approve_platform_action(
      current_setting('v4.approval_support')::uuid,
      'sam78-support-self-approve-owner'
    );
    RAISE EXCEPTION 'support requester self-approved';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'independent_platform_approver_required' THEN RAISE; END IF;
  END;
END
$$;

SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000016';
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_approve_platform_action(
      current_setting('v4.approval_support')::uuid,
      'sam78-support-self-approve-support'
    );
    RAISE EXCEPTION 'platform support self-approved support session';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'platform_action_approve_permission_required' THEN RAISE; END IF;
  END;
END
$$;

RESET ROLE;
RESET request.jwt.claim.sub;
UPDATE public.profiles SET is_active = false
WHERE id = '78000000-0000-4000-8000-000000000015';
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_approve_platform_action(
      current_setting('v4.approval_support')::uuid,
      'sam78-support-inactive-approve'
    );
    RAISE EXCEPTION 'inactive profile approved support session';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'platform_staff_required' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;
RESET request.jwt.claim.sub;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_action_approvals approval
    WHERE approval.id = current_setting('v4.approval_support')::uuid
      AND approval.status = 'pending'
      AND approval.payload_hash = public.v4_platform_payload_hash(approval.payload)
  ) OR (
    SELECT count(*) FROM public.platform_action_approval_events
    WHERE approval_request_id = current_setting('v4.approval_support')::uuid
  ) <> 1 OR EXISTS (
    SELECT 1 FROM public.support_sessions WHERE ticket_ref = 'SAM78-support'
  ) THEN RAISE EXCEPTION 'inactive approval changed frozen support state'; END IF;
END
$$;
UPDATE public.profiles SET is_active = true
WHERE id = '78000000-0000-4000-8000-000000000015';

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
SELECT public.v4_approve_platform_action(
  current_setting('v4.approval_support')::uuid,
  'sam78-support-independent-approve'
);

RESET ROLE;
RESET request.jwt.claim.sub;
UPDATE public.profiles SET is_active = false
WHERE id = '78000000-0000-4000-8000-000000000014';
SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_execute_approved_platform_action(
      current_setting('v4.approval_support')::uuid,
      'sam78-support-consume'
    );
    RAISE EXCEPTION 'inactive requester profile executed support session';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'platform_action_request_permission_required' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_action_approvals
    WHERE id = current_setting('v4.approval_support')::uuid
      AND status = 'approved' AND consumed_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.platform_action_approval_events
    WHERE approval_request_id = current_setting('v4.approval_support')::uuid
      AND action = 'consumed'
  ) OR EXISTS (
    SELECT 1 FROM public.support_sessions WHERE ticket_ref = 'SAM78-support'
  ) THEN RAISE EXCEPTION 'inactive execution left support side effects'; END IF;
END
$$;
RESET ROLE;
UPDATE public.profiles SET is_active = true
WHERE id = '78000000-0000-4000-8000-000000000014';
SET ROLE service_role;
SELECT set_config(
  'v4.support_session',
  public.v4_execute_approved_platform_action(
    current_setting('v4.approval_support')::uuid,
    'sam78-support-consume'
  ) ->> 'support_session_id',
  false
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.support_sessions session
    JOIN public.platform_staff support_staff
      ON support_staff.id = session.platform_staff_id
    JOIN public.platform_staff approver_staff
      ON approver_staff.id = session.approved_by_platform_staff_id
    WHERE session.id = current_setting('v4.support_session')::uuid
      AND support_staff.user_id = '78000000-0000-4000-8000-000000000016'
      AND approver_staff.user_id = '78000000-0000-4000-8000-000000000015'
      AND session.status = 'active'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.platform_action_approvals
    WHERE id = current_setting('v4.approval_support')::uuid
      AND status = 'consumed'
  ) THEN RAISE EXCEPTION 'two-session support approval did not execute atomically'; END IF;
END
$$;

RESET ROLE;
UPDATE public.profiles SET is_active = false
WHERE id = '78000000-0000-4000-8000-000000000014';
SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_execute_approved_platform_action(
      current_setting('v4.approval_support')::uuid,
      'sam78-support-consume'
    );
    RAISE EXCEPTION 'inactive requester replayed consumed support session';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'platform_action_request_permission_required' THEN RAISE; END IF;
  END;
  IF (
    SELECT count(*) FROM public.support_sessions
    WHERE ticket_ref = 'SAM78-support'
  ) <> 1 OR (
    SELECT count(*) FROM public.platform_action_approval_events
    WHERE approval_request_id = current_setting('v4.approval_support')::uuid
      AND action = 'consumed'
  ) <> 1 THEN RAISE EXCEPTION 'inactive consumed replay left support side effects'; END IF;
END
$$;
RESET ROLE;
UPDATE public.profiles SET is_active = true
WHERE id = '78000000-0000-4000-8000-000000000014';

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
SELECT set_config(
  'v4.approval_suspend_a',
  public.v4_request_platform_action_approval(
    'organization.suspend', current_setting('v4.org_a'),
    jsonb_build_object(
      'organization_id', current_setting('v4.org_a')::uuid,
      'action', 'suspend',
      'reason', 'Verified SAM-78 suspension reason'
    ),
    'sam78-approval-suspend-org-a'
  ) ->> 'approval_request_id',
  false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
SELECT public.v4_approve_platform_action(
  current_setting('v4.approval_suspend_a')::uuid,
  'sam78-approve-suspend-org-a'
);
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
SELECT public.v4_execute_approved_platform_action(
  current_setting('v4.approval_suspend_a')::uuid,
  'sam78-suspend-org-a'
);

DO $$
DECLARE export_package jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.support_sessions
    WHERE id = current_setting('v4.support_session')::uuid
      AND status = 'revoked' AND revoked_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'suspension did not revoke support session'; END IF;
  BEGIN
    PERFORM public.v4_process_no_answer_worker(
      current_setting('v4.org_a')::uuid, 'sam78-worker-suspended-a'
    );
    RAISE EXCEPTION 'suspended organization worker executed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'active_organization_required' THEN RAISE; END IF;
  END;
  export_package := public.v4_export_organization_customer_data(
    current_setting('v4.org_a')::uuid,
    '78000000-0000-4000-8000-000000000011',
    'sam78-export-suspended-a'
  );
  IF export_package ->> 'contract_version' <> '2'
    OR export_package #> '{data,legacy_unscoped_tables}' <> '[]'::jsonb
    OR jsonb_array_length(export_package #> '{data,tables,tenant_file_objects}') <> 2
  THEN RAISE EXCEPTION 'complete suspended export contract failed'; END IF;
  BEGIN
    PERFORM public.v4_export_organization_customer_data(
      current_setting('v4.org_a')::uuid,
      '78000000-0000-4000-8000-000000000013',
      'sam78-export-cross-org'
    );
    RAISE EXCEPTION 'cross-organization export accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'organization_export_capability_required' THEN RAISE; END IF;
  END;
END
$$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
SELECT set_config(
  'v4.exit_prepare_approval_b',
  public.v4_request_platform_action_approval(
    'organization.exit.prepare', current_setting('v4.org_b'),
    jsonb_build_object(
      'organization_id', current_setting('v4.org_b')::uuid,
      'idempotency_key', 'sam78-v4-exit-org-b',
      'reason', 'Verify the V4 export and completion digest contract'
    ),
    'sam78-v4-exit-prepare-request-b'
  ) ->> 'approval_request_id',
  false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
SELECT public.v4_approve_platform_action(
  current_setting('v4.exit_prepare_approval_b')::uuid,
  'sam78-v4-exit-prepare-approve-b'
);
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
SELECT public.v4_execute_approved_platform_action(
  current_setting('v4.exit_prepare_approval_b')::uuid,
  'sam78-v4-exit-prepare-execute-b'
);
SELECT set_config(
  'v4.exit_export_digest_b',
  public.v4_export_organization_customer_data(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000013',
    'sam78-v4-export-before-exit-b'
  ) ->> 'data_sha256',
  false
);

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
SELECT set_config(
  'v4.exit_invalid_approval_b',
  public.v4_request_platform_action_approval(
    'organization.exit.complete', current_setting('v4.org_b'),
    jsonb_build_object(
      'organization_id', current_setting('v4.org_b')::uuid,
      'idempotency_key', 'sam78-v4-exit-org-b',
      'expected_export_sha256', repeat('f', 64),
      'backup_evidence_ref', 'sam78-v4-backup-org-b',
      'customer_confirmation_ref', 'sam78-v4-customer-org-b',
      'retention_basis', 'sam78-v4-retention-org-b'
    ),
    'sam78-v4-exit-invalid-request-b'
  ) ->> 'approval_request_id',
  false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
SELECT public.v4_approve_platform_action(
  current_setting('v4.exit_invalid_approval_b')::uuid,
  'sam78-v4-exit-invalid-approve-b'
);
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_execute_approved_platform_action(
      current_setting('v4.exit_invalid_approval_b')::uuid,
      'sam78-v4-exit-invalid-execute-b'
    );
    RAISE EXCEPTION 'V4 exit accepted an export digest without exact audit evidence';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'v4_export_evidence_not_unique' THEN RAISE; END IF;
  END;
END
$$;

INSERT INTO public.audit_events (
  organization_id, actor_user_id, action, target_type, target_id,
  outcome, reason, request_id, metadata
) VALUES (
  current_setting('v4.org_b')::uuid,
  '78000000-0000-4000-8000-000000000013',
  'sam78.v4.export.drift.fixture', 'organization', current_setting('v4.org_b'),
  'success', 'prove post-export organization drift is rejected',
  'sam78-v4-exit-drift-event-b', '{}'::jsonb
);
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
SELECT set_config(
  'v4.exit_drift_approval_b',
  public.v4_request_platform_action_approval(
    'organization.exit.complete', current_setting('v4.org_b'),
    jsonb_build_object(
      'organization_id', current_setting('v4.org_b')::uuid,
      'idempotency_key', 'sam78-v4-exit-org-b',
      'expected_export_sha256', current_setting('v4.exit_export_digest_b'),
      'backup_evidence_ref', 'sam78-v4-backup-org-b',
      'customer_confirmation_ref', 'sam78-v4-customer-org-b',
      'retention_basis', 'sam78-v4-retention-org-b'
    ),
    'sam78-v4-exit-drift-request-b'
  ) ->> 'approval_request_id',
  false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
SELECT public.v4_approve_platform_action(
  current_setting('v4.exit_drift_approval_b')::uuid,
  'sam78-v4-exit-drift-approve-b'
);
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_execute_approved_platform_action(
      current_setting('v4.exit_drift_approval_b')::uuid,
      'sam78-v4-exit-drift-execute-b'
    );
    RAISE EXCEPTION 'V4 exit accepted organization changes after export';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'organization_changed_after_export' THEN RAISE; END IF;
  END;
END
$$;
SELECT set_config(
  'v4.exit_export_digest_b',
  public.v4_export_organization_customer_data(
    current_setting('v4.org_b')::uuid,
    '78000000-0000-4000-8000-000000000013',
    'sam78-v4-export-after-drift-b'
  ) ->> 'data_sha256',
  false
);

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
SELECT set_config(
  'v4.exit_valid_approval_b',
  public.v4_request_platform_action_approval(
    'organization.exit.complete', current_setting('v4.org_b'),
    jsonb_build_object(
      'organization_id', current_setting('v4.org_b')::uuid,
      'idempotency_key', 'sam78-v4-exit-org-b',
      'expected_export_sha256', current_setting('v4.exit_export_digest_b'),
      'backup_evidence_ref', 'sam78-v4-backup-org-b',
      'customer_confirmation_ref', 'sam78-v4-customer-org-b',
      'retention_basis', 'sam78-v4-retention-org-b'
    ),
    'sam78-v4-exit-valid-request-b'
  ) ->> 'approval_request_id',
  false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
SELECT public.v4_approve_platform_action(
  current_setting('v4.exit_valid_approval_b')::uuid,
  'sam78-v4-exit-valid-approve-b'
);
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
SELECT set_config(
  'v4.exit_complete_b',
  public.v4_execute_approved_platform_action(
    current_setting('v4.exit_valid_approval_b')::uuid,
    'sam78-v4-exit-valid-execute-b'
  )::text,
  false
);
DO $$
DECLARE
  result jsonb := current_setting('v4.exit_complete_b')::jsonb;
  replay jsonb;
BEGIN
  IF result ->> 'status' <> 'completed'
    OR result ->> 'organization_status' <> 'closed'
    OR result ->> 'export_sha256' <> current_setting('v4.exit_export_digest_b')
    OR result ->> 'idempotent' <> 'false'
  THEN RAISE EXCEPTION 'V4 export-to-complete result drifted'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_exit_requests
    WHERE organization_id = current_setting('v4.org_b')::uuid
      AND status = 'completed'
      AND export_sha256 = current_setting('v4.exit_export_digest_b')
  ) OR NOT EXISTS (
    SELECT 1 FROM public.audit_events
    WHERE organization_id = current_setting('v4.org_b')::uuid
      AND action = 'organization.exit_completed'
      AND metadata ->> 'export_sha256' = current_setting('v4.exit_export_digest_b')
  ) THEN RAISE EXCEPTION 'V4 exit persistence or audit evidence drifted'; END IF;
  replay := public.v4_execute_approved_platform_action(
    current_setting('v4.exit_valid_approval_b')::uuid,
    'sam78-v4-exit-valid-execute-b'
  );
  IF replay ->> 'idempotent' <> 'true' THEN
    RAISE EXCEPTION 'V4 exit replay was not idempotent';
  END IF;
END
$$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000012';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_import_leads_for_organization(
      current_setting('v4.org_a')::uuid,
      jsonb_build_array(jsonb_build_object(
        'customer_name', 'Suspended write', 'source', 'offline',
        'import_fingerprint', repeat('b', 64)
      )),
      '78000000-3012-4000-8000-000000000012',
      'sam78-import-suspended-a'
    );
    RAISE EXCEPTION 'suspended organization write accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'lead_import_capability_required' THEN RAISE; END IF;
  END;
END
$$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000014';
RESET request.headers;
SELECT set_config(
  'v4.approval_recover_a',
  public.v4_request_platform_action_approval(
    'organization.recover', current_setting('v4.org_a'),
    jsonb_build_object(
      'organization_id', current_setting('v4.org_a')::uuid,
      'action', 'recover',
      'reason', 'Verified SAM-78 recovery reason'
    ),
    'sam78-approval-recover-org-a'
  ) ->> 'approval_request_id',
  false
);
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000015';
SELECT public.v4_approve_platform_action(
  current_setting('v4.approval_recover_a')::uuid,
  'sam78-approve-recover-org-a'
);
RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
SELECT public.v4_execute_approved_platform_action(
  current_setting('v4.approval_recover_a')::uuid,
  'sam78-recover-org-a'
);

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000012';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', current_setting('v4.org_a'))::text,
  false
);
SELECT public.v4_import_leads_for_organization(
  current_setting('v4.org_a')::uuid,
  jsonb_build_array(jsonb_build_object(
    'customer_name', 'Recovered write', 'source', 'offline',
    'import_fingerprint', repeat('c', 64)
  )),
  '78000000-4012-4000-8000-000000000012',
  'sam78-import-recovered-a'
);

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
UPDATE public.memberships SET status = 'inactive', deactivated_at = now()
WHERE id = current_setting('v4.member_a')::uuid;
RESET ROLE;
SET ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.leads
    WHERE organization_id = current_setting('v4.org_a')::uuid
  ) THEN RAISE EXCEPTION 'inactive membership retained tenant reads'; END IF;
END
$$;

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;
DO $$
BEGIN
  BEGIN
    UPDATE public.audit_events SET reason = 'mutated'
    WHERE request_id = 'sam78-suspend-org-a';
    RAISE EXCEPTION 'audit event mutation accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'immutable_record' THEN RAISE; END IF;
  END;
END
$$;

RESET ROLE;
SELECT set_config('newme.environment', 'test', false);
TRUNCATE TABLE
  public.membership_roles, public.activities, public.activity_logs,
  public.ad_spend, public.audit_logs, public.business_events,
  public.chat_messages, public.customers, public.follow_up_logs,
  public.knx_designs, public.kpi_targets, public.lead_assignment_state,
  public.lead_deletion_requests, public.lead_files, public.lead_milestones,
  public.lead_mutation_requests, public.lead_workflow_stages,
  public.notifications, public.quotes, public.transfer_history,
  public.user_session_daily;

CREATE OR REPLACE FUNCTION pg_temp.assert_rollback_table_guard(p_table_name text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    PERFORM public.v4_assert_tenant_closure_rollback_safe();
    RAISE EXCEPTION 'rollback guard accepted organization data in %', p_table_name;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'v4_tenant_lifecycle_closure_rollback_unscoped_data:'
      || p_table_name
    THEN RAISE; END IF;
  END;
END;
$$;

INSERT INTO public.membership_roles(organization_id, membership_id, role_id)
SELECT current_setting('v4.org_a')::uuid, current_setting('v4.member_a')::uuid,
  id FROM public.roles WHERE scope = 'organization' AND role_key = 'operations';
SELECT pg_temp.assert_rollback_table_guard('membership_roles');
TRUNCATE public.membership_roles;

INSERT INTO public.activities(organization_id) VALUES (current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('activities');
TRUNCATE public.activities;
INSERT INTO public.activity_logs(organization_id, tenant_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('activity_logs');
TRUNCATE public.activity_logs;
INSERT INTO public.ad_spend(organization_id) VALUES (current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('ad_spend');
TRUNCATE public.ad_spend;
INSERT INTO public.audit_logs(organization_id) VALUES (current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('audit_logs');
TRUNCATE public.audit_logs;
INSERT INTO public.business_events(organization_id) VALUES (current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('business_events');
TRUNCATE public.business_events;
INSERT INTO public.chat_messages(organization_id) VALUES (current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('chat_messages');
TRUNCATE public.chat_messages;
INSERT INTO public.customers(organization_id) VALUES (current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('customers');
TRUNCATE public.customers;
INSERT INTO public.follow_up_logs(organization_id, lead_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.lead_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('follow_up_logs');
TRUNCATE public.follow_up_logs;
INSERT INTO public.knx_designs(organization_id, lead_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.lead_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('knx_designs');
TRUNCATE public.knx_designs;
INSERT INTO public.kpi_targets(organization_id) VALUES (current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('kpi_targets');
TRUNCATE public.kpi_targets;
INSERT INTO public.lead_assignment_state(organization_id)
VALUES (current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('lead_assignment_state');
TRUNCATE public.lead_assignment_state;
INSERT INTO public.lead_deletion_requests(organization_id, deleted_lead_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.lead_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('lead_deletion_requests');
TRUNCATE public.lead_deletion_requests;
INSERT INTO public.lead_files(organization_id, lead_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.lead_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('lead_files');
TRUNCATE public.lead_files;
INSERT INTO public.lead_milestones(organization_id, lead_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.lead_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('lead_milestones');
TRUNCATE public.lead_milestones;
INSERT INTO public.lead_mutation_requests(organization_id, lead_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.lead_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('lead_mutation_requests');
TRUNCATE public.lead_mutation_requests;
INSERT INTO public.lead_workflow_stages(organization_id, lead_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.lead_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('lead_workflow_stages');
TRUNCATE public.lead_workflow_stages;
INSERT INTO public.notifications(organization_id, user_id, title)
VALUES (
  current_setting('v4.org_a')::uuid,
  '78000000-0000-4000-8000-000000000011',
  'rollback guard fixture'
);
SELECT pg_temp.assert_rollback_table_guard('notifications');
TRUNCATE public.notifications;
INSERT INTO public.quotes(organization_id, lead_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.lead_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('quotes');
TRUNCATE public.quotes;
INSERT INTO public.transfer_history(organization_id, lead_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.lead_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('transfer_history');
TRUNCATE public.transfer_history;
INSERT INTO public.user_session_daily(organization_id, tenant_id)
VALUES (current_setting('v4.org_a')::uuid, current_setting('v4.org_a')::uuid);
SELECT pg_temp.assert_rollback_table_guard('user_session_daily');
TRUNCATE public.user_session_daily;

ROLLBACK;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id::text LIKE '78000000-0000-4000-8000-00000000001%'
  ) OR EXISTS (
    SELECT 1 FROM public.organizations WHERE slug LIKE 'sam78-closure-%'
  ) THEN RAISE EXCEPTION 'SAM-78 disposable fixture cleanup failed'; END IF;
END
$$;

SELECT 'SAM-78 tenant lifecycle closure passed' AS result;
