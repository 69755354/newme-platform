-- P0 Security: Tighten notifications INSERT RLS
-- The notifications table had WITH CHECK (true) for authenticated inserts.
-- Server-side code uses supabaseAdmin (service_role bypasses RLS),
-- so tightening this adds defense-in-depth without breaking existing flows.
-- Drops: 20260618065713 (re-introduced WITH CHECK true)
DROP POLICY IF EXISTS notifications_service_insert ON notifications;
CREATE POLICY notifications_service_insert ON notifications
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
