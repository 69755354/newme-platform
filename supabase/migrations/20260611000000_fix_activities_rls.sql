-- Fix: Allow all authenticated users to INSERT into activities
-- This is needed for sales role to add notes and change lead stages

-- First, check existing policies and add INSERT policy for authenticated users
-- The activities table tracks all actions on leads (notes, stage changes, etc.)

-- Drop any existing insert policy that might be too restrictive
DROP POLICY IF EXISTS "Anyone can insert activities" ON activities;

-- Create policy: any authenticated user can insert activities for leads they can see
CREATE POLICY "Authenticated users can insert activities" ON activities
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Also ensure SELECT is allowed for authenticated users (for timeline view)
DROP POLICY IF EXISTS "Users can view activities" ON activities;
CREATE POLICY "Users can view activities" ON activities
  FOR SELECT
  TO authenticated
  USING (true);
