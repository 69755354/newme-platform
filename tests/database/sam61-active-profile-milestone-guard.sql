\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL CHECK (
    role IN ('admin', 'boss', 'operator', 'sales', 'designer', 'finance')
  ),
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE public.leads (
  id uuid PRIMARY KEY,
  assigned_to uuid,
  current_milestone text,
  final_status text,
  updated_at timestamptz NOT NULL
);

CREATE TABLE public.lead_milestones (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  milestone_key text NOT NULL,
  notes text,
  completed_at timestamptz,
  completed_by uuid
);

CREATE TABLE public.business_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  description text NOT NULL,
  event_data jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE FUNCTION public.milestone_order(p_key text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_key
    WHEN 'first_contact' THEN 1
    WHEN 'basic_info' THEN 2
    WHEN 'drawings' THEN 3
    WHEN 'requirements' THEN 4
    WHEN 'solution' THEN 5
    WHEN 'quotation' THEN 6
    WHEN 'meeting' THEN 7
    ELSE 0
  END
$$;

-- Establish the canonical pre-migration privilege state. CREATE OR REPLACE
-- must retain it without adding any top-level GRANT or REVOKE.
CREATE FUNCTION public.reopen_lead_milestone(uuid, text, text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT '{}'::jsonb $$;

CREATE FUNCTION public.recomplete_lead_milestone(uuid, text, text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT '{}'::jsonb $$;

REVOKE ALL ON FUNCTION public.reopen_lead_milestone(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recomplete_lead_milestone(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_lead_milestone(uuid, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.recomplete_lead_milestone(uuid, text, text)
  TO authenticated;

INSERT INTO public.profiles (id, role, is_active)
VALUES
  ('61000000-0000-4000-8000-000000000001', 'admin', true),
  ('61000000-0000-4000-8000-000000000002', 'admin', false),
  ('61000000-0000-4000-8000-000000000003', 'sales', true),
  ('61000000-0000-4000-8000-000000000004', 'sales', false);

INSERT INTO public.leads (id, assigned_to, current_milestone, final_status, updated_at)
VALUES
  ('61000000-0000-4000-8000-000000000101', NULL, 'first_contact', NULL, '2026-07-30 00:00:00+00'),
  ('61000000-0000-4000-8000-000000000102', '61000000-0000-4000-8000-000000000003', 'new', NULL, '2026-07-30 00:00:00+00'),
  ('61000000-0000-4000-8000-000000000201', NULL, 'first_contact', NULL, '2026-07-30 00:00:00+00'),
  ('61000000-0000-4000-8000-000000000202', '61000000-0000-4000-8000-000000000004', 'new', NULL, '2026-07-30 00:00:00+00'),
  ('61000000-0000-4000-8000-000000000301', '61000000-0000-4000-8000-000000000001', 'first_contact', NULL, '2026-07-30 00:00:00+00');

INSERT INTO public.lead_milestones (
  id,
  lead_id,
  milestone_key,
  notes,
  completed_at,
  completed_by
)
VALUES
  ('61000000-0000-4000-8000-000000000111', '61000000-0000-4000-8000-000000000101', 'first_contact', 'active-admin-before', '2026-07-30 00:00:00+00', '61000000-0000-4000-8000-000000000001'),
  ('61000000-0000-4000-8000-000000000112', '61000000-0000-4000-8000-000000000102', 'first_contact', 'active-sales-before', NULL, NULL),
  ('61000000-0000-4000-8000-000000000211', '61000000-0000-4000-8000-000000000201', 'first_contact', 'inactive-admin-before', '2026-07-30 00:00:00+00', '61000000-0000-4000-8000-000000000002'),
  ('61000000-0000-4000-8000-000000000212', '61000000-0000-4000-8000-000000000202', 'first_contact', 'inactive-sales-before', NULL, NULL),
  ('61000000-0000-4000-8000-000000000311', '61000000-0000-4000-8000-000000000301', 'first_contact', 'unassigned-sales-before', '2026-07-30 00:00:00+00', '61000000-0000-4000-8000-000000000001');

\ir ../../supabase/migrations/20260729235704_sam61_require_active_profiles_for_milestone_mutations.sql

DO $assert_privileges$
BEGIN
  IF has_function_privilege(
    'anon',
    'public.reopen_lead_milestone(uuid,text,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.recomplete_lead_milestone(uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon_execute_grant_present';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    'public.reopen_lead_milestone(uuid,text,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'authenticated',
    'public.recomplete_lead_milestone(uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated_execute_grant_missing';
  END IF;
END;
$assert_privileges$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '61000000-0000-4000-8000-000000000001';
SELECT public.reopen_lead_milestone(
  '61000000-0000-4000-8000-000000000101',
  'first_contact',
  'active admin reopen'
);
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = '61000000-0000-4000-8000-000000000003';
SELECT public.recomplete_lead_milestone(
  '61000000-0000-4000-8000-000000000102',
  'first_contact',
  'active assigned sales recomplete'
);
RESET ROLE;

DO $assert_active_positive$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = '61000000-0000-4000-8000-000000000101'
      AND completed_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.business_events
    WHERE lead_id = '61000000-0000-4000-8000-000000000101'
      AND event_type = 'status_changed'
  ) THEN
    RAISE EXCEPTION 'active_admin_reopen_not_applied';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = '61000000-0000-4000-8000-000000000102'
      AND completed_at IS NOT NULL
      AND completed_by = '61000000-0000-4000-8000-000000000003'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.business_events
    WHERE lead_id = '61000000-0000-4000-8000-000000000102'
      AND event_type = 'note_added'
  ) THEN
    RAISE EXCEPTION 'active_assigned_sales_recomplete_not_applied';
  END IF;
END;
$assert_active_positive$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '61000000-0000-4000-8000-000000000002';
DO $inactive_admin$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.reopen_lead_milestone(
      '61000000-0000-4000-8000-000000000201',
      'first_contact',
      'inactive admin must fail'
    );
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'Forbidden: invalid CRM role' THEN
        RAISE;
      END IF;
      denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'inactive_admin_reopen_unexpected_success';
  END IF;
END;
$inactive_admin$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = '61000000-0000-4000-8000-000000000004';
DO $inactive_sales$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.recomplete_lead_milestone(
      '61000000-0000-4000-8000-000000000202',
      'first_contact',
      'inactive assigned sales must fail'
    );
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'Forbidden: invalid CRM role' THEN
        RAISE;
      END IF;
      denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'inactive_sales_recomplete_unexpected_success';
  END IF;
END;
$inactive_sales$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = '61000000-0000-4000-8000-000000000003';
DO $unassigned_sales$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.reopen_lead_milestone(
      '61000000-0000-4000-8000-000000000301',
      'first_contact',
      'unassigned sales must fail'
    );
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'Forbidden: lead not assigned to you' THEN
        RAISE;
      END IF;
      denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'unassigned_sales_reopen_unexpected_success';
  END IF;
END;
$unassigned_sales$;
RESET ROLE;

SET ROLE anon;
DO $anon_reopen$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.reopen_lead_milestone(
      '61000000-0000-4000-8000-000000000101',
      'first_contact',
      'anon must fail'
    );
  EXCEPTION
    WHEN insufficient_privilege THEN
      denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'anon_reopen_unexpected_success';
  END IF;
END;
$anon_reopen$;

DO $anon_recomplete$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.recomplete_lead_milestone(
      '61000000-0000-4000-8000-000000000102',
      'first_contact',
      'anon must fail'
    );
  EXCEPTION
    WHEN insufficient_privilege THEN
      denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'anon_recomplete_unexpected_success';
  END IF;
END;
$anon_recomplete$;
RESET ROLE;

DO $assert_negative_zero_side_effect$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = '61000000-0000-4000-8000-000000000201'
      AND notes = 'inactive-admin-before'
      AND completed_at = '2026-07-30 00:00:00+00'
      AND completed_by = '61000000-0000-4000-8000-000000000002'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.leads
    WHERE id = '61000000-0000-4000-8000-000000000201'
      AND current_milestone = 'first_contact'
      AND updated_at = '2026-07-30 00:00:00+00'
  ) OR EXISTS (
    SELECT 1
    FROM public.business_events
    WHERE lead_id = '61000000-0000-4000-8000-000000000201'
  ) THEN
    RAISE EXCEPTION 'inactive_admin_reopen_side_effect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = '61000000-0000-4000-8000-000000000202'
      AND notes = 'inactive-sales-before'
      AND completed_at IS NULL
      AND completed_by IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.leads
    WHERE id = '61000000-0000-4000-8000-000000000202'
      AND current_milestone = 'new'
      AND updated_at = '2026-07-30 00:00:00+00'
  ) OR EXISTS (
    SELECT 1
    FROM public.business_events
    WHERE lead_id = '61000000-0000-4000-8000-000000000202'
  ) THEN
    RAISE EXCEPTION 'inactive_sales_recomplete_side_effect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = '61000000-0000-4000-8000-000000000301'
      AND notes = 'unassigned-sales-before'
      AND completed_at = '2026-07-30 00:00:00+00'
  ) OR EXISTS (
    SELECT 1
    FROM public.business_events
    WHERE lead_id = '61000000-0000-4000-8000-000000000301'
  ) THEN
    RAISE EXCEPTION 'unassigned_sales_reopen_side_effect';
  END IF;
END;
$assert_negative_zero_side_effect$;

SELECT 'SAM-61 active-profile milestone guard passed' AS result;
