BEGIN;

DO $v4_paid_seat_rollback_preflight$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION 'v4_paid_seat_trigger_rollback_requires_staging_or_test';
  END IF;
  IF to_regprocedure('public.v4_sync_membership_paid_seat()') IS NULL
    OR pg_get_functiondef(to_regprocedure('public.v4_sync_membership_paid_seat()'))
      NOT ILIKE '%IF TG_TABLE_NAME = ''memberships'' THEN%'
  THEN
    RAISE EXCEPTION 'v4_paid_seat_trigger_rollback_predecessor_drift';
  END IF;
END
$v4_paid_seat_rollback_preflight$;

-- Restore the exact function body from
-- 20260805190000_v4_commercial_control_plane.sql.
CREATE OR REPLACE FUNCTION public.v4_sync_membership_paid_seat()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target_membership_id uuid;
DECLARE membership_row public.memberships%ROWTYPE;
DECLARE subscription_row public.organization_subscriptions%ROWTYPE;
DECLARE allocation_row public.paid_seat_allocations%ROWTYPE;
DECLARE should_be_active boolean;
DECLARE active_seats integer;
DECLARE event_key text;
BEGIN
  target_membership_id := CASE WHEN TG_TABLE_NAME = 'memberships'
    THEN COALESCE(NEW.id, OLD.id) ELSE COALESCE(NEW.membership_id, OLD.membership_id) END;
  SELECT * INTO membership_row FROM public.memberships WHERE id = target_membership_id;
  IF membership_row.id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT * INTO subscription_row FROM public.organization_subscriptions
  WHERE organization_id = membership_row.organization_id FOR UPDATE;
  IF subscription_row.id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  should_be_active := membership_row.status = 'active'
    AND membership_row.accepted_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.membership_roles mr
      JOIN public.roles role ON role.id = mr.role_id AND role.is_billable
      WHERE mr.membership_id = membership_row.id AND mr.revoked_at IS NULL
    );
  SELECT * INTO allocation_row FROM public.paid_seat_allocations
  WHERE organization_id = membership_row.organization_id
    AND membership_id = membership_row.id FOR UPDATE;
  SELECT count(*) INTO active_seats FROM public.paid_seat_allocations
  WHERE organization_id = membership_row.organization_id AND status = 'active';
  event_key := 'membership-sync:' || membership_row.id::text || ':'
    || txid_current()::text || ':' || TG_OP;
  IF should_be_active AND (allocation_row.id IS NULL OR allocation_row.status = 'released') THEN
    IF active_seats >= subscription_row.paid_seat_limit THEN
      RAISE EXCEPTION 'commercial_seat_limit_reached';
    END IF;
    INSERT INTO public.paid_seat_allocations (
      organization_id, membership_id, status, allocation_key
    ) VALUES (
      membership_row.organization_id, membership_row.id, 'active', event_key
    ) ON CONFLICT (organization_id, membership_id) DO UPDATE SET
      status = 'active', released_at = NULL, allocation_key = EXCLUDED.allocation_key
    RETURNING * INTO allocation_row;
    INSERT INTO public.commercial_seat_events (
      organization_id, allocation_id, delta, seats_before, seats_after, event_key
    ) VALUES (
      membership_row.organization_id, allocation_row.id, 1,
      active_seats, active_seats + 1, event_key
    );
  ELSIF NOT should_be_active AND allocation_row.status = 'active' THEN
    UPDATE public.paid_seat_allocations SET status = 'released', released_at = now()
    WHERE id = allocation_row.id;
    INSERT INTO public.commercial_seat_events (
      organization_id, allocation_id, delta, seats_before, seats_after, event_key
    ) VALUES (
      membership_row.organization_id, allocation_row.id, -1,
      active_seats, active_seats - 1, event_key
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

COMMIT;
