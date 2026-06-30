-- =============================================================================
-- Migration: Fix naked table references in 7 SECURITY DEFINER functions
-- Date: 2026-07-01
-- Root cause: 7 SECURITY DEFINER functions reference tables without schema
-- qualification (e.g., FROM profiles instead of FROM public.profiles).
-- While these work today because search_path includes public, any future
-- security hardening adding SET search_path = '' would cause "relation does
-- not exist" errors. This has already happened twice with get_my_role() and
-- handle_new_user().
-- Fix: Use fully qualified public.<table> for all table references.
-- Functions fixed:
--   1. check_milestone_order()      — lead_milestones, leads
--   2. detect_stale_leads()         — leads, activities, business_events, notifications, profiles
--   3. generate_quote_no()          — quotations
--   4. get_team_activity()          — user_session_daily, profiles
--   5. reassign_lead()              — leads, business_events, notifications
--   6. sync_user_email_to_profile() — profiles
--   7. update_installment_status()  — installment_plans, payments, contracts
-- =============================================================================

-- 1. check_milestone_order: lead_milestones → public.lead_milestones, leads → public.leads
CREATE OR REPLACE FUNCTION public.check_milestone_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  last_key TEXT;
BEGIN
  SELECT milestone_key INTO last_key
  FROM public.lead_milestones WHERE lead_id = NEW.lead_id
  ORDER BY completed_at DESC LIMIT 1;
  IF last_key IS NOT NULL THEN
    IF milestone_order(NEW.milestone_key) <= milestone_order(last_key) THEN
      RAISE EXCEPTION 'Cannot go backwards: % -> %', last_key, NEW.milestone_key;
    END IF;
    IF milestone_order(NEW.milestone_key) > milestone_order(last_key) + 1 THEN
      RAISE EXCEPTION 'Cannot skip: % -> %', last_key, NEW.milestone_key;
    END IF;
  END IF;
  UPDATE public.leads SET current_milestone = NEW.milestone_key WHERE id = NEW.lead_id;
  RETURN NEW;
END;
$function$;

-- 2. detect_stale_leads: leads, activities, business_events, notifications, profiles → public.*
CREATE OR REPLACE FUNCTION public.detect_stale_leads(stale_days integer DEFAULT 7)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    affected_count INT;
    stale_lead RECORD;
BEGIN
    affected_count := 0;

    FOR stale_lead IN
        SELECT l.id, l.assigned_to, l.customer_name
        FROM public.leads l
        WHERE l.lead_status NOT IN ('closed_won', 'closed_lost', 'disqualified')
          AND l.recovery_candidate = false
          AND l.assigned_to IS NOT NULL
          AND NOT EXISTS (
              -- No activity in the last N days
              SELECT 1 FROM public.activities a
              WHERE a.lead_id = l.id
                AND a.created_at > now() - (stale_days || ' days')::INTERVAL
          )
          AND NOT EXISTS (
              -- No follow-up scheduled in the future
              SELECT 1 FROM public.activities a
              WHERE a.lead_id = l.id
                AND a.type = 'follow_up'
                AND a.due_at > now()
          )
    LOOP
        -- Mark as recovery candidate
        UPDATE public.leads
        SET recovery_candidate = true,
            sales_manager_review = true
        WHERE id = stale_lead.id;

        -- Log event
        INSERT INTO public.business_events (lead_id, user_id, event_type, event_data)
        VALUES (
            stale_lead.id, NULL, 'lead_stale_detected',
            jsonb_build_object(
                'stale_days', stale_days,
                'assigned_to', stale_lead.assigned_to,
                'customer_name', stale_lead.customer_name
            )
        );

        -- Notify admin (boss)
        INSERT INTO public.notifications (user_id, type, title, body, related_id)
        SELECT p.id, 'followup_reminder', 'Stale Lead Alert',
               'Lead "' || COALESCE(stale_lead.customer_name,'Unknown') || '" has no activity for ' || stale_days || ' days. Consider reassignment.',
               stale_lead.id
        FROM public.profiles p
        WHERE p.role = 'admin' AND p.is_active = true;

        affected_count := affected_count + 1;
    END LOOP;

    RETURN affected_count;
END;
$function$;

