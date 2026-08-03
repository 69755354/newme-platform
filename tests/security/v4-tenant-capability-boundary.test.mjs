import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("V4 capability foundation is one deployable migration with tenant-safe compatibility", async () => {
  const [expand, expandRollback, types, gate] = await Promise.all([
    read("supabase/migrations/20260803100000_v4_tenant_capability_boundary.sql"),
    read("supabase/rollback/20260803100000_v4_tenant_capability_boundary_rollback.sql"),
    read("src/types/database.ts"),
    read("scripts/run-sam23-database-gate.mjs"),
  ]);

  assert.match(expand, /CREATE TABLE public\.capabilities/);
  assert.match(expand, /CREATE TABLE public\.role_capabilities/);
  assert.match(expand, /catalog\.products\.read/);
  assert.match(expand, /catalog\.products\.create/);
  assert.match(expand, /catalog\.products\.update/);
  assert.match(expand, /catalog\.products\.delete/);
  assert.match(expand, /catalog\.products\.import/);
  assert.doesNotMatch(expand, /organization\.members\.manage/);
  assert.match(expand, /enforce_role_capability_scope/);
  assert.match(expand, /role_capability_scope_mismatch/);
  assert.match(expand, /ADD COLUMN organization_id uuid/);
  assert.match(expand, /product_tenant_reference_unresolved/);
  assert.match(expand, /NEW\.organization_id := NEW\.tenant_id/);
  assert.match(expand, /product_organization_context_required/);
  assert.doesNotMatch(expand, /ALTER COLUMN organization_id SET NOT NULL/);
  assert.doesNotMatch(expand, /products_organization_sku_unique/);
  assert.match(expand, /product_organization_context/);
  assert.match(expand, /count\(DISTINCT membership\.organization_id\) = 1/);
  assert.match(expand, /CREATE POLICY v4_products_capability_read/);
  assert.match(expand, /REVOKE ALL ON TABLE public\.products FROM PUBLIC, anon, authenticated/);
  assert.match(expand, /GRANT SELECT, UPDATE, DELETE ON TABLE public\.products/);
  assert.match(expand, /create_product_for_organization/);
  assert.match(expand, /import_products_for_organization/);
  assert.match(expand, /product_payload_is_valid/);
  assert.match(expand, /btrim\(p_product ->> 'name'\) <> ''/);
  assert.match(expand, /btrim\(p_product ->> 'sku'\) <> ''/);
  assert.match(expand, /jsonb_typeof\(p_product -> 'unit_price'\) = 'number'/);
  assert.match(expand, /jsonb_typeof\(p_product -> 'is_active'\) = 'boolean'/);
  assert.match(expand, /'knx', 'hvac', 'audio', 'network', 'security'/);
  assert.match(expand, /jsonb_array_length\(p_products\) > 2000/);
  assert.match(expand, /octet_length\(convert_to\(p_products::text, 'UTF8'\)\) > 5242880/);
  assert.match(expand, /catalog\.products\.import/);
  assert.match(expand, /ALTER TABLE public\.products FORCE ROW LEVEL SECURITY/);
  assert.match(expand, /profile\.is_active IS TRUE/);
  assert.match(expand, /membership\.status = 'active'/);
  assert.match(expand, /membership\.accepted_at IS NOT NULL/);
  assert.match(expand, /organization\.status IN \('active', 'read_only'\)/);
  assert.match(expand, /role\.scope = 'organization'/);
  assert.match(expand, /capability\.scope = 'organization'/);
  assert.match(expandRollback, /expand_rollback_nonlegacy_products_present/);
  assert.match(expandRollback, /rollback_mapping_drift/);
  assert.match(expandRollback, /CREATE POLICY policy_products_select_admin/);
  assert.match(types, /capabilities: \{/);
  assert.match(types, /role_capabilities: \{/);
  assert.match(types, /products:[\s\S]*organization_id: string/);
  assert.match(types, /create_product_for_organization:[\s\S]*p_product: Json/);
  assert.match(types, /import_products_for_organization:[\s\S]*p_products: Json/);
  assert.match(gate, /v4_tenant_capability_fixture/);
  assert.match(gate, /v4_tenant_capability_rollback_guard_fixture/);
  assert.match(gate, /v4_tenant_capability_expand_rollback/);
  assert.doesNotMatch(gate, /v4_tenant_capability_contract_apply/);
});

test("server authorization resolves selected membership capabilities and write lifecycle", async () => {
  const authorization = await read("src/lib/organization-authorization.ts");

  assert.match(authorization, /getRequestAuthContext\(request\)/);
  assert.match(authorization, /getRequestedOrganizationId\(request\)/);
  assert.match(authorization, /\.eq\("organization_id", organizationId\)/);
  assert.match(authorization, /\.eq\("user_id", context\.user\.id\)/);
  assert.match(authorization, /\.eq\("status", "active"\)/);
  assert.match(authorization, /\.not\("accepted_at", "is", null\)/);
  assert.match(authorization, /\.is\("revoked_at", null\)/);
  assert.match(authorization, /capabilities\.includes\(requiredCapability\)/);
  assert.match(authorization, /readonly context: RequestAuthContext/);
  assert.match(authorization, /accessMode: "read" \| "write" \| "export" = "read"/);
  assert.match(authorization, /accessMode === "write"/);
  assert.match(authorization, /\["active", "read_only"\]/);
  assert.match(authorization, /"suspended", "export_only"/);
  assert.doesNotMatch(authorization, /context\.role/);
});

test("product list and import enforce organization capability and RLS", async () => {
  const [listRoute, importRoute] = await Promise.all([
    read("src/app/api/products/route.ts"),
    read("src/app/api/products/import/route.ts"),
  ]);

  assert.match(listRoute, /"catalog\.products\.read"/);
  assert.match(listRoute, /applyRequestAuthCookies/);
  assert.match(listRoute, /access\.context\.supabase/);
  assert.match(listRoute, /\.eq\("organization_id", access\.organizationId\)/);
  assert.match(importRoute, /"catalog\.products\.import"/);
  assert.match(importRoute, /"write"/);
  assert.match(importRoute, /MAX_FILE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(importRoute, /MAX_REQUEST_BYTES = MAX_FILE_BYTES \+ 64 \* 1024/);
  assert.match(importRoute, /MAX_IMPORT_ROWS = 2_000/);
  assert.match(importRoute, /request\.body\.getReader\(\)/);
  assert.match(importRoute, /totalBytes > MAX_REQUEST_BYTES/);
  assert.match(importRoute, /reader\.cancel\("product_import_request_too_large"\)/);
  assert.match(importRoute, /file instanceof File/);
  assert.doesNotMatch(importRoute, /request\.formData\(\)/);
  assert.match(importRoute, /\.rpc\("import_products_for_organization"/);
  assert.match(importRoute, /p_organization_id: access\.organizationId/);
  assert.match(importRoute, /p_products: validated\.map/);
  assert.match(importRoute, /access\.context\.supabase/);
  assert.match(importRoute, /applyRequestAuthCookies/);
  assert.match(importRoute, /product_import_insert_failed/);
  assert.doesNotMatch(importRoute, /singleErr\.message/);
  assert.doesNotMatch(importRoute, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(importRoute, /createClient\(/);
  assert.doesNotMatch(importRoute, /\.from\("products"\)\s*\.insert/);
  assert.doesNotMatch(importRoute, /profile\.role/);
});
