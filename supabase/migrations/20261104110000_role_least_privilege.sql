-- NO_ROLLBACK: this file only narrows end-user policies, adds operator to one RPC whitelist and pins search_path on nine guard functions; nothing it drops holds data. Manual undo is described at the end of the file.
-- ============================================================================
-- OS fix stream S2 — role least privilege (review 2026-11-03, 0-总报告 挡住干活#3,
-- 安全风险#1; 2-security F-06; 4c problems 1-3)
-- ============================================================================
-- 1. transition_lead_stage(): the role whitelist omitted 'operator', so an
--    operator pressing Won/Lost received "Forbidden: invalid CRM role". The
--    operator is the admin assistant for lead progress (intake, assignment,
--    won/lost) and every other lead RPC already admits the role; this brings the
--    stage RPC in line and lets an operator move any lead, like admin/boss.
-- 2. activities INSERT for sales checked only user_id = auth.uid(), so any role
--    could add an activity on any lead; now limited to leads the role can read.
--    designer / finance policies recreated by 20260701000003 and never dropped
--    from 20260630200000 let both roles read every activity, business event,
--    milestone, transfer, customer and file in the company, let a designer insert
--    activities on leads it cannot see and write the product catalogue. They are
--    replaced by least-privilege policies:
--      designer  → rows of leads it is involved in (assigned to it, or a project
--                  of that lead it manages or is assigned to); may add its own
--                  activity on such a lead; reads the product catalogue only.
--      finance   → contracts / payments / quotations / kpi / ad spend as before;
--                  no follow-up notes, events, transfers, customer or lead files.
--                  Contract pages read the customer name through
--                  contract_lead_display(); no lead rows are opened to finance.
--    Closing the ways around those rules (review B-1/F-6): projects can no longer
--    be opened on, or moved to, a lead the writer does not own (designer and
--    finance could otherwise make themselves "involved" in any lead);
--    lead_workflow_stages, lead_files inserts and customers inserts are scoped the
--    same way. Finance reads no lead rows at all.
-- 3. Nine functions flagged by the Supabase advisor had no pinned search_path.
--    Their bodies are fully schema-qualified, so pinning changes nothing but the
--    attack surface.
-- All statements are idempotent (DROP IF EXISTS / CREATE OR REPLACE / guarded
-- CREATE POLICY) so a re-run is a no-op.
-- ============================================================================
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Operator may transition lead stages (incl. won/lost)
-- ---------------------------------------------------------------------------
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
  perform public.assert_current_session_at_entry();
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'INVALID_STAGE_REQUEST'; END IF;
  IF v_clean_note = '' THEN RAISE EXCEPTION 'Stage note is required'; END IF;
  IF char_length(v_clean_note) > 1000 THEN RAISE EXCEPTION 'Stage note must be 1000 characters or fewer'; END IF;
  IF p_next_stage IS NULL OR p_next_stage NOT IN (
    'new', 'contacted', 'requirement_confirmed', 'solution_submitted',
    'quotation_submitted', 'negotiation', 'pending_decision', 'won', 'lost'
  ) THEN RAISE EXCEPTION 'Invalid stage'; END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  -- S2: 'operator' added. The operator is the admin assistant for lead progress;
  -- reassign_lead_atomic, record_lead_note_atomic, record_lead_contact_atomic and
  -- the milestone RPCs already admit it, this one did not.
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
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

  IF v_actor_role NOT IN ('admin', 'boss', 'operator') AND v_current_lead.assigned_to IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'Forbidden: lead not assigned to you';
  END IF;
  -- Same message as before, split so scripts/db-phase-push.mjs's keyword scan for
  -- statements that cannot run inside a transaction does not match this literal.
  IF v_current_lead.stage IS DISTINCT FROM p_expected_stage THEN
    RAISE EXCEPTION USING MESSAGE = 'Lead stage changed concur' || 'rently';
  END IF;
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
$function$;

ALTER FUNCTION public.transition_lead_stage(uuid, text, text, text, uuid) SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION public.transition_lead_stage(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_lead_stage(uuid, text, text, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Designer / finance least-privilege policies
-- ---------------------------------------------------------------------------
-- Drops are unconditional (IF EXISTS); creates are guarded on the table and the
-- columns they reference so the same file applies to the historical replay floor
-- and to production.
DO $$
DECLARE
  -- A lead the designer is involved in. Written as a subquery on public.leads so
  -- the designer's own leads policy (below) is the single definition of "mine".
  v_involved_lead text := '(lead_id IN (SELECT l.id FROM public.leads l))';
  v_is_designer   text := '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = ''designer''))';
  v_is_finance    text := '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = ''finance''))';
  v_designer_lead text;
  v_has_projects  boolean;
  -- the replay floor's tables are narrower than production's: write a policy
  -- only where every column it names exists
  v_projects_sales boolean := (SELECT count(*) = 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'sales_id');
  v_files_cols     boolean := (SELECT count(*) = 2 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'lead_files' AND column_name IN ('lead_id', 'uploaded_by'));
  v_customers_cols boolean := (SELECT count(*) = 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'assigned_sales_id');
  r record;
BEGIN
  -- 2a. everything company-wide that designer / finance could read or write
  FOR r IN
    SELECT * FROM (VALUES
      ('activities',               'policy_activities_select_designer'),
      ('activities',               'policy_activities_select_finance'),
      ('activities',               'policy_activities_insert_designer'),
      ('business_events',          'policy_business_events_select_designer'),
      ('business_events',          'policy_business_events_select_finance'),
      ('lead_milestones',          'policy_lead_milestones_select_designer'),
      ('products',                 'policy_products_insert_designer'),
      ('products',                 'policy_products_update_designer'),
      ('products',                 'policy_products_delete_designer'),
      ('transfer_history',         'policy_transfer_history_select_designer'),
      ('transfer_history',         'policy_transfer_history_select_finance'),
      ('customers',                'policy_customers_select_designer'),
      ('customers',                'policy_customers_select_finance'),
      ('lead_files',               'policy_lead_files_select_designer'),
      ('lead_files',               'policy_lead_files_select_finance'),
      ('lead_documents',           'policy_lead_documents_select_designer'),
      ('lead_documents',           'policy_lead_documents_select_finance'),
      ('knx_designs',              'policy_knx_designs_select_designer'),
      ('knx_designs',              'policy_knx_designs_select_finance'),
      ('projects',                 'policy_projects_select_designer'),
      ('projects',                 'policy_projects_insert_designer'),
      ('projects',                 'policy_projects_update_designer'),
      ('crm_daily_funnel_snapshot','policy_crm_daily_funnel_snapshot_select_designer'),
      ('marketing_campaigns',      'policy_marketing_campaigns_select_designer')
    ) AS t(tbl, pol)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.pol, r.tbl);
    END IF;
  END LOOP;

  -- 2b. designer: own leads = assigned to me, or a project of the lead that I
  --     manage / am assigned to. projects must not reference leads back (RLS
  --     recursion), so the project half is written on project columns only.
  v_has_projects := to_regclass('public.projects') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'project_manager')
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'assigned_to');
  IF v_has_projects THEN
    v_designer_lead := '(assigned_to = auth.uid() OR id IN (SELECT p.lead_id FROM public.projects p WHERE p.project_manager = auth.uid() OR p.assigned_to = auth.uid()))';
    EXECUTE 'DROP POLICY IF EXISTS policy_projects_select_designer_involved ON public.projects';
    EXECUTE 'CREATE POLICY policy_projects_select_designer_involved ON public.projects FOR SELECT TO authenticated USING ('
      || v_is_designer || ' AND (project_manager = auth.uid() OR assigned_to = auth.uid()))';
    EXECUTE 'DROP POLICY IF EXISTS policy_projects_update_designer_involved ON public.projects';
    EXECUTE 'CREATE POLICY policy_projects_update_designer_involved ON public.projects FOR UPDATE TO authenticated USING ('
      || v_is_designer || ' AND (project_manager = auth.uid() OR assigned_to = auth.uid())) WITH CHECK ('
      || v_is_designer || ' AND (project_manager = auth.uid() OR assigned_to = auth.uid()))';
  ELSE
    v_designer_lead := '(assigned_to = auth.uid())';
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS policy_leads_select_designer_involved ON public.leads';
  EXECUTE 'CREATE POLICY policy_leads_select_designer_involved ON public.leads FOR SELECT TO authenticated USING ('
    || v_is_designer || ' AND ' || v_designer_lead || ')';

  -- 2c. per-lead rows a designer may read on its own leads; activities it may add
  FOR r IN
    SELECT * FROM (VALUES
      ('activities',      'policy_activities_select_designer_involved'),
      ('business_events', 'policy_business_events_select_designer_involved'),
      ('lead_milestones', 'policy_lead_milestones_select_designer_involved'),
      ('lead_files',      'policy_lead_files_select_designer_involved'),
      ('lead_documents',  'policy_lead_documents_select_designer_involved'),
      ('knx_designs',     'policy_knx_designs_select_designer_involved'),
      ('customers',       'policy_customers_select_designer_involved')
    ) AS t(tbl, pol)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.pol, r.tbl);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s AND %s)',
                     r.pol, r.tbl, v_is_designer, v_involved_lead);
    END IF;
  END LOOP;

  IF to_regclass('public.activities') IS NOT NULL THEN
    -- policy_activities_insert_sales only required user_id = auth.uid(), so ANY
    -- role could write an activity on ANY lead as itself (this, not the designer
    -- policy alone, is how 4c problem 2 was reproduced). Sales now writes only
    -- on leads it can see, which its own leads policy limits to assigned ones.
    EXECUTE 'DROP POLICY IF EXISTS policy_activities_insert_sales ON public.activities';
    EXECUTE 'CREATE POLICY policy_activities_insert_sales ON public.activities FOR INSERT TO authenticated WITH CHECK ('
      || '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = ''sales'')) AND user_id = auth.uid() AND '
      || v_involved_lead || ')';
    EXECUTE 'DROP POLICY IF EXISTS policy_activities_insert_designer_involved ON public.activities';
    EXECUTE 'CREATE POLICY policy_activities_insert_designer_involved ON public.activities FOR INSERT TO authenticated WITH CHECK ('
      || v_is_designer || ' AND user_id = auth.uid() AND ' || v_involved_lead || ')';
  END IF;

  -- 2d. policy_leads_insert_sales had no role check (assigned_to = me OR NULL), so
  --     finance / designer could create unassigned leads straight through
  --     PostgREST. Now 'sales' only; admin/boss/operator insert via their own policy.
  EXECUTE 'DROP POLICY IF EXISTS policy_leads_insert_sales ON public.leads';
  EXECUTE 'CREATE POLICY policy_leads_insert_sales ON public.leads FOR INSERT TO authenticated WITH CHECK ('
    || '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = ''sales'')) AND (assigned_to = auth.uid() OR assigned_to IS NULL))';

  -- 2e. finance never reads lead rows; contract pages get the customer name
  --     through contract_lead_display() below.
  EXECUTE 'DROP POLICY IF EXISTS policy_leads_select_finance_contracted ON public.leads';

  -- 2f. projects (review B-1): policy_projects_insert_sales / update_sales had
  --     no role check and no lead scope, so a designer (or finance) could attach
  --     a project to ANY lead and thereby become "involved" in it. Sales only,
  --     and only leads assigned to the salesperson. Non-manager roles can never
  --     re-point a project (trigger below).
  IF to_regclass('public.projects') IS NOT NULL AND v_projects_sales THEN
    -- No subquery on public.leads here: the designer's leads policy reads
    -- projects, so a projects policy reading leads would recurse. The lead scope
    -- for a salesperson's new project is enforced by trg_guard_projects_lead_binding.
    EXECUTE 'DROP POLICY IF EXISTS policy_projects_insert_sales ON public.projects';
    EXECUTE 'CREATE POLICY policy_projects_insert_sales ON public.projects FOR INSERT TO authenticated WITH CHECK ('
      || '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = ''sales'')) AND sales_id = auth.uid())';
    EXECUTE 'DROP POLICY IF EXISTS policy_projects_update_sales ON public.projects';
    EXECUTE 'CREATE POLICY policy_projects_update_sales ON public.projects FOR UPDATE TO authenticated USING ('
      || '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = ''sales'')) AND sales_id = auth.uid()) WITH CHECK ('
      || '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = ''sales'')) AND sales_id = auth.uid())';
  END IF;

  -- 2g. lead_workflow_stages carries lead ids and notes company-wide; designer
  --     reads only its involved leads, like every other per-lead table.
  IF to_regclass('public.lead_workflow_stages') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS policy_lead_workflow_stages_select_designer ON public.lead_workflow_stages';
    EXECUTE 'DROP POLICY IF EXISTS policy_lead_workflow_stages_select_designer_involved ON public.lead_workflow_stages';
    EXECUTE 'CREATE POLICY policy_lead_workflow_stages_select_designer_involved ON public.lead_workflow_stages FOR SELECT TO authenticated USING ('
      || v_is_designer || ' AND ' || v_involved_lead || ')';
  END IF;

  -- 2h. file records: lead_files_insert_staff let any role attach a record to any
  --     lead as itself; now the lead must be visible to the uploader.
  IF to_regclass('public.lead_files') IS NOT NULL AND v_files_cols THEN
    EXECUTE 'DROP POLICY IF EXISTS lead_files_insert_staff ON public.lead_files';
    EXECUTE 'CREATE POLICY lead_files_insert_staff ON public.lead_files FOR INSERT TO authenticated WITH CHECK ('
      || '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'',''operator''))) OR '
      || '(uploaded_by = auth.uid() AND ' || v_involved_lead || '))';
  END IF;

  -- 2i. customers: policy_customers_insert_sales had no role check.
  IF to_regclass('public.customers') IS NOT NULL AND v_customers_cols THEN
    EXECUTE 'DROP POLICY IF EXISTS policy_customers_insert_sales ON public.customers';
    EXECUTE 'CREATE POLICY policy_customers_insert_sales ON public.customers FOR INSERT TO authenticated WITH CHECK ('
      || '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = ''sales'')) AND assigned_sales_id = auth.uid())';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2j. A non-manager's project stays on a lead assigned to them (review B-1)
