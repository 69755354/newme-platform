-- 20260624000003_fix_trg_lead_won.sql
-- P3: change trg_lead_won from stage → final_status
-- Trigger & guard clause now key off final_status = 'won' instead of stage = 'won'.
-- Function body (contract / 3-installment / project / event generation) is unchanged.

CREATE OR REPLACE FUNCTION on_lead_won()
RETURNS TRIGGER AS $$
DECLARE
  v_customer_id uuid;
  v_contract_id uuid;
  v_project_id uuid;
  v_contract_no text;
  v_contract_amount numeric;
  v_customer_name text;
  v_location text;
  v_property_type text;
  v_property_size integer;
  v_installment_count integer := 3;
  v_seq integer;
  v_pct numeric[];
  v_amount numeric;
  v_due_days integer[];
BEGIN
  -- Only trigger when final_status changes TO 'won' (not from 'won' to something else)
  IF NEW.final_status <> 'won' OR OLD.final_status = 'won' THEN
    RETURN NEW;
  END IF;

  -- Guard: skip if contract already exists for this lead (idempotency)
  IF EXISTS (SELECT 1 FROM contracts WHERE lead_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- Guard: skip if quotation_value is NULL or zero (can't create contract with 0 amount)
  IF COALESCE(NEW.quotation_value, 0) <= 0 THEN
    INSERT INTO activities (lead_id, user_id, type, content)
    VALUES (NEW.id, NEW.assigned_to, 'note',
      'Lead Won auto-creation skipped: contract_amount is 0 (quotation_value was NULL or zero).');
    RETURN NEW;
  END IF;

  v_contract_amount := COALESCE(NEW.quotation_value, 0);
  v_customer_name := COALESCE(NEW.customer_name, NEW.phone, 'Unknown Client');
  v_location := NEW.location;
  v_property_type := NEW.property_type;
  v_property_size := NEW.property_size_sqm;

  -- Step 1: Create or update customer
  IF NEW.customer_id IS NOT NULL THEN
    v_customer_id := NEW.customer_id;
    UPDATE customers SET
      total_contract_amount = COALESCE(total_contract_amount, 0) + v_contract_amount,
      last_activity_at = now(),
      name = CASE WHEN customers.name = 'Unknown' OR customers.name IS NULL THEN v_customer_name ELSE customers.name END,
      phone = COALESCE(customers.phone, NEW.phone),
      updated_at = now()
    WHERE id = v_customer_id;
  ELSE
    INSERT INTO customers (lead_id, name, phone, email, address, total_contract_amount, last_activity_at)
    VALUES (NEW.id, v_customer_name, NEW.phone, NEW.email, v_location, v_contract_amount, now())
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_customer_id;

    IF v_customer_id IS NOT NULL THEN
      UPDATE leads SET customer_id = v_customer_id WHERE id = NEW.id;
    END IF;
  END IF;

  -- Step 2: Generate contract number (NEW-YYYYMMDD-NNN)
  v_contract_no := 'NEW-' || to_char(now(), 'YYYYMMDD') || '-' ||
    lpad(COALESCE((SELECT count(*)::text FROM contracts WHERE contract_date = CURRENT_DATE), '0'), 3, '0');

  -- Step 3: Create contract
  INSERT INTO contracts (
    lead_id, customer_id, sales_id, created_by,
    contract_no, contract_date, contract_amount, currency,
    party_a_name, party_a_contact,
    party_b_name, status, approval_status
  ) VALUES (
    NEW.id, v_customer_id, NEW.assigned_to, NEW.assigned_to,
    v_contract_no, CURRENT_DATE, v_contract_amount, 'AED',
    v_customer_name, NEW.phone,
    'NewMe Smart Home FZCO', 'active', 'none'
  )
  RETURNING id INTO v_contract_id;

  -- Step 4: Create installment plans (50% / 30% / 20%)
  v_pct := ARRAY[0.50, 0.30, 0.20];
  v_due_days := ARRAY[0, 30, 60];

  FOR v_seq IN 1..v_installment_count LOOP
    v_amount := ROUND(v_contract_amount * v_pct[v_seq], 2);
    INSERT INTO installment_plans (contract_id, seq, amount, due_date, description, status)
    VALUES (
      v_contract_id, v_seq, v_amount,
      CURRENT_DATE + v_due_days[v_seq],
      CASE v_seq
        WHEN 1 THEN '首期款 (签约)'
        WHEN 2 THEN '二期款 (设备到货)'
        WHEN 3 THEN '尾款 (验收)'
      END,
      'pending'
    );
  END LOOP;

  -- Step 5: Create project
  INSERT INTO projects (
    customer_id, lead_id, contract_id, sales_id,
    name, property_type, property_size, location,
    phase, status, contract_amount
  ) VALUES (
    v_customer_id, NEW.id, v_contract_id, NEW.assigned_to,
    v_customer_name || ' - ' || COALESCE(v_property_type, 'Project'),
    v_property_type, v_property_size, v_location,
    'design', 'active', v_contract_amount
  )
  RETURNING id INTO v_project_id;

  -- Step 6: Log business event (using 'won' which is in chk_event_type)
  INSERT INTO business_events (lead_id, user_id, event_type, description, event_data)
  VALUES (
    NEW.id, NEW.assigned_to, 'won',
    'Automation: Lead Won → Contract#' || v_contract_no || ' + 3 installments + project',
    jsonb_build_object(
      'contract_id', v_contract_id,
      'contract_no', v_contract_no,
      'project_id', v_project_id,
      'installment_count', v_installment_count,
      'customer_id', v_customer_id
    )
  );

  -- Step 7: Log activity (using 'note' which is in activities_type_check)
  INSERT INTO activities (lead_id, user_id, type, content)
  VALUES (NEW.id, NEW.assigned_to, 'note', 'System auto-created: Contract#' || v_contract_no || ', 3 installment plans, project');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure the trigger is active
DROP TRIGGER IF EXISTS trg_lead_won ON leads;
CREATE TRIGGER trg_lead_won
  AFTER UPDATE OF final_status ON leads
  FOR EACH ROW
  WHEN (NEW.final_status = 'won')
  EXECUTE FUNCTION on_lead_won();

NOTIFY pgrst, 'reload schema';
