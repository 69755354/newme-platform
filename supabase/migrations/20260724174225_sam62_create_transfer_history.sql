-- Forward-safe baseline required by reassign_lead_atomic.
CREATE TABLE IF NOT EXISTS public.transfer_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  from_user_id uuid REFERENCES public.profiles(id),
  to_user_id uuid NOT NULL REFERENCES public.profiles(id),
  transferred_by uuid NOT NULL REFERENCES public.profiles(id),
  reason text,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transfer_history_lead_id
  ON public.transfer_history (lead_id);

ALTER TABLE public.transfer_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auto_deny_all ON public.transfer_history;
DROP POLICY IF EXISTS policy_transfer_history_select_admin ON public.transfer_history;
DROP POLICY IF EXISTS policy_transfer_history_select_finance ON public.transfer_history;
DROP POLICY IF EXISTS policy_transfer_history_select_designer ON public.transfer_history;
DROP POLICY IF EXISTS policy_transfer_history_select_sales ON public.transfer_history;
DROP POLICY IF EXISTS policy_transfer_history_insert_admin ON public.transfer_history;
DROP POLICY IF EXISTS policy_transfer_history_update_admin ON public.transfer_history;
DROP POLICY IF EXISTS policy_transfer_history_delete_admin ON public.transfer_history;

CREATE POLICY policy_transfer_history_select_admin
  ON public.transfer_history FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator')
  ));

CREATE POLICY policy_transfer_history_select_finance
  ON public.transfer_history FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'finance'
  ));

CREATE POLICY policy_transfer_history_select_designer
  ON public.transfer_history FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'designer'
  ));

CREATE POLICY policy_transfer_history_select_sales
  ON public.transfer_history FOR SELECT TO authenticated
  USING (
    from_user_id = auth.uid()
    OR to_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.leads
      WHERE id = transfer_history.lead_id AND assigned_to = auth.uid()
    )
  );

CREATE POLICY policy_transfer_history_insert_admin
  ON public.transfer_history FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator')
  ));

CREATE POLICY policy_transfer_history_update_admin
  ON public.transfer_history FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss')
  ));

CREATE POLICY policy_transfer_history_delete_admin
  ON public.transfer_history FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss')
  ));

REVOKE ALL ON TABLE public.transfer_history FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.transfer_history TO authenticated;
