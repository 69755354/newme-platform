-- ============================================================================
-- Notification occurrence idempotency
-- ============================================================================
-- NO_ROLLBACK: this additive nullable column, constraint, index and service-role
-- RPC remain compatible with the previous application, whose inserts omit
-- event_key; removing them would only reopen the confirmed concurrent-duplicate
-- notification race without restoring data or application compatibility.
-- The application used to SELECT an exact notification tuple and INSERT only
-- when that read returned no row. Two callers that performed the read before
-- either INSERT committed both wrote the same occurrence. The database must own
-- that decision.
--
-- event_key is deliberately nullable. A non-null key names one persisted
-- business-event occurrence and is unique per recipient. NULL means "this is a
-- new delivery intent" and therefore preserves legitimate repeated reminders.
-- PostgreSQL UNIQUE indexes allow multiple NULL values, so a regular (not
-- partial) index gives both properties and can be inferred by ON CONFLICT.
--
-- Rollback compatibility: the column is nullable and the existing INSERT shape
-- remains valid. Rolling the application back leaves this additive schema in
-- place; the previous release can continue to insert rows with event_key = NULL.
-- Reapplying this migration is safe and does not rewrite existing notifications.
-- ============================================================================

begin;

alter table public.notifications
  add column if not exists event_key text;

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.notifications'::regclass
       and conname = 'notifications_event_key_shape'
  ) then
    alter table public.notifications
      add constraint notifications_event_key_shape
      check (
        event_key is null
        or (
          event_key = pg_catalog.btrim(event_key)
          and pg_catalog.length(event_key) between 1 and 200
        )
      );
  end if;
end
$$;

create unique index if not exists ux_notifications_user_event_key
  on public.notifications (user_id, event_key);

-- event_key is server-owned. The historical authenticated INSERT/UPDATE grants
-- covered the whole table, so merely revoking this one column would not override
-- those table-level privileges. Replace them with the exact pre-existing column
-- surface: old direct inserts and mark-read updates keep working, while a browser
-- session cannot reserve or rewrite an occurrence key before the service RPC.
revoke insert, update on table public.notifications from authenticated;
grant insert (
  id, user_id, type, title, body, related_id, related_type, is_read, created_at
) on table public.notifications to authenticated;
grant update (
  id, user_id, type, title, body, related_id, related_type, is_read, created_at
) on table public.notifications to authenticated;

create or replace function public.insert_notifications_atomic(p_notifications jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_item record;
  v_requested integer;
  v_created integer := 0;
  v_skipped integer := 0;
  v_affected integer;
begin
  if p_notifications is null or pg_catalog.jsonb_typeof(p_notifications) <> 'array' then
    raise exception 'p_notifications must be a JSON array' using errcode = '22023';
  end if;

  v_requested := pg_catalog.jsonb_array_length(p_notifications);
  if v_requested > 64 then
    raise exception 'notification batch exceeds 64 rows' using errcode = '22023';
  end if;

  for v_item in
    select *
      from pg_catalog.jsonb_to_recordset(p_notifications) as item(
        user_id uuid,
        type varchar(50),
        title text,
        body text,
        related_id uuid,
        related_type varchar(30),
        event_key text
      )
  loop
    if v_item.user_id is null or v_item.type is null or v_item.title is null then
      raise exception 'notification user_id, type and title are required' using errcode = '22023';
    end if;
    if v_item.event_key is not null and (
      v_item.event_key <> pg_catalog.btrim(v_item.event_key)
      or pg_catalog.length(v_item.event_key) not between 1 and 200
    ) then
      raise exception 'notification event_key must be 1-200 trimmed characters' using errcode = '22023';
    end if;

    insert into public.notifications (
      user_id,
      type,
      title,
      body,
      related_id,
      related_type,
      event_key
    ) values (
      v_item.user_id,
      v_item.type,
      v_item.title,
      v_item.body,
      v_item.related_id,
      v_item.related_type,
      v_item.event_key
    )
    on conflict (user_id, event_key) do nothing;

    get diagnostics v_affected = row_count;
    if v_affected = 1 then
      v_created := v_created + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'created', v_created,
    'skipped', v_skipped
  );
end
$$;

comment on column public.notifications.event_key is
  'Stable identifier for one notification occurrence. Unique per recipient when non-null; NULL preserves intentionally repeatable delivery intents.';
comment on function public.insert_notifications_atomic(jsonb) is
  'Service-only bulk notification insert. A non-null event_key is inserted once per recipient by the database unique index; NULL event keys always represent distinct intents.';

revoke all on function public.insert_notifications_atomic(jsonb) from public, anon, authenticated;
grant execute on function public.insert_notifications_atomic(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
