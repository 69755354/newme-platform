-- Migration: backfill schema definitions for transfer_history & meta_tokens
-- Created: 2026-06-15 (P0 fix: tables exist in DB but had no migration definition)
-- These tables were created ad-hoc in production. This migration makes the
-- schema declarative/idempotent so `supabase db push` works on fresh projects.

-- === transfer_history ===
CREATE TABLE IF NOT EXISTS public.transfer_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    from_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    to_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    reason TEXT,
    notes TEXT,
    transferred_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.transfer_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "transfer_admin_all" ON public.transfer_history
        FOR ALL USING (get_my_role() = ANY (ARRAY['admin', 'boss']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "transfer_sales_insert" ON public.transfer_history
        FOR INSERT WITH CHECK (get_my_role() = 'sales');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "transfer_sales_select" ON public.transfer_history
        FOR SELECT USING (
            lead_id IN (SELECT id FROM public.leads WHERE assigned_to = auth.uid())
        );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_transfer_history_lead ON public.transfer_history (lead_id);

-- === meta_tokens ===
-- Singleton table (id=1) storing the long-lived Meta system-user access token.
CREATE TABLE IF NOT EXISTS public.meta_tokens (
    id INTEGER PRIMARY KEY DEFAULT 1,
    access_token TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT meta_tokens_singleton CHECK (id = 1)
);

ALTER TABLE public.meta_tokens ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "meta_tokens_admin" ON public.meta_tokens
        FOR ALL USING (get_my_role() = ANY (ARRAY['admin', 'boss']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
