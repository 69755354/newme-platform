\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id) VALUES ('79000000-9000-4000-8000-000000000001');
INSERT INTO public.profiles(id,email,role,is_active) VALUES
  ('79000000-9000-4000-8000-000000000001',
   'product-saas-99999999-9999-4999-8999-999999999999-admin@invalid.test','admin',false);
INSERT INTO public.organizations(id,slug,name,industry_key,plan_key,billable_seat_limit,status,data_region,timezone) VALUES
  ('79000000-9000-4000-8000-000000000010',
   'product-saas-99999999-9999-4999-8999-999999999999',
   '[PRODUCT-UAT 99999999-9999-4999-8999-999999999999] organization',
   'real_estate','growth',20,'active','uae','Asia/Dubai');
INSERT INTO public.memberships(id,organization_id,user_id,status,accepted_at) VALUES
  ('79000000-9000-4000-8000-000000000011','79000000-9000-4000-8000-000000000010',
   '79000000-9000-4000-8000-000000000001','inactive',now());
INSERT INTO public.audit_events(id,organization_id,actor_user_id,action,target_type,target_id,outcome,request_id,metadata) VALUES
  ('79000000-9000-4000-8000-000000000020','79000000-9000-4000-8000-000000000010',
   '79000000-9000-4000-8000-000000000001','organization.member.deactivate','membership',
   '79000000-9000-4000-8000-000000000011','success','sam78-billable-seat-cleanup',
   '{"target_user_id":"79000000-9000-4000-8000-000000000001"}'::jsonb);
SET ROLE service_role;
DELETE FROM public.audit_events WHERE id='79000000-9000-4000-8000-000000000020';
RESET ROLE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_events WHERE id='79000000-9000-4000-8000-000000000020') THEN
    RAISE EXCEPTION '20-seat synthetic Product/SaaS cleanup was rejected';
  END IF;
END $$;
ROLLBACK;
SELECT 'SAM-78 Product/SaaS 20-seat cleanup boundary passed' AS result;
