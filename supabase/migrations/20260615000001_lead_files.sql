-- Migration: lead_files table (KNX CAD/uploaded files per lead)
-- Created: 2026-06-15 (P0 fix: table referenced by code but never created)

CREATE TABLE IF NOT EXISTS public.lead_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    file_name TEXT,
    file_path TEXT NOT NULL,
    file_type TEXT,          -- dxf | dwg | pdf | cad | image
    file_size BIGINT,
    mime_type TEXT,
    uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lead_files ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "lead_files_admin_all" ON public.lead_files
        FOR ALL USING (get_my_role() = ANY (ARRAY['admin', 'boss']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "lead_files_select_assigned" ON public.lead_files
        FOR SELECT USING (
            lead_id IN (SELECT id FROM public.leads WHERE assigned_to = auth.uid())
        );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "lead_files_insert_staff" ON public.lead_files
        FOR INSERT WITH CHECK (
            uploaded_by = auth.uid() OR get_my_role() = ANY (ARRAY['admin', 'boss', 'operator'])
        );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_lead_files_lead ON public.lead_files (lead_id);
