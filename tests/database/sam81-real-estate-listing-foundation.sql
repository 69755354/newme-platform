\set ON_ERROR_STOP on

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('active', 'read_only', 'suspended'))
);
CREATE TABLE public.memberships (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  status text NOT NULL,
  accepted_at timestamptz,
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE public.leads (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  UNIQUE (organization_id, id)
);

CREATE FUNCTION public.requested_organization_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(
    COALESCE(current_setting('request.headers', true), '{}')::jsonb
      ->> 'x-newme-organization-id',
    ''
  )::uuid
$$;
CREATE FUNCTION public.v4_actor_has_capability(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_capability_key text,
  p_access_mode text DEFAULT 'read'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organizations organization
    JOIN public.memberships membership
      ON membership.organization_id = organization.id
    JOIN public.profiles profile ON profile.id = membership.user_id
    WHERE organization.id = p_organization_id
      AND p_organization_id = public.requested_organization_id()
      AND p_actor_user_id = auth.uid()
      AND membership.user_id = p_actor_user_id
      AND profile.is_active IS TRUE
      AND membership.status = 'active'
      AND membership.accepted_at IS NOT NULL
      AND organization.status = 'active'
      AND p_capability_key IN (
        'organization.data.read', 'organization.data.create',
        'organization.data.update', 'organization.data.delete'
      )
  )
$$;
GRANT EXECUTE ON FUNCTION public.requested_organization_id() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text)
  TO authenticated, service_role;

INSERT INTO auth.users(id) VALUES
  ('81000000-0000-4000-8000-000000000001'),
  ('81000000-0000-4000-8000-000000000002');
INSERT INTO public.profiles(id, is_active) VALUES
  ('81000000-0000-4000-8000-000000000001', true),
  ('81000000-0000-4000-8000-000000000002', true);
INSERT INTO public.organizations(id, status) VALUES
  ('81000000-0000-4000-8000-000000000101', 'active'),
  ('81000000-0000-4000-8000-000000000102', 'active');
INSERT INTO public.memberships(organization_id, user_id, status, accepted_at) VALUES
  ('81000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000001', 'active', now()),
  ('81000000-0000-4000-8000-000000000102', '81000000-0000-4000-8000-000000000002', 'active', now());
INSERT INTO public.leads(id, organization_id) VALUES
  ('81000000-0000-4000-8000-000000000201', '81000000-0000-4000-8000-000000000101'),
  ('81000000-0000-4000-8000-000000000202', '81000000-0000-4000-8000-000000000102');

\ir ../../supabase/migrations/20260805020000_sam81_real_estate_listing_foundation.sql

SET ROLE authenticated;
SET request.jwt.claim.sub = '81000000-0000-4000-8000-000000000001';
SET request.headers = '{"x-newme-organization-id":"81000000-0000-4000-8000-000000000101"}';

INSERT INTO public.real_estate_parties(
  id, organization_id, party_type, display_name, normalized_email
) VALUES (
  '81000000-0000-4000-8000-000000000301',
  '81000000-0000-4000-8000-000000000101',
  'landlord', 'Owner A', 'owner.a@invalid.test'
);
INSERT INTO public.real_estate_properties(
  id, organization_id, owner_party_id, property_reference, property_type, address_line
) VALUES (
  '81000000-0000-4000-8000-000000000401',
  '81000000-0000-4000-8000-000000000101',
  '81000000-0000-4000-8000-000000000301',
  'A-101', 'apartment', 'Dubai'
);
INSERT INTO public.real_estate_listings(
  id, organization_id, property_id, owner_party_id, listing_reference, status, asking_price
) VALUES (
  '81000000-0000-4000-8000-000000000501',
  '81000000-0000-4000-8000-000000000101',
  '81000000-0000-4000-8000-000000000401',
  '81000000-0000-4000-8000-000000000301',
  'LIST-A-101', 'ready', 1000000
);
INSERT INTO public.real_estate_listing_assets(
  organization_id, listing_id, asset_kind, asset_reference, verification_status
) VALUES
  ('81000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000501', 'media', 'tenant/a/image-1', 'verified'),
  ('81000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000501', 'document', 'tenant/a/permit-1', 'verified');
