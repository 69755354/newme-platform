-- CI-only contract baseline. Never deploy this file to a linked project.
-- Provenance is fail-closed in ../../PROVENANCE.md.

CREATE SCHEMA IF NOT EXISTS ci_gate;

CREATE TABLE ci_gate.seed_markers (
  marker text PRIMARY KEY,
  seeded_at timestamptz NOT NULL DEFAULT now()
);

-- Contract slice derived from the production history identified in
-- ../../PROVENANCE.md. Only columns required by the task-followup invariant and
-- its current RLS policies are represented here.
CREATE TABLE public.profiles (
  -- No auth.users FK is asserted by this narrowed baseline: the recorded live
  -- cleanup state (Auth absent while inactive profiles remained) disproves the
  -- legacy init migration's ON DELETE CASCADE assumption.
  id uuid PRIMARY KEY,
  role text NOT NULL DEFAULT 'sales'
    CHECK (role IN ('admin', 'boss', 'operator', 'sales')),
  full_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'other',
  stage text NOT NULL DEFAULT 'new',
  customer_name text,
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  next_action text,
  next_followup_date timestamptz,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  title text NOT NULL,
  assignee_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'cancelled')),
  source text DEFAULT 'manual'
    CHECK (source IN ('manual', 'follow_up', 'cron', 'system')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_lead ON public.tasks(lead_id);
CREATE INDEX idx_tasks_assignee ON public.tasks(assignee_id);
CREATE INDEX idx_tasks_due ON public.tasks(due_at) WHERE status = 'pending';

-- Verbatim production-observed function body from Git blob
-- 720eb923c79e661c2283bf011687bb08be11d9b5.
CREATE OR REPLACE FUNCTION public.enforce_followup_required()
RETURNS trigger AS $function$
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
$function$ LANGUAGE plpgsql;

-- Trigger name and BEFORE INSERT/UPDATE binding are independently recorded by
-- Git blobs 720eb923c79e661c2283bf011687bb08be11d9b5 and the schema facts source
-- listed in ../../PROVENANCE.md.
CREATE TRIGGER trg_enforce_followup
  BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_followup_required();

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Verbatim task policy predicates from Git blob
-- c0f82e4efdc50e8015fe5d5da58f9611052cf321.
CREATE POLICY policy_tasks_select_admin
  ON public.tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

CREATE POLICY policy_tasks_select_operator
  ON public.tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'operator'));

CREATE POLICY policy_tasks_select_sales
  ON public.tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.leads WHERE id = tasks.lead_id AND assigned_to = auth.uid()));

CREATE POLICY policy_tasks_insert_admin
  ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

CREATE POLICY policy_tasks_insert_operator
  ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'operator'));

CREATE POLICY policy_tasks_insert_sales
  ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.leads WHERE id = tasks.lead_id AND assigned_to = auth.uid()));

CREATE POLICY policy_tasks_update_admin
  ON public.tasks FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

CREATE POLICY policy_tasks_update_operator
  ON public.tasks FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'operator'));

CREATE POLICY policy_tasks_update_sales
  ON public.tasks FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.leads WHERE id = tasks.lead_id AND assigned_to = auth.uid()));

CREATE POLICY policy_tasks_delete_admin
  ON public.tasks FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

CREATE POLICY policy_tasks_delete_operator
  ON public.tasks FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'operator'));

CREATE POLICY policy_tasks_delete_sales
  ON public.tasks FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.leads WHERE id = tasks.lead_id AND assigned_to = auth.uid()));

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON public.profiles, public.leads TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
