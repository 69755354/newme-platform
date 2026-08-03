\set ON_ERROR_STOP on

INSERT INTO auth.users(id) VALUES ('78000000-0090-4000-8000-000000000090');
INSERT INTO public.profiles(id, role, is_active)
VALUES ('78000000-0090-4000-8000-000000000090', 'sales', true);
INSERT INTO public.organizations(
  id, slug, name, industry_key, status, billable_seat_limit
) VALUES (
  '78000000-9090-4000-8000-000000000090',
  'sam78-concurrency', 'SAM-78 concurrency', 'real_estate', 'active', 3
);
INSERT INTO public.memberships(
  id, organization_id, user_id, status, accepted_at
) VALUES (
  '78000000-9190-4000-8000-000000000090',
  '78000000-9090-4000-8000-000000000090',
  '78000000-0090-4000-8000-000000000090', 'active', now()
);
INSERT INTO public.membership_roles(
  organization_id, membership_id, role_id
)
SELECT
  '78000000-9090-4000-8000-000000000090',
  '78000000-9190-4000-8000-000000000090', role.id
FROM public.roles role
WHERE role.scope = 'organization' AND role.role_key = 'org_owner';

INSERT INTO public.leads(
  id, organization_id, customer_name, source, stage, quality, lead_status,
  assigned_to, created_by
) VALUES
  ('78000000-9290-4000-8000-000000000090',
   '78000000-9090-4000-8000-000000000090', 'Concurrent contract lead',
   'offline', 'new', 'pending', 'pending',
   '78000000-0090-4000-8000-000000000090',
   '78000000-0090-4000-8000-000000000090'),
  ('78000000-9291-4000-8000-000000000091',
   '78000000-9090-4000-8000-000000000090', 'Concurrent quotation lead',
   'offline', 'new', 'pending', 'pending',
   '78000000-0090-4000-8000-000000000090',
   '78000000-0090-4000-8000-000000000090'),
  ('78000000-9292-4000-8000-000000000092',
   '78000000-9090-4000-8000-000000000090', 'Fault-injection quotation lead',
   'offline', 'new', 'pending', 'pending',
   '78000000-0090-4000-8000-000000000090',
   '78000000-0090-4000-8000-000000000090'),
  ('78000000-9293-4000-8000-000000000093',
   '78000000-9090-4000-8000-000000000090', 'Fault-injection contract lead',
   'offline', 'new', 'pending', 'pending',
   '78000000-0090-4000-8000-000000000090',
   '78000000-0090-4000-8000-000000000090');
INSERT INTO public.quotations(
  id, organization_id, lead_id, quote_no, total_amount, subtotal,
  status, created_by
) VALUES (
  '78000000-9390-4000-8000-000000000090',
  '78000000-9090-4000-8000-000000000090',
  '78000000-9291-4000-8000-000000000091', 'SAM78-CONCURRENT-QUOTE',
  200, 200, 'accepted', '78000000-0090-4000-8000-000000000090'
), (
  '78000000-9391-4000-8000-000000000091',
  '78000000-9090-4000-8000-000000000090',
  '78000000-9292-4000-8000-000000000092', 'SAM78-FAULT-QUOTE',
  300, 300, 'accepted', '78000000-0090-4000-8000-000000000090'
);
