-- Verify RLS is enabled on leads
ALTER TABLE IF EXISTS leads ENABLE ROW LEVEL SECURITY;
