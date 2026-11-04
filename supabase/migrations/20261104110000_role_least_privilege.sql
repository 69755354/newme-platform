-- NO_ROLLBACK: this file narrows end-user policies, redefines five money/contract routines (operator stage transitions, admin on the boss approval step, contract activation wins the lead, admin/boss-only contract creation), adds one NOT VALID discount check and wraps the session check in a scalar sub-select; nothing it drops holds data. Manual undo is described at the end of the file.
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
-- 4. One combined release (Sam, 2026-11-04): admin may settle the boss approval
--    step (equal shareholders); converting a quotation no longer wins the lead --
--    the lead moves to pending_decision and is won when the contract is
--    activated; contracts are created by admin/boss only; quotations.discount_rate
--    is checked 0..100 (NOT VALID); every row-level session check is computed once
--    per statement instead of once per row.
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
  -- A lead the writer can see. Written as a subquery on public.leads so the
  -- role's own leads policy (below) is the single definition of "mine", and as a
  -- correlated EXISTS keyed on the row's own lead_id (%s = the table name) so the
  -- database looks up THIS lead only. The earlier `lead_id IN (SELECT l.id FROM
  -- leads l)` made it evaluate the leads policy for every lead in the company
  -- first: about 5 s per activity insert at 10 000 leads (review P-1).
  v_involved_fmt  text := '(EXISTS (SELECT 1 FROM public.leads l WHERE l.id = %s.lead_id))';
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
                     r.pol, r.tbl, v_is_designer, format(v_involved_fmt, r.tbl));
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
      || format(v_involved_fmt, 'activities') || ')';
    EXECUTE 'DROP POLICY IF EXISTS policy_activities_insert_designer_involved ON public.activities';
    EXECUTE 'CREATE POLICY policy_activities_insert_designer_involved ON public.activities FOR INSERT TO authenticated WITH CHECK ('
      || v_is_designer || ' AND user_id = auth.uid() AND ' || format(v_involved_fmt, 'activities') || ')';
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
      || v_is_designer || ' AND ' || format(v_involved_fmt, 'lead_workflow_stages') || ')';
  END IF;

  -- 2h. file records: lead_files_insert_staff let any role attach a record to any
  --     lead as itself; now the lead must be visible to the uploader.
  IF to_regclass('public.lead_files') IS NOT NULL AND v_files_cols THEN
    EXECUTE 'DROP POLICY IF EXISTS lead_files_insert_staff ON public.lead_files';
    EXECUTE 'CREATE POLICY lead_files_insert_staff ON public.lead_files FOR INSERT TO authenticated WITH CHECK ('
      || '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN (''admin'',''boss'',''operator''))) OR '
      || '(uploaded_by = auth.uid() AND ' || format(v_involved_fmt, 'lead_files') || '))';
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
-- 4a. Helper: move a lead to pending_decision, one legal step at a time
-- ---------------------------------------------------------------------------
-- trg_check_stage_sequence() only lets a stage advance by one place, so a lead
-- parked at quotation_submitted reaches pending_decision through negotiation.
-- Leads that are terminal, already at pending_decision, or outside the sequence
-- ('new' must pass the first-contact gate; 'no_answered' and 'fake' are off the
-- ladder) are left exactly where they are. Called only from the two definer
-- routines below, so EXECUTE is withheld from every end-user role.
CREATE OR REPLACE FUNCTION public.advance_lead_to_pending_decision(p_lead_id uuid, p_actor uuid, p_note text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_lead  record;
  v_order text[] := ARRAY['contacted','requirement_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision'];
  v_idx   integer;
  i       integer;
  -- production has leads.stage_changed_at; the replay floor does not
  v_has_changed_at boolean := EXISTS (SELECT 1 FROM information_schema.columns
                                       WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'stage_changed_at');
BEGIN
  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND OR v_lead.final_status IS NOT NULL OR v_lead.stage IN ('won', 'lost', 'pending_decision') THEN
    RETURN false;
  END IF;
  v_idx := array_position(v_order, v_lead.stage);
  IF v_idx IS NULL THEN
    RETURN false;
  END IF;
  FOR i IN v_idx + 1 .. array_length(v_order, 1) LOOP
    UPDATE public.leads SET stage = v_order[i], updated_at = now() WHERE id = p_lead_id;
  END LOOP;
  IF v_has_changed_at THEN
    EXECUTE 'UPDATE public.leads SET stage_changed_at = now() WHERE id = $1' USING p_lead_id;
  END IF;
  INSERT INTO public.business_events (lead_id, user_id, event_type, description, event_data, created_at)
  VALUES (p_lead_id, p_actor, 'stage_change',
          format('Stage changed from %s to pending_decision: %s', v_lead.stage, p_note),
          jsonb_build_object('from', v_lead.stage, 'to', 'pending_decision', 'note', p_note), now());
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.advance_lead_to_pending_decision(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. approve_contract(): the second (boss) step is open to admin as well
-- ---------------------------------------------------------------------------
-- Sam: admin and boss are both shareholders with exactly equal authority. The
-- first step (admin / operator) is unchanged.
create or replace function public.approve_contract(p_contract_id uuid, p_approver_id uuid, p_action text, p_notes text DEFAULT NULL::text)
returns jsonb
 language plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_contract   record;
  v_actor      uuid;
  v_step       text;
  v_new_status text;
  v_approval   record;
begin
  perform public.assert_current_session_at_entry();
  if p_action is null or p_action not in ('approve', 'reject') then
    raise exception 'action must be approve or reject' using errcode = '22023';
  end if;

  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'contract not found' using errcode = 'P0002';
  end if;

  -- The step comes from the contract's own status, not from the earliest
  -- pending approval row and not from the caller's role. Then the role is
  -- checked against the step.
  if v_contract.status = 'pending_admin' then
    v_step := 'admin_review';
    v_actor := public.money_actor(p_approver_id, array['admin', 'operator']);
  elsif v_contract.status = 'pending_ceo' then
    v_step := 'ceo_review';
    -- S2: admin and boss are equal shareholders; either may settle the boss step.
    v_actor := public.money_actor(p_approver_id, array['admin', 'boss']);
  else
    raise exception 'contract is not awaiting approval (status %)', v_contract.status
      using errcode = '22023';
  end if;

  -- Settle the pending row for THIS step rather than appending a new one. The
  -- append-only version left 'admin_review' pending forever, which is what made
  -- the ceo_review step unreachable.
  select * into v_approval
    from public.contract_approvals
   where contract_id = p_contract_id and step = v_step and status = 'pending'
   order by created_at asc, id asc
   for update
   limit 1;

  if found then
    update public.contract_approvals
       set status      = case when p_action = 'approve' then 'approved' else 'rejected' end,
           approver_id = v_actor,
           reviewed_at = now(),
           notes       = coalesce(notes, '{}'::jsonb)
                         || jsonb_build_object('decision_notes', p_notes)
     where id = v_approval.id;
  else
    -- No pending row: a contract that reached this status before this migration
    -- existed. Record the decision so the trail is complete instead of failing.
    insert into public.contract_approvals (contract_id, step, approver_id, status, notes, reviewed_at)
    values (p_contract_id, v_step, v_actor,
            case when p_action = 'approve' then 'approved' else 'rejected' end,
            jsonb_build_object('decision_notes', p_notes, 'backfilled', true), now());
  end if;

  if p_action = 'approve' then
    if v_step = 'admin_review' then
      v_new_status := 'pending_ceo';
      -- Open the next step explicitly, so the boss has a row to settle.
      if not exists (
        select 1 from public.contract_approvals
         where contract_id = p_contract_id and step = 'ceo_review' and status = 'pending'
      ) then
        insert into public.contract_approvals (contract_id, step, status, notes)
        values (p_contract_id, 'ceo_review', 'pending',
                jsonb_build_object('source', 'admin_review_approved'));
      end if;
    else
      v_new_status := 'approved';
    end if;
  else
    v_new_status := 'rejected';
  end if;

  update public.contracts
     set status = v_new_status, updated_at = now()
   where id = p_contract_id;

  return jsonb_build_object(
    'success',    true,
    'action',     case when p_action = 'approve' then 'approved' else 'rejected' end,
    'new_status', v_new_status,
    'step',       v_step,
    'actor_id',   v_actor
  );
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. set_contract_status(): activating a contract is what wins the lead
-- ---------------------------------------------------------------------------
create or replace function public.set_contract_status(p_contract_id uuid, p_status text, p_reason text DEFAULT NULL::text)
returns jsonb
 language plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_contract record;
  v_actor    uuid;
  v_role     text;
  v_is_owner boolean;
  v_lead     record;
  v_lead_id  uuid;
  v_customer_id uuid;
  v_has_changed_at boolean := exists (select 1 from information_schema.columns
                                       where table_schema = 'public' and table_name = 'leads' and column_name = 'stage_changed_at');
begin
  perform public.assert_current_session_at_entry();
  -- Activation wins the lead, so the lead is locked BEFORE the contract: the same
  -- order convert_quotation_to_contract() uses (quotations -> leads -> contracts).
  if p_status = 'active' then
    select lead_id into v_lead_id from public.contracts where id = p_contract_id;
    if v_lead_id is not null then
      perform 1 from public.leads where id = v_lead_id for update;
    end if;
  end if;

  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'contract not found' using errcode = 'P0002';
  end if;

  if p_status = 'active' and v_contract.lead_id is distinct from v_lead_id then
    raise exception 'contract lead changed while activating; retry' using errcode = '40001';
  end if;

  v_actor := public.money_actor(null, array['admin', 'boss', 'operator', 'finance', 'sales']);
  select role into v_role from public.profiles where id = v_actor;
  -- money_actor() has already refused a NULL role against that list, so v_role
  -- is non-null here; the coalesce is what keeps every `not in` below from
  -- evaluating to NULL if that ever stops being true.
  v_role     := coalesce(v_role, '');
  v_is_owner := v_contract.sales_id = v_actor;

  -- The approval statuses are not reachable here: 'approved' and 'pending_ceo'
  -- belong to approve_contract(), and 'superseded' to revoke_contract().
  if p_status not in ('draft', 'pending_admin', 'active', 'completed', 'suspended', 'terminated') then
    raise exception '% is not a status this operation may set', p_status
      using errcode = '22023';
  end if;
  if not public.contract_transition_is_allowed(v_contract.status, p_status) then
    raise exception '% is not a permitted transition from %', p_status, v_contract.status
      using errcode = '22023';
  end if;

  if p_status in ('draft', 'pending_admin') then
    if not (v_is_owner or v_role in ('admin', 'boss', 'operator')) then
      raise exception 'only the contract owner or a manager may submit or reopen a contract'
        using errcode = '42501';
    end if;
  elsif p_status in ('active', 'completed') then
    if v_role not in ('admin', 'boss', 'operator', 'finance') then
      raise exception 'only a manager may activate or complete a contract' using errcode = '42501';
    end if;
  elsif p_status = 'suspended' then
    if v_role not in ('admin', 'boss') then
      raise exception 'only admin or boss may suspend a contract' using errcode = '42501';
    end if;
  else
    -- terminated
    if v_role not in ('admin', 'boss') then
      raise exception 'only admin or boss may terminate a contract' using errcode = '42501';
    end if;
    if p_reason is null or btrim(p_reason) = '' then
      raise exception 'a reason is required to terminate a contract' using errcode = '22023';
    end if;
  end if;

  -- S2: the contract being activated is the moment the lead is won. Convert-to-
  -- contract only parks the lead at pending_decision. Idempotent: a repeat or a
  -- resume from 'suspended' finds the lead already won, the customer already
  -- linked and the project already present, and changes nothing.
  if p_status = 'active' and v_contract.lead_id is not null then
    select * into v_lead from public.leads where id = v_contract.lead_id;
    if found then
      if v_lead.final_status = 'lost' or v_lead.stage = 'lost' then
        raise exception 'the lead of this contract is marked lost; it cannot be won by activating the contract'
          using errcode = '22023';
      end if;
      -- A lead still at 'new' cannot change stage until its first contact is on
      -- record (trg_check_first_contact_gate); activating a contract must not be
      -- blocked by that, so such a lead is marked won (final_status) and keeps its
      -- stage, exactly as the old conversion did.
      if v_lead.final_status is distinct from 'won'
         or (v_lead.stage is distinct from 'won' and v_lead.stage <> 'new') then
        update public.leads
           set stage = case when v_lead.stage = 'new' then v_lead.stage else 'won' end,
               final_status = 'won', updated_at = now()
         where id = v_lead.id;
        if v_has_changed_at then
          execute 'update public.leads set stage_changed_at = now() where id = $1' using v_lead.id;
        end if;
        insert into public.business_events (lead_id, user_id, event_type, description, event_data, created_at)
        values (v_lead.id, v_actor, 'stage_change',
                format('Lead won (stage was %s): contract %s activated', v_lead.stage, v_contract.contract_no),
                jsonb_build_object('from', v_lead.stage, 'to', 'won', 'contract_id', v_contract.id,
                                   'note', 'contract activation'), now());
      end if;
      v_customer_id := public.finalize_lead_won(
        v_lead.id, coalesce(v_contract.contract_amount, 0), v_actor, 'contract_activation',
        jsonb_build_object('contract_id', v_contract.id, 'contract_no', v_contract.contract_no));
      update public.contracts set customer_id = v_customer_id, updated_at = now()
       where id = v_contract.id and customer_id is null;
      if to_regclass('public.projects') is not null
         and not exists (select 1 from public.projects where contract_id = v_contract.id) then
        insert into public.projects (
          customer_id, lead_id, contract_id, sales_id,
          name, property_type, property_size, location,
          phase, status, contract_amount
        ) values (
          coalesce(v_customer_id, v_lead.customer_id), v_lead.id, v_contract.id,
          coalesce(v_contract.sales_id, v_actor),
          coalesce(nullif(v_lead.customer_name, ''), 'Client') || ' - '
            || coalesce(nullif(v_lead.property_type, ''), 'Smart Home'),
          v_lead.property_type, v_lead.property_size_sqm, v_lead.location,
          'design', 'active', v_contract.contract_amount
        );
      end if;
    end if;
  end if;

  if p_status = 'terminated' then
    update public.contracts
       set status = p_status, terminated_reason = p_reason, terminated_at = now(), updated_at = now()
     where id = p_contract_id;
  else
    update public.contracts
       set status = p_status, updated_at = now()
     where id = p_contract_id;
  end if;

  return jsonb_build_object(
    'success',         true,
    'id',              p_contract_id,
    'previous_status', v_contract.status,
    'status',          p_status,
    'actor_id',        v_actor
  );
end
$function$;

-- ---------------------------------------------------------------------------
-- 6. convert_quotation_to_contract(): no longer wins the lead; admin/boss only
-- ---------------------------------------------------------------------------
-- Converting a quotation creates the draft contract, its schedule and approval
-- row and moves the lead to pending_decision. The customer, the project and the
-- won state arrive when set_contract_status() activates the contract. The retry
-- branch finishes only what the conversion itself writes. Contract creation is
-- limited to admin / boss, the same as the screens.
create or replace function public.convert_quotation_to_contract(p_quotation_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
returns jsonb
 language plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_actor        uuid;
  v_actor_role   text;
  v_quote        record;
  v_lead         record;
  v_contract     record;
  v_contract_id  uuid;
  v_contract_no  text;
  v_date         date := current_date;
  v_attempt      integer := 0;
  v_inst         jsonb;
  v_inst_count   integer := 0;
  v_customer_id  uuid;
  v_project_id   uuid;
  v_finalized    text[] := '{}';
  v_sched_count  bigint;
  v_sched_total  numeric(12, 2);
  v_disagree     bigint;
  v_status       text;
  v_lead_final   text;
begin
  perform public.assert_current_session_at_entry();
  v_actor := public.money_actor(
    nullif(p_payload ->> 'actor_id', '')::uuid,
    array['admin', 'boss']);
  select coalesce(role, '') into v_actor_role from public.profiles where id = v_actor;

  select * into v_quote from public.quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'quotation not found' using errcode = 'P0002';
  end if;
  v_status := v_quote.status;

  -- R4: `for update`. Both branches write this row — the first conversion sets
  -- final_status, the retry repairs it — and taking the lock here is what makes
  -- the lock order quotations → leads → contracts on both paths. See the header.
  select * into v_lead from public.leads where id = v_quote.lead_id for update;

  if v_actor_role not in ('admin', 'boss', 'operator')
     and v_quote.created_by is distinct from v_actor then
    raise exception 'only the quotation owner or a manager may convert it' using errcode = '42501';
  end if;

  -- ── The idempotent branch: this quotation already has its contract ────────
  if v_quote.contract_id is not null then
    select * into v_contract from public.contracts where id = v_quote.contract_id for update;
    if not found then
      -- A link to a contract that does not exist is corruption, not a retry.
      raise exception 'quotation % is linked to a contract that does not exist', v_quote.quote_no
        using errcode = '22023';
    end if;

    -- B5. Every invariant the first conversion establishes, re-checked before this
    -- branch acts on the link. A retry may only finish the conversion it started;
    -- it may not adopt somebody else's contract. Each condition is reported
    -- separately because "this retry is not a retry" is an operator's problem and
    -- a single generic message would not tell them which fact disagrees.
    if v_contract.quotation_id is distinct from v_quote.id then
      raise exception 'quotation % is linked to contract %, which names quotation % as its source; refusing to act on a crossed link',
        v_quote.quote_no, v_contract.contract_no, coalesce(v_contract.quotation_id::text, 'no quotation')
        using errcode = '22023';
    end if;
    if v_contract.lead_id is distinct from v_quote.lead_id then
      raise exception 'quotation % is linked to contract %, which belongs to a different lead; refusing to act on a crossed link',
        v_quote.quote_no, v_contract.contract_no using errcode = '22023';
    end if;
    if round(coalesce(v_contract.contract_amount, 0), 2) <> round(coalesce(v_quote.total_amount, 0), 2) then
      raise exception 'quotation % totals % but its contract % totals %; reconcile them before finishing the conversion',
        v_quote.quote_no, to_char(coalesce(v_quote.total_amount, 0), 'FM999999999990.00'),
        v_contract.contract_no, to_char(coalesce(v_contract.contract_amount, 0), 'FM999999999990.00')
        using errcode = '22023';
    end if;
    if v_contract.status in ('terminated', 'rejected', 'superseded') then
      raise exception 'contract % is % ; a terminated or superseded contract is not finished by retrying the conversion that made it',
        v_contract.contract_no, v_contract.status using errcode = '22023';
    end if;

    -- And the schedule, which the first conversion wrote in the same transaction as
    -- the contract. Missing or unequal here means the row was not written by this
    -- routine at all.
    select count(*), coalesce(sum(amount), 0)
      into v_sched_count, v_sched_total
      from public.installment_plans where contract_id = v_contract.id;
    if v_sched_count = 0 then
      raise exception 'contract % has no installment schedule; it was not created by a conversion of quotation %',
        v_contract.contract_no, v_quote.quote_no using errcode = '22023';
    end if;
    if round(v_sched_total, 2) <> round(coalesce(v_contract.contract_amount, 0), 2) then
      raise exception 'contract % has a schedule totalling % against a contract of %; reconcile it before finishing the conversion',
        v_contract.contract_no, to_char(v_sched_total, 'FM999999999990.00'),
        to_char(coalesce(v_contract.contract_amount, 0), 'FM999999999990.00')
        using errcode = '22023';
    end if;

    -- B5, the other half of "this retry is not a retry". Everything above
    -- establishes that the stored state is self-consistent; none of it looks at
    -- the payload this call carries. A retry asking for a different schedule, or
    -- a different first payment date, is a different request wearing an
    -- already-converted quotation's id, and answering it with success: true is
    -- how a caller comes to believe a schedule it never got was written.
    --
    -- Only checked when the payload actually carries a schedule. A repair call
    -- and the release assertions reach this branch with '{}' deliberately, and
    -- "finish what the first attempt left" must stay callable without restating
    -- a schedule that is already in the table.
    if jsonb_typeof(p_payload -> 'installments') = 'array'
       and jsonb_array_length(p_payload -> 'installments') > 0 then
      -- Shape and total first, by the same validator the first conversion used,
      -- so a malformed retry is refused with 22023 naming the installment rather
      -- than with a bare cast error from the comparison below.
      perform public.assert_installment_schedule(
        p_payload -> 'installments', v_contract.contract_amount, 'quotation');

      select count(*) into v_disagree
        from (select coalesce(nullif(e.value ->> 'seq', '')::integer, e.ord::integer) as seq,
                     round((e.value ->> 'amount')::numeric(12, 2), 2)                as amount,
                     coalesce(nullif(e.value ->> 'due_date', '')::date,
                              v_contract.contract_date)                              as due_date,
                     coalesce(e.value ->> 'description', '')                         as description
                from jsonb_array_elements(p_payload -> 'installments')
                       with ordinality e(value, ord)) want
        full join (select seq, round(amount, 2) as amount, due_date,
                          coalesce(description, '') as description
                     from public.installment_plans
                    where contract_id = v_contract.id) have on have.seq = want.seq
       where want.seq is null or have.seq is null
          or want.amount is distinct from have.amount
          or want.due_date is distinct from have.due_date
          or want.description is distinct from have.description;
      if v_disagree > 0 then
        raise exception 'quotation % is already converted to contract %, whose schedule is not the one this call asks for (% installment(s) disagree); a retry may only repeat the conversion it retries',
          v_quote.quote_no, v_contract.contract_no, v_disagree using errcode = '22023';
      end if;
    end if;

    if nullif(p_payload ->> 'first_payment_due_date', '') is not null
       and nullif(p_payload ->> 'first_payment_due_date', '')::date
           is distinct from v_contract.first_payment_due_date then
      raise exception 'quotation % is already converted to contract %, whose first payment is due % and not %; a retry may only repeat the conversion it retries',
        v_quote.quote_no, v_contract.contract_no,
        coalesce(v_contract.first_payment_due_date::text, 'unset'),
        nullif(p_payload ->> 'first_payment_due_date', '') using errcode = '22023';
    end if;

    v_contract_id := v_contract.id;
    v_contract_no := v_contract.contract_no;

    -- R4. Past every refusal, this call is a retry of this conversion, so the rest
    -- of this branch is the conversion's remaining work rather than a subset of it.
    -- The quotation's own status first, in the same order the first conversion
    -- writes it. The link is definer-only (trg_guard_quotations_write); the status
    -- beside it is not, so it can disagree with the link, and the caller was being
    -- handed that stale value as `quotation_status`.
    if v_status is distinct from 'contract_created' then
      update public.quotations
         set status = 'contract_created', updated_at = now()
       where id = p_quotation_id;
      v_status := 'contract_created';
      v_finalized := array_append(v_finalized, 'quotation_status');
    end if;

    if v_quote.lead_id is not null then
      -- A retry finishes the conversion; it never wins the lead (that happens when
      -- the contract is activated) and it does not overrule a lost lead.
      v_lead_final := v_lead.final_status;
      if v_lead_final = 'lost' then
        raise exception 'quotation % is converted to contract %, but its lead is marked lost; a retry finishes a conversion, it does not overrule a terminal decision on the lead',
          v_quote.quote_no, v_contract_no using errcode = '22023';
      end if;
      if public.advance_lead_to_pending_decision(v_quote.lead_id, v_actor,
           'Quotation ' || coalesce(v_quote.quote_no, '') || ' converted to contract ' || v_contract_no) then
        v_finalized := array_append(v_finalized, 'lead_stage');
      end if;
      v_customer_id := v_lead.customer_id;
    end if;

    if not exists (select 1 from public.contract_approvals
                    where contract_id = v_contract_id and step = 'admin_review') then
      -- 'quotation_finalize', not 'quotation': the provenance of an approval row
      -- created by a repair is not the provenance of one created by the conversion,
      -- and this row is the only place that difference is recorded.
      insert into public.contract_approvals (contract_id, step, status, notes)
      values (v_contract_id, 'admin_review', 'pending',
              jsonb_build_object('source', 'quotation_finalize', 'quotation_id', v_quote.id));
      v_finalized := array_append(v_finalized, 'approval');
    end if;

    if to_regclass('public.projects') is not null then
      -- Read only: the project belongs to contract activation now.
      select id into v_project_id from public.projects
       where contract_id = v_contract_id order by id asc limit 1;
    end if;

    if not exists (
      select 1 from public.activities
       where lead_id = v_quote.lead_id
         and content like '%' || v_contract_no || '%'
    ) then
      insert into public.activities (lead_id, user_id, type, content, ai_generated)
      values (v_quote.lead_id, v_actor, 'note',
              'Contract ' || v_contract_no || ' created from quotation ' || v_quote.quote_no
              || ' (pending admin review)', true);
      v_finalized := array_append(v_finalized, 'activity');
    end if;

    return jsonb_build_object(
      'success',            true,
      'already_converted',  true,
      'contract_id',        v_contract_id,
      'contract_no',        v_contract_no,
      'quotation_status',   v_status,
      'project_id',         v_project_id,
      'customer_id',        v_customer_id,
      'installments_count', (select count(*) from public.installment_plans
                              where contract_id = v_contract_id),
      'finalized',          to_jsonb(v_finalized),
      'actor_id',           v_actor
    );
  end if;

  -- ── The first conversion ─────────────────────────────────────────────────
  if v_quote.status <> 'accepted' then
    raise exception 'only an accepted quotation can be converted (status %)', v_quote.status
      using errcode = '22023';
  end if;
  if not (coalesce(v_quote.total_amount, 0) > 0) then
    raise exception 'quotation total must be greater than zero' using errcode = '22023';
  end if;

  -- The installment invariant, checked before the first write. B10: the one cent
  -- of tolerance this used to allow is gone; see assert_installment_schedule().
  -- The coalesce inside it is still load-bearing for the same reason it was here —
  -- `jsonb_typeof('{}'::jsonb -> 'installments')` is NULL and `NULL <> 'array'` is
  -- NULL, so a bare comparison lets a POST with no body fall through and be
  -- refused with the wrong reason.
  v_inst_count := public.assert_installment_schedule(
    p_payload -> 'installments', v_quote.total_amount, 'quotation');
  v_inst_count := 0;

  loop
    v_attempt     := v_attempt + 1;
    v_contract_no := public.next_contract_no(v_date);
    begin
      insert into public.contracts (
        lead_id, quotation_id, sales_id, created_by, contract_no, contract_date,
        contract_amount, currency, party_a_name, party_b_name, status,
        first_payment_due_date
      ) values (
        v_quote.lead_id, v_quote.id, coalesce(v_quote.created_by, v_actor), v_actor,
        v_contract_no, v_date, v_quote.total_amount,
        coalesce(nullif(v_quote.currency, ''), 'AED'),
        coalesce(nullif(v_lead.customer_name, ''), 'Unknown'),
        'NewMe Smart Home FZCO',
        'draft',
        nullif(p_payload ->> 'first_payment_due_date', '')::date
      )
      returning id into v_contract_id;
      exit;
    exception
      when unique_violation then
        if v_attempt >= 10 then
          raise;
        end if;
    end;
  end loop;

  for v_inst in select value from jsonb_array_elements(p_payload -> 'installments') loop
    insert into public.installment_plans (contract_id, seq, amount, due_date, description, status)
    values (
      v_contract_id,
      coalesce(nullif(v_inst ->> 'seq', '')::integer, v_inst_count + 1),
      (v_inst ->> 'amount')::numeric(12, 2),
      coalesce(nullif(v_inst ->> 'due_date', '')::date, v_date),
      coalesce(v_inst ->> 'description', ''),
      'pending'
    );
    v_inst_count := v_inst_count + 1;
  end loop;

  insert into public.contract_approvals (contract_id, step, status, notes)
  values (v_contract_id, 'admin_review', 'pending',
          jsonb_build_object('source', 'quotation', 'quotation_id', v_quote.id));

  update public.quotations
     set status      = 'contract_created',
         contract_id = v_contract_id,
         updated_at  = now()
   where id = p_quotation_id;

  if v_quote.lead_id is not null then
    -- S2: converting does not win the lead. It moves to pending_decision and the
    -- win (customer, project, won event) happens when the contract is activated.
    perform public.advance_lead_to_pending_decision(v_quote.lead_id, v_actor,
      'Quotation ' || coalesce(v_quote.quote_no, '') || ' converted to contract ' || v_contract_no);
  end if;

  -- no project yet: it is created when the contract is activated

  insert into public.activities (lead_id, user_id, type, content, ai_generated)
  values (v_quote.lead_id, v_actor, 'note',
          'Contract ' || v_contract_no || ' created from quotation ' || v_quote.quote_no
          || ' (pending admin review)', true);

  return jsonb_build_object(
    'success',            true,
    'already_converted',  false,
    'contract_id',        v_contract_id,
    'contract_no',        v_contract_no,
    'quotation_status',   'contract_created',
    'installments_count', v_inst_count,
    'project_id',         v_project_id,
    'customer_id',        v_customer_id,
    'actor_id',           v_actor
  );
end
$function$;

-- ---------------------------------------------------------------------------
-- 7. create_contract(): admin / boss only
-- ---------------------------------------------------------------------------
create or replace function public.create_contract(p_payload jsonb)
returns jsonb
 language plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_actor       uuid;
  v_role        text;
  v_lead        record;
  v_lead_id     uuid;
  v_amount      numeric(12, 2);
  v_date        date := current_date;
  v_contract_id uuid;
  v_contract_no text;
  v_attempt     integer := 0;
  v_inst        jsonb;
  v_inst_count  integer := 0;
  v_existing    record;
begin
  perform public.assert_current_session_at_entry();
  v_actor := public.money_actor(
    nullif(p_payload ->> 'actor_id', '')::uuid,
    array['admin', 'boss']);
  select coalesce(role, '') into v_role from public.profiles where id = v_actor;

  v_lead_id := nullif(p_payload ->> 'lead_id', '')::uuid;
  if v_lead_id is null then
    raise exception 'lead_id is required' using errcode = '22023';
  end if;
  v_amount := nullif(p_payload ->> 'amount', '')::numeric(12, 2);
  if v_amount is null or v_amount <= 0 then
    raise exception 'a positive amount is required' using errcode = '22023';
  end if;

  -- The check this function never had. It accepted any lead UUID, so a sales
  -- user could create a contract against a colleague's lead — and because there
  -- is one active contract per lead, doing so also took that lead's only slot.
  -- Read with the definer's visibility on purpose: a sales user cannot see
  -- someone else's lead, and a "not found" that really means "not yours" is the
  -- shape that produced a 500 from the unique index instead of a decision.
  select id, assigned_to into v_lead from public.leads where id = v_lead_id;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if v_role not in ('admin', 'boss', 'operator', 'finance')
     and v_lead.assigned_to is distinct from v_actor then
    raise exception 'only the assigned salesperson or a manager may create a contract for this lead'
      using errcode = '42501';
  end if;

  select id, contract_no into v_existing
    from public.contracts
   where lead_id = v_lead_id
     and status not in ('archived', 'cancelled', 'terminated')
   order by created_at asc
   limit 1;
  if found then
    raise exception 'contract % already exists for this lead', v_existing.contract_no
      using errcode = '23505';
  end if;

  -- B4. Before the first write, so a rejected schedule consumes no contract
  -- number and leaves no contract behind. A contract with no schedule is not a
  -- contract with an empty schedule: nothing can ever collect against it, and
  -- first_payment_status is pinned at 'unpaid' for the rest of its life.
  perform public.assert_installment_schedule(p_payload -> 'installments', v_amount, 'contract');

  loop
    v_attempt    := v_attempt + 1;
    v_contract_no := public.next_contract_no(v_date);
    begin
      insert into public.contracts (
        lead_id, sales_id, created_by, contract_no, contract_date, contract_amount,
        currency, party_a_name, party_a_contact, party_b_name, status,
        first_payment_due_date
      ) values (
        v_lead_id, v_actor, v_actor, v_contract_no, v_date, v_amount,
        coalesce(nullif(p_payload ->> 'currency', ''), 'AED'),
        coalesce(nullif(p_payload ->> 'party_a_name', ''), 'Unknown'),
        nullif(p_payload ->> 'party_a_contact', ''),
        coalesce(nullif(p_payload ->> 'party_b_name', ''), 'NewMe Smart Home FZCO'),
        'draft',
        nullif(p_payload ->> 'first_payment_due_date', '')::date
      )
      returning id into v_contract_id;
      exit;
    exception
      when unique_violation then
        if v_attempt >= 10 then
          raise;
        end if;
    end;
  end loop;

  -- No coalesce-to-zero on the amount any more: the validator has established
  -- that every element carries a positive one, so defaulting a missing amount to
  -- 0 here would only be able to hide a validator that stopped working.
  for v_inst in select value from jsonb_array_elements(p_payload -> 'installments') loop
    insert into public.installment_plans (contract_id, seq, amount, due_date, description, status)
    values (
      v_contract_id,
      coalesce(nullif(v_inst ->> 'seq', '')::integer, v_inst_count + 1),
      (v_inst ->> 'amount')::numeric(12, 2),
      coalesce(nullif(v_inst ->> 'due_date', '')::date, v_date),
      coalesce(v_inst ->> 'description', ''),
      'pending'
    );
    v_inst_count := v_inst_count + 1;
  end loop;

  insert into public.contract_approvals (contract_id, step, status, notes)
  values (v_contract_id, 'admin_review', 'pending', jsonb_build_object('source', 'auto_created'));

  return jsonb_build_object(
    'success',           true,
    'id',                v_contract_id,
    'contract_no',       v_contract_no,
    'status',            'draft',
    'installments_count', v_inst_count,
    'actor_id',          v_actor
  );
end
$function$;

-- ---------------------------------------------------------------------------
-- 8. Contracts are created by admin / boss only (Sam: finance and designer get
--    the strictest reading, and the screens already show the button to nobody else)
-- ---------------------------------------------------------------------------
-- The direct-insert policies for finance, sales and operator are removed and the
-- admin one narrowed to admin / boss. Direct inserts are anyway refused once the
-- contract phase is on (guard_contracts_write); this keeps the policy layer
-- consistent with it. The definer routines above are the supported way in.
DO $$
BEGIN
  IF to_regclass('public.contracts') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS policy_contracts_insert_finance ON public.contracts';
    EXECUTE 'DROP POLICY IF EXISTS policy_contracts_insert_sales ON public.contracts';
    EXECUTE 'DROP POLICY IF EXISTS policy_contracts_insert_admin ON public.contracts';
    EXECUTE 'CREATE POLICY policy_contracts_insert_admin ON public.contracts FOR INSERT TO authenticated WITH CHECK ('
      || '(EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN (''admin'',''boss''))))';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 9. Quotation discount stays within 0..100 (Sam: old test rows are not cleaned)
-- ---------------------------------------------------------------------------
-- NOT VALID: new and updated rows are checked, existing rows are not scanned, so
-- the migration cannot be blocked by an old out-of-range draft. (Such a row can
-- only be edited after its discount is brought into range.)
DO $$
BEGIN
  IF to_regclass('public.quotations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'quotations' AND column_name = 'discount_rate')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'public.quotations'::regclass AND conname = 'quotations_discount_rate_range') THEN
    EXECUTE 'ALTER TABLE public.quotations ADD CONSTRAINT quotations_discount_rate_range CHECK (discount_rate BETWEEN 0 AND 100) NOT VALID';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 10. Compute the session check once per statement, not once per row
-- ---------------------------------------------------------------------------
-- Every restrict_*_active_session policy called session_token_is_current() for
-- each row (about 0.5 ms each): 5.3 s to count 10 000 leads, 0.04 s once
-- wrapped in a scalar sub-select. Only that wrapper changes; roles, command,
-- permissive/restrictive and the rest of each expression are untouched
-- (tests/database/policy-equivalence.py proves it policy by policy). Must stay the
-- LAST policy-touching step so it also covers anything created above.
DO $$
DECLARE
  r record;
  v_using text;
  v_check text;
  v_sql   text;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch, c.relname AS tbl, p.polname AS pol,
           pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       -- profiles is left alone: its own policies sub-select profiles, and a
       -- sub-select inside a profiles policy makes the planner report "infinite
       -- recursion detected in policy" when the table is updated. It is a few dozen
       -- rows, so the per-row call costs nothing there.
       AND c.relname <> 'profiles'
       AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'session_token_is_current[(][)]'
         OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'session_token_is_current[(][)]')
     ORDER BY c.relname, p.polname
  LOOP
    -- already wrapped (deparsed as "( SELECT session_token_is_current() AS ...)")
    IF coalesce(r.q, '') !~* 'select[[:space:]]+(public[.])?session_token_is_current[(][)]'
       AND coalesce(r.w, '') !~* 'select[[:space:]]+(public[.])?session_token_is_current[(][)]' THEN
      v_using := CASE WHEN r.q IS NULL THEN NULL
                 ELSE regexp_replace(r.q, '(public[.])?session_token_is_current[(][)]', '(select public.session_token_is_current())', 'g') END;
      v_check := CASE WHEN r.w IS NULL THEN NULL
                 ELSE regexp_replace(r.w, '(public[.])?session_token_is_current[(][)]', '(select public.session_token_is_current())', 'g') END;
      v_sql := format('ALTER POLICY %I ON %I.%I', r.pol, r.sch, r.tbl)
            || CASE WHEN v_using IS NULL THEN '' ELSE ' USING (' || v_using || ')' END
            || CASE WHEN v_check IS NULL THEN '' ELSE ' WITH CHECK (' || v_check || ')' END;
      EXECUTE v_sql;
    END IF;
  END LOOP;
END
$$;


-- ---------------------------------------------------------------------------
-- 11. Audit a role change made straight in the database (S7 monitoring plan)
-- ---------------------------------------------------------------------------
-- The application already logs account creation and role assignment. A change of
-- profiles.role that does not come through it (console, SQL, a service key) left
-- no trace. This writes one audit_logs row per changed role: the executing
-- identity's id only (no email, no name); actor_id NULL means the server or the
-- console changed it directly.
CREATE OR REPLACE FUNCTION public.audit_profile_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, details)
    VALUES (auth.uid(), 'role_changed', 'user', NEW.id,
            jsonb_build_object('previous_role', OLD.role, 'new_role', NEW.role));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.audit_profile_role_change() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL AND to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS profiles_role_audit ON public.profiles';
    EXECUTE 'CREATE TRIGGER profiles_role_audit AFTER UPDATE OF role ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.audit_profile_role_change()';
  END IF;
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
-- * approve_contract / set_contract_status / convert_quotation_to_contract /
--   create_contract: re-run the bodies from 20260812000000, 20260814000000,
--   20260817170000 and 20260812000000 respectively (boss-only second step; no
--   lead win on activation; conversion wins the lead; five-role create). DROP
--   FUNCTION public.advance_lead_to_pending_decision(uuid, uuid, text).
--   Leads that were moved to pending_decision or won by these routines keep that
--   state (stage_change / won events record it); nothing is deleted.
-- * contracts insert policies: re-create policy_contracts_insert_finance
--   (role finance), policy_contracts_insert_sales (sales_id = auth.uid()) and widen
--   policy_contracts_insert_admin to admin/boss/operator.
-- * discount check: ALTER TABLE public.quotations DROP CONSTRAINT quotations_discount_rate_range.
-- * session wrapper: ALTER POLICY each restrict_*_active_session back to the bare
--   session_token_is_current() (semantics identical either way).
-- * role audit: DROP TRIGGER profiles_role_audit ON public.profiles; DROP FUNCTION public.audit_profile_role_change();
--   (audit rows already written stay).
