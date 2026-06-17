-- Migration: knx_designs table (KNX design computation results per lead)
-- Created: 2026-06-15 (P0 fix: table referenced by code but never created)
-- Note: writes happen via supabaseAdmin (service_role, bypasses RLS)

CREATE TABLE IF NOT EXISTS public.knx_designs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    devices_json JSONB DEFAULT '{}'::jsonb,
    total_aed NUMERIC(12, 2) DEFAULT 0,
    device_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',     -- draft | running | completed | failed
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.knx_designs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "knx_designs_admin_all" ON public.knx_designs
        FOR ALL USING (get_my_role() = ANY (ARRAY['admin', 'boss']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "knx_designs_select_assigned" ON public.knx_designs
        FOR SELECT USING (
            lead_id IN (SELECT id FROM public.leads WHERE assigned_to = auth.uid())
        );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_knx_designs_lead ON public.knx_designs (lead_id);
CREATE INDEX IF NOT EXISTS idx_knx_designs_status ON public.knx_designs (status);