INSERT INTO public.real_estate_viewings(
  organization_id, listing_id, lead_id, scheduled_at, idempotency_key
) VALUES (
  '81000000-0000-4000-8000-000000000101',
  '81000000-0000-4000-8000-000000000501',
  '81000000-0000-4000-8000-000000000201', now() + interval '1 day', 'sam81-viewing-a'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.v_real_estate_listing_publish_readiness
    WHERE listing_id = '81000000-0000-4000-8000-000000000501'
      AND is_publish_ready IS TRUE
      AND publish_state = 'disabled'
  ) THEN
    RAISE EXCEPTION 'sam81_publish_readiness_evidence_missing';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.real_estate_viewings(
      organization_id, listing_id, lead_id, scheduled_at, idempotency_key
    ) VALUES (
      '81000000-0000-4000-8000-000000000101',
      '81000000-0000-4000-8000-000000000501',
      '81000000-0000-4000-8000-000000000201', now() + interval '1 day', 'sam81-viewing-a'
    );
    RAISE EXCEPTION 'sam81_viewing_idempotency_not_enforced';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.real_estate_listings(
      organization_id, property_id, owner_party_id, listing_reference, asking_price, publish_state
    ) VALUES (
      '81000000-0000-4000-8000-000000000101',
      '81000000-0000-4000-8000-000000000401',
      '81000000-0000-4000-8000-000000000301', 'PORTAL-LEAK', 1, 'queued'
    );
    RAISE EXCEPTION 'sam81_external_publish_state_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.real_estate_listings;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'sam81_org_a_listing_visibility:%', visible_count; END IF;
END
$$;

SET request.headers = '{"x-newme-organization-id":"81000000-0000-4000-8000-000000000102"}';
DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.real_estate_listings;
  IF visible_count <> 0 THEN RAISE EXCEPTION 'sam81_cross_org_read_visible:%', visible_count; END IF;
  BEGIN
    INSERT INTO public.real_estate_parties(organization_id, party_type, display_name)
    VALUES ('81000000-0000-4000-8000-000000000102', 'landlord', 'Forbidden B');
    RAISE EXCEPTION 'sam81_wrong_org_write_accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

RESET ROLE;
INSERT INTO public.real_estate_parties(
  id, organization_id, party_type, display_name, created_by
) VALUES (
  '81000000-0000-4000-8000-000000000302',
  '81000000-0000-4000-8000-000000000102', 'landlord', 'Owner B',
  '81000000-0000-4000-8000-000000000002'
);

SET ROLE authenticated;
SET request.headers = '{"x-newme-organization-id":"81000000-0000-4000-8000-000000000101"}';
DO $$
BEGIN
  BEGIN
    INSERT INTO public.real_estate_properties(
      organization_id, owner_party_id, property_reference, property_type, address_line
    ) VALUES (
      '81000000-0000-4000-8000-000000000101',
      '81000000-0000-4000-8000-000000000302', 'CROSS-OWNER', 'villa', 'Dubai'
    );
    RAISE EXCEPTION 'sam81_cross_org_owner_accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END
$$;

RESET ROLE;
UPDATE public.profiles SET is_active = false
WHERE id = '81000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.real_estate_parties(organization_id, party_type, display_name)
    VALUES ('81000000-0000-4000-8000-000000000101', 'landlord', 'Inactive actor');
    RAISE EXCEPTION 'sam81_inactive_write_accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

RESET ROLE;
SET newme.environment = 'test';
DELETE FROM public.real_estate_viewings;
DELETE FROM public.real_estate_listing_assets;
DELETE FROM public.real_estate_listings;
DELETE FROM public.real_estate_properties;
DELETE FROM public.real_estate_parties;
\ir ../../supabase/rollback/20260805020000_sam81_real_estate_listing_foundation_rollback.sql
DO $$
BEGIN
  IF to_regclass('public.real_estate_viewings') IS NOT NULL
    OR to_regclass('public.real_estate_parties') IS NOT NULL
  THEN RAISE EXCEPTION 'sam81_rollback_residue'; END IF;
END
$$;

ROLLBACK;
