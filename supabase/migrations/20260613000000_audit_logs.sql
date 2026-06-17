-- Migration: audit_logs table for admin audit trail
-- RLS policy note (verified 2026-06-15):
--   `auth.jwt() ->> 'role'` FAILS in INSERT WITH CHECK context on this Supabase
--   setup even though SET ROLE simulation returns the correct value — the real
--   INSERT RLS evaluation rejects. Switched to `auth.uid()` (proven reliable,
--   see lead_files INSERT policy) and `get_my_role()` (queries profiles via
--   auth.uid()). Do NOT revert to auth.jwt() for WITH CHECK clauses.

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

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Staff (admin/boss/operator) can read audit logs.
-- Uses get_my_role() which resolves via auth.uid() -> profiles.role (reliable).
DROP POLICY IF EXISTS "Admins can read audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Staff can read audit_logs" ON public.audit_logs;
CREATE POLICY "Staff can read audit_logs" ON public.audit_logs
    FOR SELECT TO authenticated
    USING (get_my_role() IN ('admin', 'boss', 'operator'));

-- Any authenticated user can insert audit rows (fire-and-forget logging).
-- auth.uid() IS NOT NULL is the reliable pattern (auth.jwt()->>'role' fails here).
DROP POLICY IF EXISTS "Authenticated can insert audit_logs" ON public.audit_logs;
CREATE POLICY "Authenticated can insert audit_logs" ON public.audit_logs
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON public.audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
