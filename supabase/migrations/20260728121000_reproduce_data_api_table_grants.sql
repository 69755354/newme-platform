-- Supabase projects created with explicit Data API grants do not inherit the
-- broad legacy ACLs present on the shared staging project. Keep RLS as the row
-- boundary while making the current application table surface reproducible.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Authenticated application tables. RLS remains enabled and decides which rows
-- each signed-in user may read or mutate.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.activities,
  public.ad_spend,
  public.business_events,
  public.contract_approvals,
  public.contracts,
  public.crm_daily_funnel_snapshot,
  public.customers,
  public.follow_up_logs,
  public.installment_plans,
  public.knx_designs,
  public.kpi_targets,
  public.lead_assignment_state,
  public.lead_documents,
  public.lead_files,
  public.lead_milestones,
  public.lead_workflow_stages,
  public.leads,
  public.notifications,
  public.payment_allocations,
  public.payments,
  public.pipeline_stages,
  public.products,
  public.profiles,
  public.projects,
  public.quotations,
  public.quotes,
  public.tasks,
  public.user_features
TO authenticated;

-- Chat messages currently expose only a read policy.
GRANT SELECT ON TABLE public.chat_messages TO authenticated;

-- Audit/session/transfer history remains read-only for signed-in users.
GRANT SELECT ON TABLE
  public.activity_logs,
  public.audit_logs,
  public.transfer_history,
  public.user_session_daily
TO authenticated;

-- Views are query surfaces, never authenticated mutation surfaces.
GRANT SELECT ON TABLE
  public.lead_alerts,
  public.lead_funnel_daily,
  public.pipeline_summary,
  public.sales_performance,
  public.v_account_receivable_aging,
  public.v_funnel_conversion,
  public.v_lead_trace,
  public.v_risk_pool,
  public.v_sales_personal_stats,
  public.v_stagnant_leads
TO authenticated;

-- The server-only service role is the administrative application boundary.
-- Function EXECUTE grants remain governed by the SAM-61 allowlist migrations.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.activities,
  public.activity_logs,
  public.ad_spend,
  public.audit_logs,
  public.business_events,
  public.chat_messages,
  public.contract_approvals,
  public.contracts,
  public.crm_daily_funnel_snapshot,
  public.customers,
  public.follow_up_logs,
  public.installment_plans,
  public.knx_designs,
  public.kpi_targets,
  public.lead_assignment_state,
  public.lead_deletion_requests,
  public.lead_documents,
  public.lead_files,
  public.lead_milestones,
  public.lead_mutation_requests,
  public.lead_workflow_stages,
  public.leads,
  public.notifications,
  public.payment_allocations,
  public.payments,
  public.pipeline_stages,
  public.products,
  public.profiles,
  public.projects,
  public.quotations,
  public.quotes,
  public.tasks,
  public.transfer_history,
  public.user_features,
  public.user_session_daily
TO service_role;

GRANT SELECT ON TABLE
  public.lead_alerts,
  public.lead_funnel_daily,
  public.pipeline_summary,
  public.sales_performance,
  public.v_account_receivable_aging,
  public.v_funnel_conversion,
  public.v_lead_trace,
  public.v_risk_pool,
  public.v_sales_personal_stats,
  public.v_stagnant_leads
TO service_role;
