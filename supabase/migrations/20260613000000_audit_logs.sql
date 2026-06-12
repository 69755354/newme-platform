-- Migration: audit_logs table for admin audit trail
-- Run via Supabase Dashboard SQL Editor or npx supabase db push

CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    actor_email TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id UUID,
    details JSONB DEFAULT '{}',
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Admins and boss can read audit logs
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' 
        AND tablename = 'audit_logs' 
        AND policyname = 'Admins can read audit_logs'
    ) THEN
        CREATE POLICY "Admins can read audit_logs" ON public.audit_logs
            FOR SELECT
            USING (auth.jwt() ->> 'role' IN ('admin', 'boss'));
    END IF;
END $$;

-- Authenticated users can insert (for fire-and-forget logging)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' 
        AND tablename = 'audit_logs' 
        AND policyname = 'Authenticated can insert audit_logs'
    ) THEN
        CREATE POLICY "Authenticated can insert audit_logs" ON public.audit_logs
            FOR INSERT
            WITH CHECK (auth.role() = 'authenticated');
    END IF;
END $$;

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs (created_at DESC);
