-- Notifications / 站内信 系统
-- 2026-06-07

CREATE TABLE IF NOT EXISTS notifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES profiles(id) NOT NULL,
    type          VARCHAR(50) NOT NULL CHECK (type IN (
      'lead_assigned','lead_stage_change','payment_overdue',
      'payment_received','kpi_target_set','contract_signed','followup_reminder'
    )),
    title         TEXT NOT NULL,
    body          TEXT,
    related_id    UUID,          -- 关联的 lead/contract/payment/KPI 等 ID
    related_type  VARCHAR(30) CHECK (related_type IN ('lead','contract','payment','kpi')),
    is_read       BOOLEAN DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- User can read their own notifications
CREATE POLICY "notifications_user_read" ON notifications FOR SELECT
  USING (user_id = auth.uid());

-- Admin/boss can read all notifications
CREATE POLICY "notifications_admin_read_all" ON notifications FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

-- User can update (mark read) their own notifications
CREATE POLICY "notifications_user_update" ON notifications FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service role can insert (handled by supabaseAdmin on server side)
CREATE POLICY "notifications_service_insert" ON notifications FOR INSERT
  WITH CHECK (true);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created
  ON notifications(user_id, is_read, created_at DESC);
