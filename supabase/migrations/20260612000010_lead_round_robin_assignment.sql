-- ============================================================
-- Lead Round-Robin Assignment + Churn Detection
-- For: NewMe CRM (Supabase)
-- Date: 2026-06-12
-- FIXED 2026-06-14: column names aligned to live schema
--   - notifications.message → notifications.body
--   - activities.activity_type → activities.type
--   - activities.scheduled_at → activities.due_at
--   - business_events(entity_type,entity_id,performed_by,metadata)
--       → business_events(lead_id,user_id,event_type,event_data)
--   - assign_new_lead: added next_action + next_followup_date params
--     (BEFORE INSERT trigger on leads requires them)
-- ============================================================

-- 1. Round-robin assignment state table
CREATE TABLE IF NOT EXISTS lead_assignment_state (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
    last_assigned_to UUID REFERENCES profiles(id),
    last_assigned_at TIMESTAMPTZ DEFAULT now(),
    round_robin_index INT DEFAULT 0
);

-- Initialize singleton
INSERT INTO lead_assignment_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- 2. RPC: auto_assign_lead — round-robin among active sales
-- Returns the UUID of the assigned sales rep
CREATE OR REPLACE FUNCTION auto_assign_lead()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    target_sales UUID;
    sales_list UUID[];
    next_idx INT;
    current_idx INT;
BEGIN
    -- Get active sales reps (role = 'sales' or 'admin', active)
    SELECT ARRAY_AGG(p.id) INTO sales_list
    FROM profiles p
    WHERE p.role IN ('sales', 'admin')
      AND p.is_active = true
      AND p.id IS NOT NULL;

    IF sales_list IS NULL OR array_length(sales_list, 1) = 0 THEN
        RAISE EXCEPTION 'No active sales reps available for assignment';
    END IF;

    -- Get current round-robin index
    SELECT round_robin_index INTO current_idx
    FROM lead_assignment_state WHERE id = 1;

    -- Next index (wrap around)
    next_idx := ((COALESCE(current_idx, 0) + 1) % array_length(sales_list, 1));
    -- PostgreSQL arrays are 1-indexed
    target_sales := sales_list[next_idx + 1];

    -- Update state
    UPDATE lead_assignment_state
    SET last_assigned_to = target_sales,
        last_assigned_at = now(),
        round_robin_index = next_idx
    WHERE id = 1;

    RETURN target_sales;
END;
$$;

