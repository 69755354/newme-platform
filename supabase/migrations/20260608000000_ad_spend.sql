-- Create ad_spend table for Meta Ads campaign expense tracking
CREATE TABLE IF NOT EXISTS ad_spend (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_name TEXT,
  adset_name TEXT,
  ad_name TEXT,
  spend_date DATE,
  amount NUMERIC(12,2),
  currency TEXT DEFAULT 'AED',
  impressions INTEGER,
  clicks INTEGER,
  source TEXT DEFAULT 'meta',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for common query patterns
CREATE INDEX IF NOT EXISTS idx_ad_spend_campaign ON ad_spend(campaign_name);
CREATE INDEX IF NOT EXISTS idx_ad_spend_date ON ad_spend(spend_date);

-- Row Level Security
ALTER TABLE ad_spend ENABLE ROW LEVEL SECURITY;

-- Only boss/admin can read ad_spend (sales should NOT see spending data)
CREATE POLICY "boss_admin_read_ad_spend" ON ad_spend
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role IN ('boss', 'admin')
    )
  );

-- Only boss/admin can insert ad_spend
CREATE POLICY "boss_admin_insert_ad_spend" ON ad_spend
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role IN ('boss', 'admin')
    )
  );
