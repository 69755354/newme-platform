-- NO_ROLLBACK: additive only (one new service-role routine, no table, column, policy, trigger or client grant changes, no data written). Manual undo: DROP FUNCTION public.sync_advance_lead_stage_from_sheet(uuid, text, text).
-- ============================================================================
-- OS fix S33 - the Drive sync can move a lead forward to "quotation submitted"
-- ============================================================================
-- Context: when the sales sheet says "Opportunity stage = Quotation reported" the Drive sync stores quotation_value and
-- queues the Meta quote event, but it could not move the OS stage: the audited routine transition_lead_stage needs a
-- signed-in actor (auth.uid()), and a direct UPDATE of leads.stage is stopped by trg_check_stage_sequence (one step at a
-- time) and the first-contact gate.
--
-- This routine is the narrow, service-role-only equivalent:
--   * forward only, one step at a time, never past quotation_submitted (the target must be one of new..quotation_submitted
--     funnel stages up to and including quotation_submitted); a lead already at or beyond the target is left alone;
--   * never from or to won / lost, never an archived lead, never an unknown stage (no_answered, fake, ...);
--   * every existing rule still applies: it does not bypass the stage triggers, it walks the same steps. The first-contact
--     rule (one complete contact and an assessed quality before leaving "new") and the follow-up rule (next action and next
--     follow-up date present) are checked up front and answered as a refusal reason, not as an error;
--   * the same audit row as the normal transition: one business_events 'stage_change' per step, with user_id NULL and
--     event_data.actor = 'system:drive_sync' as the system marker (plus from, to, note and the run id);
--   * all-or-nothing: a rule that stops it half way rolls back the steps already taken and answers advanced = false.
-- Returns jsonb {advanced boolean, from text, to text, reason text}. Safe to run twice (a second call finds the lead at the
-- target and does nothing).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.sync_advance_lead_stage_from_sheet(
  p_lead_id uuid,
  p_target_stage text default 'quotation_submitted',
  p_run_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_order constant text[] := array['new','contacted','requirement_confirmed','solution_submitted','quotation_submitted'];
  v_lead public.leads%rowtype;
  v_from text;
  v_cur int;
  v_target int;
  v_next text;
  v_note text := 'Sheet reported a quotation (drive sync)';
begin
  if p_target_stage is null or array_position(v_order, p_target_stage) is null or p_target_stage = 'new' then
    raise exception 'INVALID_TARGET_STAGE';
  end if;
  v_target := array_position(v_order, p_target_stage);

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    return jsonb_build_object('advanced', false, 'reason', 'not_found');
  end if;
  v_from := v_lead.stage;
  if v_lead.archived is true then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'archived');
  end if;
  if v_lead.stage in ('won', 'lost') or v_lead.final_status in ('won', 'lost') then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'terminal');
  end if;
  v_cur := array_position(v_order, v_lead.stage);
  if v_cur is null then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'stage_not_on_funnel');
  end if;
  if v_cur >= v_target then
    return jsonb_build_object('advanced', false, 'from', v_from, 'to', v_from, 'reason', 'already_at_or_past');
  end if;
  if v_lead.next_action is null or btrim(v_lead.next_action) = '' or v_lead.next_followup_date is null then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'next_followup_required');
  end if;
  if v_lead.stage = 'new' and (
       coalesce(v_lead.quality, '') not in ('good', 'normal', 'poor')
       or not exists (
         select 1 from public.follow_up_logs f
         where f.lead_id = p_lead_id and f.contact_time is not null and btrim(coalesce(f.contact_result, '')) <> ''
       )
     ) then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'first_contact_gate');
  end if;

  begin
    while v_cur < v_target loop
      v_next := v_order[v_cur + 1];
      update public.leads
         set stage = v_next, final_status = null, stage_changed_at = now(), updated_at = now()
       where id = p_lead_id;
      insert into public.business_events (lead_id, user_id, event_type, description, event_data, created_at)
      values (
        p_lead_id, null, 'stage_change',
        format('Stage changed from %s to %s: %s', v_order[v_cur], v_next, v_note),
        jsonb_build_object('from', v_order[v_cur], 'to', v_next, 'note', v_note, 'actor', 'system:drive_sync')
          || case when p_run_id is not null then jsonb_build_object('run_id', left(p_run_id, 64)) else '{}'::jsonb end,
        now()
      );
      v_cur := v_cur + 1;
    end loop;
  exception when others then
    -- the sub-transaction is rolled back: no step is kept, the lead stays where it was
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'blocked_by_rule', 'sqlstate', sqlstate);
  end;
  return jsonb_build_object('advanced', true, 'from', v_from, 'to', v_next);
end;
$$;

revoke all on function public.sync_advance_lead_stage_from_sheet(uuid, text, text) from public, anon, authenticated;
grant execute on function public.sync_advance_lead_stage_from_sheet(uuid, text, text) to service_role;
comment on function public.sync_advance_lead_stage_from_sheet(uuid, text, text) is 'S33: Drive sync only (service role). Forward-only stage advance up to quotation_submitted, one audited step at a time, system actor.';
notify pgrst, 'reload schema';
