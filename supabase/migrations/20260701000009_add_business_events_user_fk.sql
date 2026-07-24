-- Add FK: business_events.user_id → profiles.id
ALTER TABLE business_events DROP CONSTRAINT IF EXISTS fk_business_events_user_id;
ALTER TABLE business_events ADD CONSTRAINT fk_business_events_user_id FOREIGN KEY (user_id) REFERENCES profiles(id);
NOTIFY pgrst, 'reload schema';
