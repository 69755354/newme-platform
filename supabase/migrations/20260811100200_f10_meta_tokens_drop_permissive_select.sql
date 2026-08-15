-- F-10 · P1 (LATENT) · meta_tokens third-party credential readable by all users
--
-- policy_meta_tokens_select_authenticated USING (true) sits alongside the
-- admin-only policy. Permissive policies OR together, so the admin-only intent
-- was defeated and every authenticated user could read the plaintext Meta Ads
-- access_token. 0 rows today; live the moment the OAuth flow stores a token.
--
-- REVISED 2026-08-11 after independent review. Dropping the permissive policy is
-- correct but not sufficient: policy_meta_tokens_select_admin remains, so the
-- plaintext token was still readable over PostgREST by any admin/boss session —
-- a third-party credential exposed to a browser-reachable endpoint. A stolen
-- admin session, or an XSS on an admin page, exfiltrates the Meta Ads token.
--
-- No caller-scoped reader exists. Every meta_tokens access in the codebase runs
-- on service_role:
--     src/app/api/meta/oauth-callback/route.ts:36  getSupabaseAdmin() upsert
-- so removing `authenticated` from the table entirely breaks nothing, and the
-- token stops being reachable from any browser-held identity.
--
-- SELECT is revoked at the grant layer rather than by dropping the admin policy,
-- because a grant cannot be re-opened by adding a permissive policy later — the
-- failure mode that created this finding in the first place.
--
-- Guarded by tests/security/meta-tokens-exposure.test.mjs.
--
-- Rollback: supabase/migrations/rollback_l0_20260811.sql

begin;

-- The permissive policy that defeated the admin-only intent.
drop policy if exists policy_meta_tokens_select_authenticated on public.meta_tokens;

-- Residual exposure: the admin policy still surfaced the plaintext token to a
-- browser-held session. No caller-scoped reader or writer exists, so the whole
-- table leaves the `authenticated` and `anon` grant surface.
revoke all on public.meta_tokens from anon, authenticated;
grant all on public.meta_tokens to service_role;

commit;
