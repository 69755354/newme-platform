-- Add missing columns that exist in production but not in migrations
-- Needed for fresh DB deployment

-- Q6: password session invalidation
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- Poor lead reason (P0-8)
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS poor_reason TEXT;

-- archive_reason for leads (tech debt #1)
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS archive_reason TEXT;

-- force password change flag (tech debt #1)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT FALSE;
