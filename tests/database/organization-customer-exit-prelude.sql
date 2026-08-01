\set ON_ERROR_STOP on

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS manager_id uuid,
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz,
  ADD COLUMN IF NOT EXISTS joined_at timestamptz,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS force_password_change boolean DEFAULT false;

ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS pdf_url text,
  ADD COLUMN IF NOT EXISTS ppt_url text;
ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS contract_id uuid,
  ADD COLUMN IF NOT EXISTS quotation_id uuid,
  ADD COLUMN IF NOT EXISTS project_id uuid;
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS file_url text,
  ADD COLUMN IF NOT EXISTS sealed_file_url text;
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS cad_url text,
  ADD COLUMN IF NOT EXISTS quote_url text,
  ADD COLUMN IF NOT EXISTS ppt_url text,
  ADD COLUMN IF NOT EXISTS contract_url text;

CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id)
);
CREATE TABLE IF NOT EXISTS public.knx_designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id)
);
CREATE TABLE IF NOT EXISTS public.lead_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id),
  file_name text,
  file_path text,
  file_size bigint,
  mime_type text
);
CREATE TABLE IF NOT EXISTS public.lead_mutation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id)
);
CREATE TABLE IF NOT EXISTS public.lead_workflow_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id)
);
CREATE TABLE IF NOT EXISTS public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id),
  project_id uuid REFERENCES public.projects(id)
);
CREATE TABLE IF NOT EXISTS public.transfer_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id)
);
CREATE TABLE IF NOT EXISTS public.crm_daily_funnel_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id)
);
CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.organizations(id)
);
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.organizations(id)
);
CREATE TABLE IF NOT EXISTS public.user_session_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.organizations(id)
);
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  related_id text,
  related_type text
);
CREATE TABLE IF NOT EXISTS public.user_features (
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  feature_key text NOT NULL,
  enabled boolean DEFAULT true,
  PRIMARY KEY (user_id, feature_key)
);

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
