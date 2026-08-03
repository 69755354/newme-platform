\set ON_ERROR_STOP on

DELETE FROM public.activities
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.projects
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.contract_approvals
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.installment_plans
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
UPDATE public.quotations
SET contract_id = NULL
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.contracts
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.quotations
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.leads
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.contract_workflow_requests
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.organization_document_sequences
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.membership_roles
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.memberships
WHERE organization_id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.organizations
WHERE id = '78000000-9090-4000-8000-000000000090';
DELETE FROM public.profiles
WHERE id = '78000000-0090-4000-8000-000000000090';
DELETE FROM auth.users
WHERE id = '78000000-0090-4000-8000-000000000090';
