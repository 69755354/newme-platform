BEGIN;

-- The legacy member-read policy permits every organization to which a
-- multi-organization member belongs.  Keep that membership authorization
-- layer, but require the request-scoped product organization context as a
-- restrictive SELECT boundary.  Single-membership callers retain the existing
-- product_organization_context() fallback; multi-membership callers must
-- explicitly select an organization.
DROP POLICY IF EXISTS sam78_organizations_selected_context_read
  ON public.organizations;
CREATE POLICY sam78_organizations_selected_context_read
  ON public.organizations
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    id = (SELECT public.product_organization_context())
  );

COMMIT;
