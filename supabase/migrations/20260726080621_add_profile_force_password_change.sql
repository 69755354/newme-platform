ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.force_password_change IS
  'Requires the user to change their password before normal application use.';

NOTIFY pgrst, 'reload schema';
