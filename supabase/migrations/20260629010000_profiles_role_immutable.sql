-- Fix P0: Prevent users from self-escalating their role
-- Fix P1-2: Restrict business_events public SELECT policy

-- ============================================================================
-- P0: profiles.role self-escalation prevention
-- ============================================================================

-- Trigger function: silently revert role changes by non-admin users on their own row
CREATE OR REPLACE FUNCTION prevent_role_self_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role AND auth.uid() = OLD.id THEN
    -- Only allow admin/boss to change roles
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'boss')
    ) THEN
      NEW.role := OLD.role;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_role_self_update ON profiles;
CREATE TRIGGER trg_prevent_role_self_update
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION prevent_role_self_update();

-- ============================================================================
-- P1-2: business_events public SELECT policy
-- ============================================================================

-- Remove overly permissive public policy
DROP POLICY IF EXISTS "business_events_select_public" ON business_events;

-- Replace with authenticated-only policy (CRM users must be logged in)
CREATE POLICY "business_events_select_authenticated" ON business_events
  FOR SELECT TO authenticated
  USING (true);
