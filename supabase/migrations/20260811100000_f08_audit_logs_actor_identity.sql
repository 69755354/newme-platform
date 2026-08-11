-- F-08 · P1 · Any authenticated user can forge audit entries
--
-- Live policy was: policy_audit_logs_insert_authenticated INSERT {authenticated}
-- WITH CHECK (true) — so any of the 7 users could POST /rest/v1/audit_logs with an
-- arbitrary actor_id, fabricating an admin action or burying a real one.
--
-- The policy must stay permissive for INSERT because src/proxy.ts:277 writes
-- PAGE_VISIT rows with the CALLER'S OWN RLS client. It already sets
-- actor_id: user.id, so binding actor_id to auth.uid() preserves that path
-- exactly while removing actor forgery.

begin;

drop policy if exists policy_audit_logs_insert_authenticated on public.audit_logs;
create policy policy_audit_logs_insert_authenticated
  on public.audit_logs for insert to authenticated
  with check (actor_id = auth.uid());

-- Same forgeable shape on the two sibling append-only tables.
drop policy if exists policy_activity_logs_insert_authenticated on public.activity_logs;
create policy policy_activity_logs_insert_authenticated
  on public.activity_logs for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists policy_user_session_daily_insert_authenticated on public.user_session_daily;
create policy policy_user_session_daily_insert_authenticated
  on public.user_session_daily for insert to authenticated
  with check (user_id = auth.uid());

commit;
