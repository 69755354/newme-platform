-- F-10 · P1 (LATENT) · meta_tokens third-party credential readable by all users
--
-- policy_meta_tokens_select_authenticated USING (true) sits alongside the
-- admin-only policy. Permissive policies OR together, so the admin-only intent
-- was defeated and every authenticated user could read the plaintext Meta Ads
-- access_token. 0 rows today; live the moment the OAuth flow stores a token.

begin;

drop policy if exists policy_meta_tokens_select_authenticated on public.meta_tokens;

commit;
