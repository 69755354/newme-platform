-- SAM-81 / V4-RE-001..004 foundation: organization-scoped parties,
-- properties, listings and viewings. This is deliberately not an external
-- portal, WhatsApp or DLD adapter. Listing publication remains disabled until
-- a separately approved adapter and reconciliation boundary exist.
BEGIN;

CREATE TABLE public.real_estate_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  party_type text NOT NULL CHECK (party_type IN (
    'landlord', 'buyer', 'tenant', 'broker', 'external_contact'
  )),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  normalized_email text,
  phone_e164 text,
  consent_status text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown', 'granted', 'withdrawn')),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'pending', 'verified', 'expired')),
  permit_reference text,
  trakheesi_reference text,
  makani_reference text,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (normalized_email IS NULL OR normalized_email = lower(btrim(normalized_email)))
);
CREATE UNIQUE INDEX real_estate_parties_organization_email_dedupe
  ON public.real_estate_parties (organization_id, party_type, normalized_email)
  WHERE normalized_email IS NOT NULL;

CREATE TABLE public.real_estate_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  owner_party_id uuid NOT NULL,
  property_reference text NOT NULL CHECK (btrim(property_reference) <> ''),
  property_type text NOT NULL CHECK (property_type IN ('apartment', 'villa', 'townhouse', 'office', 'retail', 'land')),
  unit_reference text,
  address_line text NOT NULL CHECK (btrim(address_line) <> ''),
  area_sqm numeric(12, 2) CHECK (area_sqm IS NULL OR area_sqm > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'available', 'unavailable', 'archived')),
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, property_reference),
  CONSTRAINT real_estate_properties_organization_owner_fkey
    FOREIGN KEY (organization_id, owner_party_id)
    REFERENCES public.real_estate_parties(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE public.real_estate_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL,
  owner_party_id uuid NOT NULL,
  listing_reference text NOT NULL CHECK (btrim(listing_reference) <> ''),
  exclusivity text NOT NULL DEFAULT 'non_exclusive' CHECK (exclusivity IN ('exclusive', 'non_exclusive')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'active', 'withdrawn', 'closed')),
  asking_price numeric(14, 2) NOT NULL CHECK (asking_price > 0),
  currency_code text NOT NULL DEFAULT 'AED' CHECK (currency_code ~ '^[A-Z]{3}$'),
  availability_status text NOT NULL DEFAULT 'available' CHECK (availability_status IN ('available', 'reserved', 'unavailable')),
  publish_state text NOT NULL DEFAULT 'disabled' CHECK (publish_state = 'disabled'),
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, listing_reference),
  CONSTRAINT real_estate_listings_organization_property_fkey
    FOREIGN KEY (organization_id, property_id)
    REFERENCES public.real_estate_properties(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT real_estate_listings_organization_owner_fkey
    FOREIGN KEY (organization_id, owner_party_id)
    REFERENCES public.real_estate_parties(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE public.real_estate_listing_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL,
  asset_kind text NOT NULL CHECK (asset_kind IN ('media', 'document')),
  asset_reference text NOT NULL CHECK (btrim(asset_reference) <> ''),
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, listing_id, asset_kind, asset_reference),
  CONSTRAINT real_estate_listing_assets_organization_listing_fkey
    FOREIGN KEY (organization_id, listing_id)
    REFERENCES public.real_estate_listings(organization_id, id)
    ON DELETE CASCADE
);

CREATE TABLE public.real_estate_viewings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'scheduled', 'attended', 'cancelled', 'no_show')),
  feedback text,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  CONSTRAINT real_estate_viewings_organization_listing_fkey
    FOREIGN KEY (organization_id, listing_id)
    REFERENCES public.real_estate_listings(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT real_estate_viewings_organization_lead_fkey
    FOREIGN KEY (organization_id, lead_id)
    REFERENCES public.leads(organization_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX real_estate_properties_organization_status_idx
  ON public.real_estate_properties (organization_id, status, id);
CREATE INDEX real_estate_listings_organization_status_idx
  ON public.real_estate_listings (organization_id, status, availability_status, id);
CREATE INDEX real_estate_viewings_organization_schedule_idx
  ON public.real_estate_viewings (organization_id, scheduled_at, id);

-- This is readiness evidence only. It never sends data to an external portal.
CREATE VIEW public.v_real_estate_listing_publish_readiness
WITH (security_invoker = true)
AS
SELECT
  listing.organization_id,
  listing.id AS listing_id,
  listing.status,
  listing.publish_state,
  (
    listing.status IN ('ready', 'active')
    AND EXISTS (
      SELECT 1 FROM public.real_estate_listing_assets asset
      WHERE asset.organization_id = listing.organization_id
        AND asset.listing_id = listing.id
        AND asset.asset_kind = 'media'
        AND asset.verification_status = 'verified'
    )
    AND EXISTS (
      SELECT 1 FROM public.real_estate_listing_assets asset
      WHERE asset.organization_id = listing.organization_id
        AND asset.listing_id = listing.id
        AND asset.asset_kind = 'document'
        AND asset.verification_status = 'verified'
    )
  ) AS is_publish_ready
FROM public.real_estate_listings listing;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'real_estate_parties', 'real_estate_properties', 'real_estate_listings',
    'real_estate_listing_assets', 'real_estate_viewings'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
    EXECUTE format(
      'CREATE POLICY sam81_read ON public.%I FOR SELECT TO authenticated USING ('
        || 'organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability(organization_id, auth.uid(), ''organization.data.read'', ''read''))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY sam81_insert ON public.%I FOR INSERT TO authenticated WITH CHECK ('
        || 'organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability(organization_id, auth.uid(), ''organization.data.create'', ''write''))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY sam81_update ON public.%I FOR UPDATE TO authenticated USING ('
        || 'organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability(organization_id, auth.uid(), ''organization.data.update'', ''write'')) '
        || 'WITH CHECK (organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability(organization_id, auth.uid(), ''organization.data.update'', ''write''))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY sam81_delete ON public.%I FOR DELETE TO authenticated USING ('
        || 'organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability(organization_id, auth.uid(), ''organization.data.delete'', ''write''))',
      table_name
    );
  END LOOP;
END
$$;

GRANT SELECT ON public.v_real_estate_listing_publish_readiness TO authenticated, service_role;
REVOKE ALL ON public.v_real_estate_listing_publish_readiness FROM PUBLIC, anon;

COMMIT;