-- 3. generate_quote_no: quotations → public.quotations
CREATE OR REPLACE FUNCTION public.generate_quote_no(year_param integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  next_seq integer;
  year_str text;
BEGIN
  -- Serialize all quote_no generation with a transaction-level advisory lock
  PERFORM pg_advisory_xact_lock(42);

  year_str := year_param::text;

  SELECT COALESCE(
    (SELECT MAX(NULLIF(regexp_replace(quote_no, '^NM-\d{4}-', ''), ''))
     FROM public.quotations
     WHERE quote_no LIKE 'NM-' || year_str || '-%')::integer,
    0
  ) + 1 INTO next_seq;

  RETURN 'NM-' || year_str || '-' || lpad(next_seq::text, 4, '0');
END;
$function$;

-- 4. get_team_activity: user_session_daily → public.user_session_daily, profiles → public.profiles
CREATE OR REPLACE FUNCTION public.get_team_activity(p_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(user_id uuid, full_name text, role text, first_login timestamp with time zone, last_active timestamp with time zone, total_duration_seconds integer, login_count integer, pages_viewed integer, actions_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    us.user_id,
    p.full_name,
    p.role,
    us.first_login,
    us.last_active,
    us.total_duration_seconds,
    us.login_count,
    us.pages_viewed,
    us.actions_count
  FROM public.user_session_daily us
  JOIN public.profiles p ON us.user_id = p.id
  WHERE us.session_date = p_date
  ORDER BY
    CASE p.role
      WHEN 'boss' THEN 1
      WHEN 'admin' THEN 2
      WHEN 'sales' THEN 3
      ELSE 4
    END,
    p.full_name;
END;
$function$;

-- 5. reassign_lead: leads, business_events, notifications → public.*
CREATE OR REPLACE FUNCTION public.reassign_lead(p_lead_id uuid, p_new_sales uuid, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    old_sales UUID;
    v_customer_name TEXT;
BEGIN
    SELECT assigned_to, customer_name INTO old_sales, v_customer_name
    FROM public.leads WHERE id = p_lead_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lead not found: %', p_lead_id;
    END IF;

    -- Update assignment
    UPDATE public.leads
    SET assigned_to = p_new_sales,
        transfer_candidate = false,
        recovery_candidate = false,
        hold_since = NULL
    WHERE id = p_lead_id;

    -- Log transfer
    INSERT INTO public.business_events (lead_id, user_id, event_type, event_data)
    VALUES (
        p_lead_id, auth.uid(), 'lead_reassigned',
        jsonb_build_object(
            'from_sales', old_sales,
            'to_sales', p_new_sales,
            'reason', p_reason
        )
    );

    -- Notify new sales
    INSERT INTO public.notifications (user_id, type, title, body, related_id)
    VALUES (
        p_new_sales, 'lead_assigned', 'Lead Transferred to You',
        'Lead "' || COALESCE(v_customer_name, 'Unknown') || '" has been transferred to you.',
        p_lead_id
    );

    RETURN true;
END;
$function$;

-- 6. sync_user_email_to_profile: profiles → public.profiles
CREATE OR REPLACE FUNCTION public.sync_user_email_to_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles SET email = NEW.email WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

-- 7. update_installment_status: installment_plans, payments, contracts → public.*
CREATE OR REPLACE FUNCTION public.update_installment_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_plan_amount DECIMAL(12,2);
  v_contract_id UUID;
  v_total_paid  DECIMAL(12,2);
BEGIN
  IF NEW.confirmed != true OR NEW.installment_plan_id IS NULL THEN RETURN NEW; END IF;
  SELECT ip.amount, ip.contract_id INTO v_plan_amount, v_contract_id
  FROM public.installment_plans ip WHERE ip.id = NEW.installment_plan_id;
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.payments WHERE installment_plan_id = NEW.installment_plan_id AND confirmed = true;
  UPDATE public.installment_plans SET paid_amount = v_total_paid, updated_at = now()
  WHERE id = NEW.installment_plan_id;
  IF v_total_paid >= v_plan_amount THEN
    UPDATE public.installment_plans SET status = 'paid', updated_at = now()
    WHERE id = NEW.installment_plan_id AND status = 'pending';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.installment_plans
    WHERE contract_id = v_contract_id AND status NOT IN ('paid', 'cancelled')) THEN
    UPDATE public.contracts SET status = 'completed', updated_at = now()
    WHERE id = v_contract_id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$function$;
