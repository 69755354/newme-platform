-- =============================================================================
-- Fix: Sales users couldn't INSERT into business_events
-- Only admin/boss had INSERT permission (via be_admin_all).
-- When sales calls updateField() → writeEvent() → INSERT business_events,
-- it was silently failing (no matching RLS policy for INSERT on business_events for sales).
-- =============================================================================

-- Grant sales users the ability to INSERT into business_events
-- for tracking their own updates (stage changes, note additions, etc.)
CREATE POLICY IF NOT EXISTS be_sales_insert ON business_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    get_my_role() = 'sales' AND
    user_id = auth.uid()
  );

-- Also add UPDATE on business_events for sales (if they need to update their own events later)
CREATE POLICY IF NOT EXISTS be_sales_update ON business_events
  FOR UPDATE
  TO authenticated
  USING (get_my_role() = 'sales' AND user_id = auth.uid())
  WITH CHECK (get_my_role() = 'sales' AND user_id = auth.uid());

NOTIFY pgrst, 'reload schema';