-- 3. RPC: assign_new_lead — create lead with auto round-robin
-- Call this instead of direct INSERT into leads
CREATE OR REPLACE FUNCTION assign_new_lead(
    p_customer_name TEXT,
    p_phone TEXT DEFAULT NULL,
    p_email TEXT DEFAULT NULL,
    p_source TEXT DEFAULT 'other',
    p_quality TEXT DEFAULT 'pending',
    p_property_type TEXT DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_next_action TEXT DEFAULT 'Initial contact required',
    p_next_followup_date DATE DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_lead_id UUID;
    assigned_sales UUID;
    v_followup DATE;
BEGIN
    -- Get next sales rep via round-robin
    assigned_sales := auto_assign_lead();

    -- Default follow-up date = 3 days from now if not provided
    v_followup := COALESCE(p_next_followup_date, (CURRENT_DATE + INTERVAL '3 days')::DATE);

    -- Insert lead (stage + lead_status + next_action + next_followup_date
    -- required by BEFORE INSERT trigger)
    INSERT INTO leads (
        customer_name, phone, email, source, quality,
        property_type, notes, assigned_to,
        lead_status, stage, next_action, next_followup_date, created_at
    ) VALUES (
        p_customer_name, p_phone, p_email, p_source, p_quality,
        p_property_type, p_notes, assigned_sales,
        'hot', 'new', p_next_action, v_followup, now()
    ) RETURNING id INTO new_lead_id;

    -- Log assignment event
    INSERT INTO business_events (lead_id, user_id, event_type, event_data)
    VALUES (
        new_lead_id, auth.uid(), 'lead_assigned',
        jsonb_build_object(
            'assigned_to', assigned_sales,
            'method', 'round_robin'
        )
    );

    -- Create notification for the assigned sales rep
    INSERT INTO notifications (user_id, type, title, body, related_id)
    VALUES (
        assigned_sales,
        'lead_assigned',
        'New Lead Assigned',
        'A new lead has been auto-assigned to you: ' || COALESCE(p_customer_name, 'Unknown'),
        new_lead_id
    );

    RETURN new_lead_id;
END;
$$;

-- 4. RPC: detect_stale_leads — mark leads with no activity for 7+ days
-- Returns count of leads marked as recovery candidates
CREATE OR REPLACE FUNCTION detect_stale_leads(
    stale_days INT DEFAULT 7
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    affected_count INT;
    stale_lead RECORD;
BEGIN
    affected_count := 0;

    FOR stale_lead IN
        SELECT l.id, l.assigned_to, l.customer_name
        FROM leads l
        WHERE l.lead_status NOT IN ('closed_won', 'closed_lost', 'disqualified')
          AND l.recovery_candidate = false
          AND l.assigned_to IS NOT NULL
          AND NOT EXISTS (
              -- No activity in the last N days
              SELECT 1 FROM activities a
              WHERE a.lead_id = l.id
                AND a.created_at > now() - (stale_days || ' days')::INTERVAL
          )
          AND NOT EXISTS (
              -- No follow-up scheduled in the future
              SELECT 1 FROM activities a
              WHERE a.lead_id = l.id
                AND a.type = 'follow_up'
                AND a.due_at > now()
          )
    LOOP
        -- Mark as recovery candidate
        UPDATE leads
        SET recovery_candidate = true,
            sales_manager_review = true
        WHERE id = stale_lead.id;

        -- Log event
        INSERT INTO business_events (lead_id, user_id, event_type, event_data)
        VALUES (
            stale_lead.id, NULL, 'lead_stale_detected',
            jsonb_build_object(
                'stale_days', stale_days,
                'assigned_to', stale_lead.assigned_to,
                'customer_name', stale_lead.customer_name
            )
        );

        -- Notify admin (boss)
        INSERT INTO notifications (user_id, type, title, body, related_id)
        SELECT p.id, 'followup_reminder', 'Stale Lead Alert',
               'Lead "' || COALESCE(stale_lead.customer_name,'Unknown') || '" has no activity for ' || stale_days || ' days. Consider reassignment.',
               stale_lead.id
        FROM profiles p
        WHERE p.role = 'admin' AND p.is_active = true;

        affected_count := affected_count + 1;
    END LOOP;

    RETURN affected_count;
END;
$$;

-- 5. Convenience: manually reassign a lead
CREATE OR REPLACE FUNCTION reassign_lead(
    p_lead_id UUID,
    p_new_sales UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    old_sales UUID;
    v_customer_name TEXT;
BEGIN
    SELECT assigned_to, customer_name INTO old_sales, v_customer_name
    FROM leads WHERE id = p_lead_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lead not found: %', p_lead_id;
    END IF;

    -- Update assignment
    UPDATE leads
    SET assigned_to = p_new_sales,
        transfer_candidate = false,
        recovery_candidate = false,
        hold_since = NULL
    WHERE id = p_lead_id;

    -- Log transfer
    INSERT INTO business_events (lead_id, user_id, event_type, event_data)
    VALUES (
        p_lead_id, auth.uid(), 'lead_reassigned',
        jsonb_build_object(
            'from_sales', old_sales,
            'to_sales', p_new_sales,
            'reason', p_reason
        )
    );

    -- Notify new sales
    INSERT INTO notifications (user_id, type, title, body, related_id)
    VALUES (
        p_new_sales, 'lead_assigned', 'Lead Transferred to You',
        'Lead "' || COALESCE(v_customer_name, 'Unknown') || '" has been transferred to you.',
        p_lead_id
    );

    RETURN true;
END;
$$;

-- 6. Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION auto_assign_lead() TO authenticated;
GRANT EXECUTE ON FUNCTION assign_new_lead(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION detect_stale_leads(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION reassign_lead(UUID,UUID,TEXT) TO authenticated;

-- 7. Enable RLS on new table
ALTER TABLE lead_assignment_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admin can view assignment state" ON lead_assignment_state;
CREATE POLICY "Admin can view assignment state" ON lead_assignment_state
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- 8. Extend business_events event_type CHECK to allow lead-assignment events
ALTER TABLE business_events DROP CONSTRAINT IF EXISTS chk_event_type;
ALTER TABLE business_events ADD CONSTRAINT chk_event_type CHECK (
    event_type = ANY (ARRAY[
        'stage_change','owner_change','transfer',
        'quotation_sent','quotation_accepted','quotation_rejected',
        'won','lost','contract_activated','contract_completed','payment_recorded',
        'lead_assigned','lead_stale_detected','lead_reassigned'
    ]::text[])
) NOT VALID;