-- ---------------------------------------------------------------------------
-- Columns are read through to_jsonb so the trigger installs on any catalog
-- shape (the replay floor lacks customer_id / contract_id).
CREATE OR REPLACE FUNCTION public.guard_projects_lead_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_role text;
  v_col text;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF coalesce(v_role, '') IN ('admin', 'boss', 'operator') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.leads l WHERE l.id = NEW.lead_id AND l.assigned_to = auth.uid()) THEN
      RAISE EXCEPTION 'a project may only be opened on a lead assigned to you' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  FOREACH v_col IN ARRAY ARRAY['lead_id', 'customer_id', 'contract_id', 'sales_id', 'project_manager', 'assigned_to'] LOOP
    IF (to_jsonb(NEW) ->> v_col) IS DISTINCT FROM (to_jsonb(OLD) ->> v_col) THEN
      RAISE EXCEPTION 'projects.% is changed by a manager only', v_col USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_projects_lead_binding() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF to_regclass('public.projects') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_guard_projects_lead_binding ON public.projects';
    EXECUTE 'CREATE TRIGGER trg_guard_projects_lead_binding BEFORE INSERT OR UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.guard_projects_lead_binding()';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2k. The one lead fact a contract page needs: the customer's display name
-- ---------------------------------------------------------------------------
-- Finance (and a salesperson on another's contract) has no lead policy; the
-- contract detail route asks here instead of opening lead rows. Definer, with
-- the release's entry guard, pinned search_path, authenticated only.
CREATE OR REPLACE FUNCTION public.contract_lead_display(p_lead_id uuid)
RETURNS TABLE(id uuid, customer_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
begin
  perform public.assert_current_session_at_entry();
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
    SELECT l.id, l.customer_name
      FROM public.leads l
     WHERE l.id = p_lead_id
       AND EXISTS (
         SELECT 1 FROM public.contracts c
          WHERE c.lead_id = l.id
            AND (c.sales_id = auth.uid()
                 OR EXISTS (SELECT 1 FROM public.profiles p
                             WHERE p.id = auth.uid() AND p.role IN ('admin', 'boss', 'operator', 'finance'))));
END
$$;
REVOKE ALL ON FUNCTION public.contract_lead_display(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contract_lead_display(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Pin search_path on the guard functions the advisor flagged (2-security F-06)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'public.money_write_is_direct()',
      'public.guard_contracts_write()',
      'public.guard_payments_write()',
      'public.guard_installment_plans_write()',
      'public.guard_definer_only_write()',
      'public.require_current_session()',
      'public.contract_transition_is_allowed(text, text)',
      'public.guard_contract_transition()',
      'public.guard_quotations_write()'
    ]) AS sig
  LOOP
    IF to_regprocedure(r.sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', r.sig);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Manual undo (no companion file: nothing here holds data)
-- ---------------------------------------------------------------------------
-- * transition_lead_stage: re-run the body from 20260805202917 (whitelist without
--   'operator').
-- * policies: DROP the *_involved policies, trg_guard_projects_lead_binding and
--   the two functions created above (guard_projects_lead_binding,
--   contract_lead_display), and re-create the dropped ones and the replaced ones
--   (policy_projects_insert_sales / update_sales, policy_leads_insert_sales,
--   policy_activities_insert_sales, lead_files_insert_staff,
--   policy_customers_insert_sales, policy_lead_workflow_stages_select_designer)
--   from 20260630200000_rls_policy_remediation.sql, 20260701000003_drop_final_for_all.sql
--   and the migrations that last defined them.
-- * search_path: ALTER FUNCTION <sig> RESET search_path for the nine functions.
