-- CRM: P0-2 Fix notifications RLS
DROP POLICY IF EXISTS notifications_service_insert ON notifications;
CREATE POLICY notifications_service_insert ON notifications
  FOR INSERT TO authenticated WITH CHECK (true);