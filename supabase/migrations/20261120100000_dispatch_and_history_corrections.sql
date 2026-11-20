-- NO_ROLLBACK: additive only (four existing routines replaced in place with CREATE OR REPLACE and the same signatures, one new service-role helper, one idempotent recompute of derived WhatsApp timing/count columns from live rows); no table, column, policy or client grant changes. Manual undo is described at the end of the file.
-- ============================================================================
-- OS fix S31 - corrections to the S24 dispatch routines and the S25 history backfill
-- ============================================================================
-- S24 (20261119300000_lead_dispatch_and_review.sql):
--   (a) evaluate_lead_dispatch: the phone-confirmation check is null-safe. Before, a lead that already had a state
--       row and no confirmed number (phone_confirmed_norm null) skipped review_phone on its second evaluation,
--       because "not (... and null = x)" is null, not true.
--   (b) evaluate_lead_dispatch: duplicate phone matching uses the canonical form (dispatch_phone_norm) only. The
--       extra wa_phone_key equality is dropped: the two keys disagree on some valid numbers (for example a stray
--       trunk zero after +971), so true twins were missed. A digit-suffix prefilter keeps the scan cheap.
--   (c) a newer lead is re-evaluated when an older duplicate candidate changes: dispatch_decide re-evaluates the
--       newer leads that depend on the decided lead, sweep_lead_dispatch picks up newer leads whose pending-review
--       candidate was edited, archived or re-classified after the newer lead was last evaluated, and re-evaluates
--       the dependents of every changed lead it refreshes. New helper: dispatch_reevaluate_dependents.
-- S25 (20261119400000_whatsapp_history_backfill.sql):
--   (d) record_whatsapp_ad_event: when the live delivery of a message arrives after the history backfill stored
--       it, the backfilled row is promoted (live fields, backfilled = false) and the message then goes through the
--       normal live path (lead resolution, first-click attribution, timing). A second live delivery is still a
--       duplicate.
-- Same signatures, same privileges (service role only). Safe to run twice.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- (a) + (b) evaluate one lead
-- ---------------------------------------------------------------------------
create or replace function public.evaluate_lead_dispatch(p_lead_id uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
-- S31 corrective v1: null-safe phone confirmation, canonical phone matching.
declare
  l public.leads%rowtype;
  st public.lead_dispatch_state%rowtype;
  v_have boolean;
  v_missing text[] := '{}';
  v_norm text;
  v_flag text;
  v_status text;
  v_note text;
  v_is_test boolean;
  v_cands uuid[];
  v_matched text[];
  v_pending public.duplicate_reviews%rowtype;
  v_decided public.duplicate_reviews%rowtype;
  v_changed boolean;
begin
  perform public.assert_current_session_at_entry();
  perform pg_advisory_xact_lock(hashtextextended('lead_dispatch:' || p_lead_id::text, 0));
  select * into l from public.leads where id = p_lead_id;
  if not found then
    raise exception using errcode = '22023', message = 'unknown_lead';
  end if;
  if l.archived then
    return jsonb_build_object('lead_id', p_lead_id, 'status', 'skipped', 'changed', false);
  end if;
  select * into st from public.lead_dispatch_state where lead_id = p_lead_id;
  v_have := found;

  -- facts
  if l.customer_name is null or char_length(btrim(l.customer_name)) < 2 then v_missing := array_append(v_missing, 'customer_name'::text); end if;
  if btrim(coalesce(l.phone, '')) = '' and btrim(coalesce(l.email, '')) = '' then v_missing := array_append(v_missing, 'phone_or_email'::text); end if;
  if coalesce(l.first_touch_at, l.created_at) is null then v_missing := array_append(v_missing, 'received_at'::text); end if;
  if btrim(coalesce(l.source, '')) = '' then v_missing := array_append(v_missing, 'source'::text); end if;
  v_norm := public.dispatch_phone_norm(l.phone);
  v_flag := public.dispatch_phone_flag(l.phone);
  v_is_test := case coalesce(v_have and st.test_mark is not null, false)
    when true then st.test_mark = 'manual'
    else public.dispatch_is_test_pattern(l.customer_name, l.email) end;

  select * into v_decided from public.duplicate_reviews
   where lead_id = p_lead_id and decision in ('merged', 'invalid') order by decided_at desc, created_at desc limit 1;
  select * into v_pending from public.duplicate_reviews where lead_id = p_lead_id and decision = 'pending';

  -- older twins (only the newer lead of a pair is ever flagged). Phone: canonical form only (b). The last eight
  -- digits of a raw number equal the last eight digits of its canonical form (normalising only removes leading
  -- characters), so the suffix test is an exact prefilter, not a second key.
  select array_agg(o.id order by o.created_at, o.id),
         array_remove(array[
           case when bool_or(v_norm is not null and public.dispatch_phone_norm(o.phone) = v_norm) then 'phone' end,
           case when bool_or(btrim(coalesce(l.email, '')) <> '' and lower(btrim(o.email)) = lower(btrim(l.email))) then 'email' end,
           case when bool_or(btrim(coalesce(l.meta_leadgen_id, '')) <> '' and o.meta_leadgen_id = l.meta_leadgen_id) then 'meta_leadgen_id' end
         ], null)
    into v_cands, v_matched
    from public.leads o
   where o.id <> l.id and not o.archived
     and (o.created_at, o.id) < (l.created_at, l.id)
     and not exists (select 1 from public.lead_dispatch_state os where os.lead_id = o.id and os.status = 'excluded_test')
     and ((v_norm is not null
           and right(regexp_replace(coalesce(o.phone, ''), '[^0-9]', '', 'g'), 8) = right(v_norm, 8)
           and public.dispatch_phone_norm(o.phone) = v_norm)
       or (btrim(coalesce(l.email, '')) <> '' and lower(btrim(o.email)) = lower(btrim(l.email)))
       or (btrim(coalesce(l.meta_leadgen_id, '')) <> '' and o.meta_leadgen_id = l.meta_leadgen_id));

  -- decision order
  if v_is_test then
    v_status := 'excluded_test'; v_note := 'test record';
  elsif v_decided.id is not null then
    v_status := 'duplicate_not_dispatched'; v_note := 'duplicate decision: ' || v_decided.decision;
  elsif cardinality(v_missing) > 0 and not (v_have and st.release_reason is not null) then
    v_status := 'missing_intake_data'; v_note := 'missing: ' || array_to_string(v_missing, ', ');
  -- (a) only a confirmation of exactly this number skips the review; no confirmation (null) never does
  elsif v_flag in ('invalid', 'suspect')
        and not coalesce(v_have and v_norm is not null and st.phone_confirmed_norm is not null and st.phone_confirmed_norm = v_norm, false) then
    v_status := 'review_phone'; v_note := 'phone looks ' || v_flag;
  else
    -- duplicates: an open review stays open while a candidate exists; without a candidate it is withdrawn
    if v_pending.id is not null then
      if v_cands is null then
        update public.duplicate_reviews set decision = 'withdrawn', decided_at = now(), notes = coalesce(notes, 'candidate no longer matches')
         where id = v_pending.id;
        perform public.dispatch_record_event(p_lead_id, 'duplicate', null, null, null, 'review withdrawn: candidate no longer matches');
      else
        if v_pending.candidate_ids is distinct from v_cands or v_pending.matched_on is distinct from v_matched
           or v_pending.duplicate_of_lead_id is distinct from v_cands[1] then
          update public.duplicate_reviews set candidate_ids = v_cands, matched_on = v_matched, duplicate_of_lead_id = v_cands[1]
           where id = v_pending.id;
        end if;
        v_status := 'duplicate_review';
      end if;
    elsif v_cands is not null
          and not exists (select 1 from public.duplicate_reviews r
                           where r.lead_id = p_lead_id and r.decision = 'kept_separate' and r.candidate_ids @> v_cands) then
      insert into public.duplicate_reviews (lead_id, duplicate_of_lead_id, candidate_ids, matched_on)
      values (p_lead_id, v_cands[1], v_cands, v_matched);
      perform public.dispatch_record_event(p_lead_id, 'duplicate', null, null, null, 'review opened: matches ' || array_to_string(v_matched, ', '));
      v_status := 'duplicate_review';
    end if;
    if v_status is not null then
      v_note := 'matches an older lead on ' || array_to_string(v_matched, ', ');
    elsif l.assigned_to is null then
      v_status := 'unassigned'; v_note := 'no owner';
    else
      v_status := 'delivered'; v_note := 'ready';
    end if;
  end if;

  if not v_have then
    insert into public.lead_dispatch_state (lead_id, status, missing_fields, phone_norm, phone_flag, routing_note)
    values (p_lead_id, v_status, v_missing, v_norm, v_flag, v_note);
    perform public.dispatch_record_event(p_lead_id, 'status', null, v_status, p_actor, v_note);
    v_changed := true;
  else
    v_changed := (st.status, st.missing_fields, st.phone_norm, st.phone_flag, st.routing_note)
      is distinct from (v_status, v_missing, v_norm, v_flag, v_note);
    if v_changed then
      update public.lead_dispatch_state
         set status = v_status, missing_fields = v_missing, phone_norm = v_norm, phone_flag = v_flag,
             routing_note = v_note, evaluated_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      if st.status is distinct from v_status then
        perform public.dispatch_record_event(p_lead_id, 'status', st.status, v_status, p_actor, v_note);
      end if;
    else
      update public.lead_dispatch_state set evaluated_at = now() where lead_id = p_lead_id;
    end if;
  end if;
  return jsonb_build_object('lead_id', p_lead_id, 'status', v_status, 'previous_status', case when v_have then st.status end,
                            'changed', v_changed, 'missing_fields', to_jsonb(v_missing));
end
$fn$;

-- ---------------------------------------------------------------------------
-- (c) re-evaluate the newer leads that depend on one lead
-- ---------------------------------------------------------------------------
-- Dependents: newer, live leads with a pending review that lists this lead as a candidate, and newer, live leads
-- that match it now (canonical phone, e-mail, Meta lead id), so that a change of this lead (edited, archived, marked
-- or unmarked as a test) reaches its twins. Bounded; a dependent that another transaction holds right now is skipped
-- (never waited for, so two writers cannot deadlock) and is picked up by the next sweep, because this lead's change
-- is newer than the dependent's last evaluation.
create or replace function public.dispatch_reevaluate_dependents(p_lead_id uuid, p_actor uuid default null)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '30s'
as $fn$
-- S31 corrective v1: dependents of a changed duplicate candidate.
declare
  l public.leads%rowtype;
  v_norm text;
  v_dep uuid;
  v_count integer := 0;
begin
  perform public.assert_current_session_at_entry();
  select * into l from public.leads where id = p_lead_id;
  if not found then
    return 0;
  end if;
  v_norm := public.dispatch_phone_norm(l.phone);
  for v_dep in
    select d.id
      from public.leads d
     where d.id <> l.id and not d.archived
       and (d.created_at, d.id) > (l.created_at, l.id)
       and (exists (select 1 from public.duplicate_reviews r
                     where r.lead_id = d.id and r.decision = 'pending' and l.id = any(r.candidate_ids))
         or (v_norm is not null
             and right(regexp_replace(coalesce(d.phone, ''), '[^0-9]', '', 'g'), 8) = right(v_norm, 8)
             and public.dispatch_phone_norm(d.phone) = v_norm)
         or (btrim(coalesce(l.email, '')) <> '' and lower(btrim(d.email)) = lower(btrim(l.email)))
         or (btrim(coalesce(l.meta_leadgen_id, '')) <> '' and d.meta_leadgen_id = l.meta_leadgen_id))
     order by d.created_at, d.id
     limit 50
  loop
    if pg_try_advisory_xact_lock(hashtextextended('lead_dispatch:' || v_dep::text, 0)) then
      perform public.evaluate_lead_dispatch(v_dep, p_actor);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$fn$;

-- ---------------------------------------------------------------------------
-- (c) administrator decisions: unchanged rules, then the dependents are re-evaluated
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_decide(p_lead_id uuid, p_actor uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
-- S31 corrective v1: re-evaluates the newer leads that depend on the decided lead.
declare
  v_role text;
  st public.lead_dispatch_state%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_changed boolean := false;
  v_result jsonb;
  v_dependents integer;
begin
  perform public.assert_current_session_at_entry();
  select role into v_role from public.profiles where id = p_actor and is_active;
  if v_role is null or v_role not in ('admin', 'boss', 'operator') then
    raise exception using errcode = '42501', message = 'dispatch_decision_not_allowed';
  end if;
  if p_action is null or p_action not in ('confirm_phone', 'release_missing', 'revoke_release', 'mark_test', 'unmark_test', 'note', 'reevaluate') then
    raise exception using errcode = '22023', message = 'invalid_dispatch_action';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lead_dispatch:' || p_lead_id::text, 0));
  -- bring the row up to date first, so a decision never rests on a stale reading of the lead
  perform public.evaluate_lead_dispatch(p_lead_id, p_actor);
  select * into st from public.lead_dispatch_state where lead_id = p_lead_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'lead_has_no_dispatch_state';
  end if;

  if p_action = 'confirm_phone' then
    if st.phone_flag = 'invalid' or (st.phone_flag = 'suspect' and st.phone_norm is null) then
      raise exception using errcode = '22023', message = 'phone_not_confirmable';
    end if;
    if st.phone_flag = 'suspect' and st.phone_confirmed_norm is distinct from st.phone_norm then
      update public.lead_dispatch_state set phone_confirmed_norm = phone_norm, decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  elsif p_action = 'release_missing' then
    if char_length(v_reason) < 10 then
      raise exception using errcode = '22023', message = 'reason_required';
    end if;
    if cardinality(st.missing_fields) = 0 then
      raise exception using errcode = '22023', message = 'nothing_to_release';
    end if;
    if st.release_reason is distinct from v_reason then
      update public.lead_dispatch_state set release_reason = v_reason, release_by = p_actor, release_at = now(),
             decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  elsif p_action = 'revoke_release' then
    if st.release_reason is not null then
      update public.lead_dispatch_state set release_reason = null, release_by = null, release_at = null,
             decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  elsif p_action in ('mark_test', 'unmark_test') then
    if char_length(v_reason) < 5 then
      raise exception using errcode = '22023', message = 'reason_required';
    end if;
    if st.test_mark is distinct from (case when p_action = 'mark_test' then 'manual' else 'not_test' end) then
      update public.lead_dispatch_state set test_mark = case when p_action = 'mark_test' then 'manual' else 'not_test' end,
             decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  elsif p_action = 'note' then
    if v_reason = '' then
      raise exception using errcode = '22023', message = 'reason_required';
    end if;
    if st.admin_note is distinct from left(v_reason, 1000) then
      update public.lead_dispatch_state set admin_note = left(v_reason, 1000), decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  end if;

  if v_changed then
    perform public.dispatch_record_event(p_lead_id, 'decision', st.status, null, p_actor, p_action || case when v_reason <> '' then ': ' || v_reason else '' end);
  end if;
  v_result := public.evaluate_lead_dispatch(p_lead_id, p_actor);
  -- (c) a test mark (or any other change) of this lead can open, keep or withdraw a newer twin's review
  v_dependents := public.dispatch_reevaluate_dependents(p_lead_id, p_actor);
  return jsonb_build_object('lead_id', p_lead_id, 'status', v_result->>'status',
    'changed', v_changed or coalesce((v_result->>'changed')::boolean, false), 'dependents_reevaluated', v_dependents);
end
$fn$;

-- ---------------------------------------------------------------------------
-- (c) bounded sweep: also newer leads whose pending-review candidate changed after their last evaluation
-- ---------------------------------------------------------------------------
create or replace function public.sweep_lead_dispatch(p_since timestamptz, p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '60s'
as $fn$
-- S31 corrective v1: candidate changes reach the newer lead.
declare
  v_id uuid;
  v_had_state boolean;
  v_eval jsonb;
  v_evaluated integer := 0;
  v_changed integer := 0;
  v_dependents integer := 0;
begin
  perform public.assert_current_session_at_entry();
  if p_since is null then
    raise exception using errcode = '22023', message = 'since_required';
  end if;
  for v_id, v_had_state in
    select l.id, s.lead_id is not null
      from public.leads l left join public.lead_dispatch_state s on s.lead_id = l.id
     where not l.archived
       and ((s.lead_id is null and l.created_at >= p_since)
         or (s.lead_id is not null and coalesce(l.updated_at, l.created_at) > s.evaluated_at and coalesce(l.updated_at, l.created_at) >= p_since)
         -- a candidate of this lead's pending review was edited, archived or re-classified since this lead was evaluated
         or (s.lead_id is not null and exists (
               select 1
                 from public.duplicate_reviews r
                 join public.leads o on o.id = any(r.candidate_ids)
                 left join public.lead_dispatch_state os on os.lead_id = o.id
                where r.lead_id = l.id and r.decision = 'pending'
                  and greatest(coalesce(o.updated_at, o.created_at), os.updated_at) > s.evaluated_at
                  and greatest(coalesce(o.updated_at, o.created_at), os.updated_at) >= p_since)))
     order by coalesce(l.updated_at, l.created_at), l.id
     limit greatest(1, least(coalesce(p_limit, 100), 1000))
  loop
    v_eval := public.evaluate_lead_dispatch(v_id, null);
    v_evaluated := v_evaluated + 1;
    if coalesce((v_eval->>'changed')::boolean, false) then v_changed := v_changed + 1; end if;
    -- a lead that changed after its last evaluation may be an older twin of other leads; a first evaluation
    -- (backfill, new lead) is not, so the backfill stays as cheap as before
    if v_had_state then
      v_dependents := v_dependents + public.dispatch_reevaluate_dependents(v_id, null);
    end if;
  end loop;
  return jsonb_build_object('evaluated', v_evaluated, 'changed', v_changed, 'dependents_reevaluated', v_dependents);
end
$fn$;

revoke all on function public.evaluate_lead_dispatch(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.dispatch_reevaluate_dependents(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.dispatch_decide(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.sweep_lead_dispatch(timestamptz, integer) from public, anon, authenticated, service_role;
grant execute on function public.evaluate_lead_dispatch(uuid, uuid) to service_role;
grant execute on function public.dispatch_reevaluate_dependents(uuid, uuid) to service_role;
grant execute on function public.dispatch_decide(uuid, uuid, text, text) to service_role;
grant execute on function public.sweep_lead_dispatch(timestamptz, integer) to service_role;

comment on function public.evaluate_lead_dispatch(uuid, uuid) is 'S24/S31: idempotent dispatch evaluation of one lead (null-safe phone confirmation, canonical phone matching). Service role only.';
comment on function public.dispatch_reevaluate_dependents(uuid, uuid) is 'S31: re-evaluate the newer leads that depend on one lead as a duplicate candidate (bounded, never waits for a lock). Service role only.';
comment on function public.dispatch_decide(uuid, uuid, text, text) is 'S24/S31: confirm phone, release missing data, mark test, note, re-evaluate; admin, boss or operator only; re-evaluates dependent newer leads. Service role only.';
comment on function public.sweep_lead_dispatch(timestamptz, integer) is 'S24/S31: bounded sweep over new and changed leads and over leads whose pending-review candidate changed. Service role only.';

-- ---------------------------------------------------------------------------
-- (d) the live WhatsApp writer promotes a message the history backfill stored first
-- ---------------------------------------------------------------------------
create or replace function public.record_whatsapp_ad_event(p_event jsonb, p_create_organic boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
-- S31 corrective v1: a live delivery promotes a backfilled history row; timing and counts ignore backfilled rows.
begin
  perform public.assert_current_session_at_entry();
  declare
    v_waba text := p_event->>'waba_id';
    v_phone_id text := p_event->>'phone_number_id';
    v_key text := public.wa_phone_key(p_event->>'customer_phone');
    v_message text := p_event->>'message_id';
    v_direction text := p_event->>'direction';
    v_source text := p_event->>'source';
    v_type text := coalesce(p_event->>'message_type', 'text');
    v_at timestamptz;
    v_name text := nullif(left(btrim(coalesce(p_event->>'profile_name', '')), 200), '');
    v_ref jsonb := case when jsonb_typeof(p_event->'referral') = 'object' then p_event->'referral' else null end;
    v_clid text := v_ref->>'ctwa_clid';
    v_ref_type text := v_ref->>'source_type';
    v_ref_id text := v_ref->>'source_id';
    v_ref_url text := v_ref->>'source_url';
    v_headline text := nullif(left(coalesce(v_ref->>'headline', ''), 200), '');
    v_is_ad boolean;
    v_ad_id text;
    v_conv public.whatsapp_conversations%rowtype;
    v_inserted integer;
    v_promoted boolean := false;
    v_lead_id uuid;
    v_lead_created boolean := false;
    v_attributed boolean := false;
    v_queued boolean := false;
    v_lead public.leads%rowtype;
    v_first_in timestamptz;
    v_first_reply timestamptz;
    v_followup date;
    v_kind text := nullif(p_event->>'body_kind', '');
    v_body text := p_event->>'body';
  begin
    if jsonb_typeof(p_event) <> 'object' or v_key is null or v_waba is null or v_waba !~ '^[0-9]{5,32}$'
       or v_phone_id is null or v_phone_id !~ '^[0-9]{5,32}$'
       or v_message is null or char_length(v_message) not between 1 and 256
       or v_direction not in ('inbound', 'outbound') or v_source not in ('messages', 'smb_message_echoes')
       or v_type !~ '^[a-z_]{1,40}$' then
      raise exception using errcode = '22023', message = 'invalid_whatsapp_event';
    end if;
    begin
      v_at := (p_event->>'occurred_at')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_whatsapp_event';
    end;
    if v_at is null then raise exception using errcode = '22023', message = 'invalid_whatsapp_event'; end if;
    -- Chat text (S21): only a plain text message keeps its body; media and other kinds keep a marker only.
    if v_kind is null or v_kind not in ('text', 'media', 'other') then
      v_kind := case when v_type = 'text' then 'text'
                     when v_type in ('image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts') then 'media'
                     else 'other' end;
    end if;
    v_body := case when v_kind = 'text' then nullif(left(btrim(coalesce(v_body, '')), 4096), '') else null end;
    if v_clid is not null and (v_clid !~ '^[A-Za-z0-9_-]+$' or char_length(v_clid) not between 10 and 512) then v_clid := null; end if;
    if v_ref_id is not null and v_ref_id !~ '^[0-9]{5,32}$' then v_ref_id := null; end if;
    if v_ref_url is not null and (v_ref_url !~* '^https://[^[:space:]]+$' or char_length(v_ref_url) > 500) then v_ref_url := null; end if;
    v_is_ad := v_direction = 'inbound' and (v_clid is not null or coalesce(v_ref_type = 'ad', false));
    v_ad_id := case when v_ref_type = 'ad' then v_ref_id else null end;

    -- One customer phone is handled by one transaction at a time, across WABAs, so a replayed or
    -- concurrent delivery can never create a second lead.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wa-ctwa:' || v_key, 0));

    insert into public.whatsapp_conversations (waba_id, customer_key, phone_number_id)
    values (v_waba, v_key, v_phone_id)
    on conflict (waba_id, customer_key) do nothing;
    select * into v_conv from public.whatsapp_conversations where waba_id = v_waba and customer_key = v_key for update;

    insert into public.whatsapp_message_events
      (conversation_id, waba_id, message_id, direction, source, message_type, phone_number_id, occurred_at,
       referral_ctwa_clid, referral_source_id, body, body_kind)
    values (v_conv.id, v_waba, v_message, v_direction, v_source, v_type, v_phone_id, v_at,
       case when v_direction = 'inbound' then v_clid end, case when v_direction = 'inbound' then v_ref_id end,
       v_body, v_kind)
    on conflict (waba_id, message_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      -- S31 (d): the history backfill stored this message first. The live delivery is authoritative: its fields
      -- replace the backfilled ones (the history text stays only when the live text is empty), the row stops
      -- being backfilled, and the message continues through the live path below exactly like a new one. A row
      -- that is already live is a true duplicate, as before.
      update public.whatsapp_message_events set
        conversation_id = v_conv.id, direction = v_direction, source = v_source, message_type = v_type,
        phone_number_id = v_phone_id, occurred_at = v_at,
        referral_ctwa_clid = case when v_direction = 'inbound' then v_clid end,
        referral_source_id = case when v_direction = 'inbound' then v_ref_id end,
        body = case when v_kind = 'text' then coalesce(v_body, body) else null end,
        body_kind = v_kind,
        backfilled = false
      where waba_id = v_waba and message_id = v_message and backfilled;
      get diagnostics v_inserted = row_count;
      v_promoted := v_inserted > 0;
      if not v_promoted then
        return jsonb_build_object('duplicate', true, 'lead_id', v_conv.lead_id, 'lead_created', false,
          'attributed', false, 'queued', false);
      end if;
    end if;

    -- S21 (S18 review, item 1): a conversation whose lead was archived is being replaced. The click id,
    -- ad id and source time belong to the archived lead, so they are cleared here and only the current
    -- message can attribute the lead that replaces it. Inside one live lead the first click still wins.
    if v_conv.lead_id is not null
       and not exists (select 1 from public.leads where id = v_conv.lead_id and archived = false) then
      update public.whatsapp_conversations set lead_id = null, is_ad = false, first_ctwa_clid = null,
        first_ad_id = null, first_source_type = null, first_source_url = null, first_headline = null,
        first_referral_at = null
      where id = v_conv.id;
      select * into v_conv from public.whatsapp_conversations where id = v_conv.id;
    end if;

    -- Timing and counts are recomputed from the stored live events, so arrival order does not matter. S31: backfilled
    -- history rows never count (they are not live conversation activity).
    select min(occurred_at) filter (where direction = 'inbound') into v_first_in
      from public.whatsapp_message_events where conversation_id = v_conv.id and not backfilled;
    select min(occurred_at) into v_first_reply
      from public.whatsapp_message_events
      where conversation_id = v_conv.id and direction = 'outbound' and v_first_in is not null and occurred_at > v_first_in and not backfilled;
    update public.whatsapp_conversations c set
      phone_number_id = v_phone_id,
      first_inbound_at = v_first_in,
      first_reply_at = v_first_reply,
      first_outbound_at = (select min(occurred_at) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'outbound' and not e.backfilled),
      last_inbound_at = (select max(occurred_at) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'inbound' and not e.backfilled),
      last_outbound_at = (select max(occurred_at) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'outbound' and not e.backfilled),
      inbound_count = (select count(*) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'inbound' and not e.backfilled),
      outbound_count = (select count(*) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'outbound' and not e.backfilled),
      is_ad = c.is_ad or v_is_ad,
      updated_at = now()
    where c.id = v_conv.id;

    -- First click wins: the conversation keeps the first referral it saw, later clicks only log
    -- their ids on the message row.
    if v_is_ad and v_conv.first_ctwa_clid is null and v_clid is not null then
      update public.whatsapp_conversations set first_ctwa_clid = v_clid, first_ad_id = v_ad_id,
        first_source_type = v_ref_type, first_source_url = v_ref_url, first_headline = v_headline,
        first_referral_at = v_at
      where id = v_conv.id;
    end if;
    select * into v_conv from public.whatsapp_conversations where id = v_conv.id;

    -- Resolve the lead: the linked one while it is active, else the oldest active lead with this
    -- phone, else (inbound only) a new lead.
    if v_conv.lead_id is not null then
      select id into v_lead_id from public.leads where id = v_conv.lead_id and archived = false;
    end if;
    if v_lead_id is null then
      select id into v_lead_id from public.leads
        where archived = false and public.wa_phone_key(phone) = v_key
        order by created_at asc nulls last, id asc limit 1;
    end if;
    if v_lead_id is null and v_direction = 'inbound' and (v_is_ad or p_create_organic) then
      v_followup := (now() at time zone 'Asia/Dubai')::date + 1;
      insert into public.leads (
        source, source_platform, source_channel, customer_name, phone,
        ad_id, meta_ad_id, lead_status, next_action, next_followup_date, first_touch_at, created_at
      ) values (
        'whatsapp', 'whatsapp', case when v_is_ad then 'whatsapp_ctwa' else 'whatsapp_direct' end,
        coalesce(v_name, '+' || v_key), '+' || v_key,
        v_ad_id, v_ad_id, 'hot', 'call', v_followup, v_at, v_at
      ) returning id into v_lead_id;
      v_lead_created := true;
    end if;

    if v_lead_id is not null then
      if v_conv.lead_id is distinct from v_lead_id then
        update public.whatsapp_conversations set lead_id = v_lead_id where id = v_conv.id;
      end if;
      select * into v_lead from public.leads where id = v_lead_id for update;
      -- Attach the first click id once; never replace it, never overwrite an ad id that is already known.
      if v_lead.ctwa_clid is null and v_conv.first_ctwa_clid is not null then
        update public.leads set
          ctwa_clid = v_conv.first_ctwa_clid,
          ad_id = coalesce(ad_id, v_conv.first_ad_id),
          meta_ad_id = coalesce(meta_ad_id, v_conv.first_ad_id),
          wa_ad_headline = coalesce(wa_ad_headline, v_conv.first_headline),
          wa_ad_source_url = coalesce(wa_ad_source_url, v_conv.first_source_url),
          source_channel = case when source_channel is null or source_channel = 'whatsapp_direct' then 'whatsapp_ctwa' else source_channel end,
          updated_at = now()
        where id = v_lead_id;
        v_attributed := true;
        insert into public.whatsapp_capi_events (lead_id, waba_id, ctwa_clid, event_name, event_time)
        values (v_lead_id, v_waba, v_conv.first_ctwa_clid, 'LeadSubmitted', extract(epoch from v_conv.first_referral_at)::bigint)
        on conflict (lead_id, event_name) do nothing;
        get diagnostics v_inserted = row_count;
        v_queued := v_inserted > 0;
      end if;
      -- S21 (S18 review, item 2): one customer may write to several business numbers (WABAs). The lead's
      -- first message and first reply come from every conversation linked to it, not from this one.
      select min(e.occurred_at) filter (where e.direction = 'inbound') into v_first_in
        from public.whatsapp_message_events e join public.whatsapp_conversations c on c.id = e.conversation_id
        where c.lead_id = v_lead_id and not e.backfilled;
      select min(e.occurred_at) into v_first_reply
        from public.whatsapp_message_events e join public.whatsapp_conversations c on c.id = e.conversation_id
        where c.lead_id = v_lead_id and e.direction = 'outbound' and v_first_in is not null and e.occurred_at > v_first_in and not e.backfilled;
      update public.leads set wa_first_inbound_at = v_first_in, wa_first_reply_at = v_first_reply
        where id = v_lead_id
          and (wa_first_inbound_at is distinct from v_first_in or wa_first_reply_at is distinct from v_first_reply);
    end if;

    return jsonb_build_object('duplicate', false, 'promoted', v_promoted, 'lead_id', v_lead_id, 'lead_created', v_lead_created,
      'attributed', v_attributed, 'queued', v_queued);
  end;
end
$fn$;

revoke all on function public.record_whatsapp_ad_event(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.record_whatsapp_ad_event(jsonb, boolean) to service_role;

comment on function public.record_whatsapp_ad_event(jsonb, boolean) is
  'S18/S21/S31: record one WhatsApp message (text body kept for text messages), match or create the lead by canonical phone, keep the first ctwa_clid and ad id per live lead, queue LeadSubmitted; a live delivery promotes a backfilled history row. Idempotent per message id and per (WABA, phone). Service role only.';

-- ---------------------------------------------------------------------------
-- (d) one-time, idempotent repair: conversations that hold backfilled rows and their linked leads get the timing and
-- counts recomputed from live rows only (an earlier live delivery may have counted history). Recomputing again gives
-- the same values; rows already equal are not written.
-- ---------------------------------------------------------------------------
with live as (
  select c.id,
         min(e.occurred_at) filter (where e.direction = 'inbound' and not e.backfilled) as first_in,
         min(e.occurred_at) filter (where e.direction = 'outbound' and not e.backfilled) as first_out,
         max(e.occurred_at) filter (where e.direction = 'inbound' and not e.backfilled) as last_in,
         max(e.occurred_at) filter (where e.direction = 'outbound' and not e.backfilled) as last_out,
         count(e.id) filter (where e.direction = 'inbound' and not e.backfilled) as n_in,
         count(e.id) filter (where e.direction = 'outbound' and not e.backfilled) as n_out
    from public.whatsapp_conversations c
    join public.whatsapp_message_events e on e.conversation_id = c.id
   where exists (select 1 from public.whatsapp_message_events b where b.conversation_id = c.id and b.backfilled)
   group by c.id
), nxt as (
  select l.*,
         (select min(e.occurred_at) from public.whatsapp_message_events e
           where e.conversation_id = l.id and e.direction = 'outbound' and not e.backfilled
             and l.first_in is not null and e.occurred_at > l.first_in) as first_reply
    from live l
)
update public.whatsapp_conversations c set
  first_inbound_at = n.first_in, first_reply_at = n.first_reply, first_outbound_at = n.first_out,
  last_inbound_at = n.last_in, last_outbound_at = n.last_out, inbound_count = n.n_in, outbound_count = n.n_out
  from nxt n
 where c.id = n.id
   and (c.first_inbound_at, c.first_reply_at, c.first_outbound_at, c.last_inbound_at, c.last_outbound_at, c.inbound_count, c.outbound_count)
       is distinct from (n.first_in, n.first_reply, n.first_out, n.last_in, n.last_out, n.n_in, n.n_out);

with touched as (
  select distinct c.lead_id
    from public.whatsapp_conversations c
   where c.lead_id is not null
     and exists (select 1 from public.whatsapp_message_events b where b.conversation_id = c.id and b.backfilled)
), first_in as (
  select t.lead_id,
         (select min(e.occurred_at) from public.whatsapp_message_events e join public.whatsapp_conversations c on c.id = e.conversation_id
           where c.lead_id = t.lead_id and e.direction = 'inbound' and not e.backfilled) as v_in
    from touched t
), nxt as (
  select f.lead_id, f.v_in,
         (select min(e.occurred_at) from public.whatsapp_message_events e join public.whatsapp_conversations c on c.id = e.conversation_id
           where c.lead_id = f.lead_id and e.direction = 'outbound' and not e.backfilled
             and f.v_in is not null and e.occurred_at > f.v_in) as v_reply
    from first_in f
)
update public.leads l set wa_first_inbound_at = n.v_in, wa_first_reply_at = n.v_reply
  from nxt n
 where l.id = n.lead_id
   and (l.wa_first_inbound_at is distinct from n.v_in or l.wa_first_reply_at is distinct from n.v_reply);

-- ---------------------------------------------------------------------------
-- Manual undo (not executed): re-run the definitions of evaluate_lead_dispatch, dispatch_decide and
-- sweep_lead_dispatch from 20261119300000_lead_dispatch_and_review.sql and of record_whatsapp_ad_event from
-- 20261119100000_whatsapp_followup_monitor.sql, then remove dispatch_reevaluate_dependents(uuid, uuid). Rows written
-- by these routines stay valid under the old definitions.
-- ---------------------------------------------------------------------------
