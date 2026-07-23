-- Canonical core-table baseline for clean-room reconstruction.
-- These tables already exist in production but were never captured in migrations.
-- Keep policy definitions in their dedicated later migrations; RLS starts deny-by-default.

CREATE TABLE IF NOT EXISTS public.marketing_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_name TEXT NOT NULL,
  platform TEXT DEFAULT 'meta',
  status TEXT DEFAULT 'inactive',
  start_date DATE DEFAULT DATE '2025-12-01',
  end_date DATE DEFAULT DATE '2026-05-31',
  daily_budget NUMERIC,
  budget_type TEXT,
  total_spent_aed NUMERIC,
  impressions INTEGER,
  reach INTEGER,
  frequency NUMERIC,
  clicks INTEGER,
  cpm_aed NUMERIC,
  cpc_aed NUMERIC,
  ctr_pct NUMERIC,
  conversion_metric TEXT,
  conversions INTEGER,
  cost_per_conversion_aed NUMERIC,
  attribution_window TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  assignee_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT DEFAULT 'manual',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT,
  priority TEXT
);

CREATE TABLE IF NOT EXISTS public.follow_up_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  contact_type TEXT NOT NULL DEFAULT 'phone',
  summary TEXT NOT NULL DEFAULT '',
  result TEXT,
  no_answer BOOLEAN NOT NULL DEFAULT false,
  next_action TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_followup_date TIMESTAMPTZ,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  contact_time TIMESTAMPTZ NOT NULL,
  contact_result TEXT,
  contact_fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS public.lead_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size BIGINT,
  uploaded_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lead_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  file_name TEXT,
  file_path TEXT NOT NULL,
  file_type TEXT,
  file_size BIGINT,
  mime_type TEXT,
  uploaded_by UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.meta_tokens (
  id INTEGER PRIMARY KEY DEFAULT 1,
  access_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transfer_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id),
  from_user_id UUID REFERENCES public.profiles(id),
  to_user_id UUID NOT NULL REFERENCES public.profiles(id),
  reason TEXT,
  notes TEXT,
  transferred_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.crm_daily_funnel_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  current_milestone TEXT NOT NULL,
  lead_count INTEGER NOT NULL DEFAULT 0,
  total_value NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_features (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key)
);

CREATE TABLE IF NOT EXISTS public.knx_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  devices_json JSONB DEFAULT '{}'::jsonb,
  total_aed NUMERIC DEFAULT 0,
  device_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.knx_designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_daily_funnel_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfer_history ENABLE ROW LEVEL SECURITY;
