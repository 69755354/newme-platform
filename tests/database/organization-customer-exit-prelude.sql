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
  tenant_id uuid NOT NULL REFERENCES public.organizations(id),
  name text NOT NULL,
  sku text NOT NULL UNIQUE,
  category text NULL,
  brand text NULL,
  unit text NULL,
  unit_price numeric NOT NULL DEFAULT 0,
  description text NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.organizations(id)
);
CREATE TABLE IF NOT EXISTS public.user_session_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.organizations(id)
);
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;
ALTER TABLE public.activity_logs
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS entity_type text,
  ADD COLUMN IF NOT EXISTS entity_id uuid,
  ADD COLUMN IF NOT EXISTS details jsonb,
  ADD COLUMN IF NOT EXISTS page_path text,
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.user_session_daily
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS session_date date DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS first_login timestamptz,
  ADD COLUMN IF NOT EXISTS last_active timestamptz,
  ADD COLUMN IF NOT EXISTS login_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pages_viewed integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actions_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.user_session_daily
  ADD CONSTRAINT user_session_daily_user_id_session_date_key
  UNIQUE (user_id, session_date);
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  related_id uuid,
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
