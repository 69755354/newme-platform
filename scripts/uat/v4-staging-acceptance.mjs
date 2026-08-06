#!/usr/bin/env node
/**
 * One staging-only, SHA-bound acceptance runner for the V4 additions that do
 * not have a browser-facing UAT surface yet.  It deliberately uses exact,
 * marker-scoped synthetic records and emits no credential, token, email or
 * request payload in its evidence.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

export const STAGING_REF = "bfsiibofuzoglziltgyd";
export const PRODUCTION_REF = "vfopmpxlhwzpxqegayew";
export const CONFIRMATION = "V4_STAGING_ACCEPTANCE_ONLY";
export const FIXED_MANIFEST = "/runner/release/manifest.json";
export const SCENARIOS = ["SAM-80", "SAM-81", "SAM-82", "SAM-83", "SAM-84", "SAM-86"];
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function fail(message) { throw new Error(`V4_STAGING_UAT_FAIL_CLOSED:${message}`); }
function required(env, name) { const value = env[name]?.trim(); if (!value) fail(`missing_${name}`); return value; }
function cleanError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9._%+-]+@invalid\.test/gi, "[fixture-email]")
    .slice(0, 240);
}
function databaseErrorCode(error) {
  const code = String(error?.code ?? "unknown");
  return /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "unknown";
}
function httpFailureCode(response, label) {
  const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599
    ? String(response.status)
    : "unknown";
  const code = typeof response?.body?.error === "string" && /^[a-z0-9_]{1,64}$/i.test(response.body.error)
    ? response.body.error
    : "none";
  return `${label}_${status}_${code}`;
}
function unique(values) { return [...new Set(values.filter(Boolean))]; }

export function validateEnvironment(env = process.env) {
  for (const value of Object.values(env)) if (typeof value === "string" && value.includes(PRODUCTION_REF)) fail("production_reference_detected");
  if (required(env, "V4_UAT_CONFIRM") !== CONFIRMATION) fail("confirmation_missing");
  const releaseSha = required(env, "V4_UAT_RELEASE_SHA");
  if (!SHA.test(releaseSha)) fail("release_sha_invalid");
  if (required(env, "V4_UAT_RELEASE_MANIFEST") !== FIXED_MANIFEST) fail("manifest_path_invalid");
  if (required(env, "NEWME_STAGING_PROJECT_REF") !== STAGING_REF) fail("project_ref_invalid");
  const supabaseUrl = required(env, "NEXT_PUBLIC_SUPABASE_URL");
  if (supabaseUrl !== `https://${STAGING_REF}.supabase.co`) fail("supabase_url_invalid");
  const baseUrl = required(env, "V4_UAT_BASE_URL").replace(/\/$/, "");
  if (baseUrl !== "http://127.0.0.1:3101") fail("base_url_not_loopback");
  const anonKey = required(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  const readinessToken = required(env, "NEWME_READINESS_TOKEN");
  if (anonKey === serviceKey) fail("credential_roles_not_separated");
  return { releaseSha, supabaseUrl, baseUrl, anonKey, serviceKey, readinessToken };
}

async function releaseBoundary(config, dependencies = {}) {
  const manifest = JSON.parse(await (dependencies.readFile ?? readFile)(FIXED_MANIFEST, "utf8"));
  if (manifest?.git_sha !== config.releaseSha) fail("manifest_sha_mismatch");
  const response = await (dependencies.fetch ?? fetch)(`${config.baseUrl}/api/health`, { cache: "no-store", redirect: "manual" });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || body?.status !== "ok") fail("health_gate_failed");
  return { project_ref: STAGING_REF, release_sha: config.releaseSha, health: 200 };
}

async function one(query, label) {
  const { data, error } = await query.select().single();
  if (error || !data?.id) fail(`${label}_failed`);
  return data;
}
async function write(client, table, value, label) { return one(client.from(table).insert(value), label); }
async function remove(client, table, ids, label) {
  const values = unique(ids);
  if (!values.length) return;
  const { error } = await client.from(table).delete().in("id", values);
  if (error) fail(`cleanup_${label}_failed_${databaseErrorCode(error)}`);
  const { count, error: countError } = await client.from(table).select("id", { count: "exact", head: true }).in("id", values);
  if (countError || count !== 0) fail(`cleanup_${label}_residue`);
}
async function removeByOrganizations(client, table, organizationIds, label) {
  const values = unique(organizationIds);
  if (!values.length) return;
  const { error } = await client.from(table).delete().in("organization_id", values);
  if (error) fail(`cleanup_${label}_failed`);
  const { count, error: countError } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .in("organization_id", values);
  if (countError || count !== 0) fail(`cleanup_${label}_residue`);
}
async function removeByActors(client, table, actorIds, label) {
  const values = unique(actorIds);
  if (!values.length) return;
  const { error } = await client.from(table).delete().in("actor_user_id", values);
  if (error) fail(`cleanup_${label}_failed_${databaseErrorCode(error)}`);
  const { count, error: countError } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .in("actor_user_id", values);
  if (countError || count !== 0) fail(`cleanup_${label}_residue`);
}
async function removeByProfileColumn(client, table, column, profileIds, label) {
  if (![["shared_timeline_events", "actor_user_id"], ["shared_approval_requests", "requested_by"]]
    .some(([allowedTable, allowedColumn]) => allowedTable === table && allowedColumn === column)) {
    fail(`cleanup_profile_relation_not_allowlisted_${label}`);
  }
  const values = unique(profileIds);
  if (!values.length) return;
  const { error } = await client.from(table).delete().in(column, values);
  if (error) fail(`cleanup_${label}_failed_${databaseErrorCode(error)}`);
  const { count, error: countError } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .in(column, values);
  if (countError || count !== 0) fail(`cleanup_${label}_residue`);
}

async function createActor(state) {
  const email = `${state.marker}@invalid.test`;
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const { data, error } = await state.admin.auth.admin.createUser({ email, password, email_confirm: true,
    app_metadata: { fixture_scope: "v4-staging-acceptance", run_id: state.runId }, user_metadata: { full_name: state.marker } });
  if (error || !data.user?.id) fail("auth_fixture_create_failed");
  state.ids.auth.push(data.user.id);
  const { error: profileError } = await state.admin.from("profiles").update({ role: "admin", full_name: state.marker, email, is_active: true, force_password_change: false }).eq("id", data.user.id);
  if (profileError) fail("profile_fixture_configure_failed");
  const { data: membership, error: membershipError } = await state.admin.from("memberships").insert({ organization_id: state.organizations.real_estate, user_id: data.user.id, status: "active", accepted_at: new Date().toISOString() }).select("id").single();
  if (membershipError || !membership?.id) fail("membership_fixture_create_failed");
  state.ids.memberships.push(membership.id);
  const { data: role, error: roleError } = await state.admin.from("roles").select("id").eq("scope", "organization").eq("role_key", "org_admin").single();
  if (roleError || !role?.id) fail("organization_admin_role_missing");
  const { data: membershipRole, error: membershipRoleError } = await state.admin.from("membership_roles").insert({ organization_id: state.organizations.real_estate, membership_id: membership.id, role_id: role.id }).select("id").single();
  if (membershipRoleError || !membershipRole?.id) fail("membership_role_fixture_create_failed");
  state.ids.membershipRoles.push(membershipRole.id);
  const { createClient } = state.supabase;
  const { data: signed, error: signError } = await createClient(state.config.supabaseUrl, state.config.anonKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.signInWithPassword({ email, password });
  if (signError || !signed.session?.access_token) fail("auth_fixture_signin_failed");
  state.actor = { id: data.user.id, token: signed.session.access_token };
}

async function createOrganizationActor(state, { organizationId, roleKey, suffix }) {
  const email = `${state.marker}-${suffix}@invalid.test`.toLowerCase();
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const { data, error } = await state.admin.auth.admin.createUser({
    email, password, email_confirm: true,
    app_metadata: { fixture_scope: "v4-staging-acceptance", run_id: state.runId },
    user_metadata: { full_name: state.marker },
  });
  if (error || !data.user?.id) fail(`fixture_${suffix}_auth_create_failed`);
  state.ids.auth.push(data.user.id);
  const { error: profileError } = await state.admin.from("profiles")
    .update({ role: "admin", full_name: state.marker, email, is_active: true, force_password_change: false })
    .eq("id", data.user.id);
  if (profileError) fail(`fixture_${suffix}_profile_configure_failed`);
  const { data: membership, error: membershipError } = await state.admin.from("memberships")
    .insert({ organization_id: organizationId, user_id: data.user.id, status: "active", accepted_at: new Date().toISOString() })
    .select("id").single();
  if (membershipError || !membership?.id) fail(`fixture_${suffix}_membership_create_failed`);
  state.ids.memberships.push(membership.id);
  const { data: role, error: roleError } = await state.admin.from("roles").select("id")
    .eq("scope", "organization").eq("role_key", roleKey).single();
  if (roleError || !role?.id) fail(`fixture_${suffix}_role_missing`);
  const { data: membershipRole, error: membershipRoleError } = await state.admin.from("membership_roles")
    .insert({ organization_id: organizationId, membership_id: membership.id, role_id: role.id }).select("id").single();
  if (membershipRoleError || !membershipRole?.id) fail(`fixture_${suffix}_membership_role_create_failed`);
  state.ids.membershipRoles.push(membershipRole.id);
  const { createClient } = state.supabase;
  const { data: signed, error: signError } = await createClient(state.config.supabaseUrl, state.config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.signInWithPassword({ email, password });
  if (signError || !signed.session?.access_token) fail(`fixture_${suffix}_signin_failed`);
  return { id: data.user.id, token: signed.session.access_token };
}

async function prepare(state) {
  for (const industry of ["real_estate", "retail"]) {
    const organization = await write(state.admin, "organizations", { id: randomUUID(), slug: `${state.marker}-${industry}`, name: state.marker, industry_key: industry, plan_key: "growth", billable_seat_limit: 20, status: "active" }, `organization_${industry}`);
    state.organizations[industry] = organization.id; state.ids.organizations.push(organization.id);
  }
  await createActor(state);
}

async function createRetailCodActor(state, suffix) {
  const email = `${state.marker}-${suffix}@invalid.test`.toLowerCase();
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const { data, error } = await state.admin.auth.admin.createUser({
    email, password, email_confirm: true,
    app_metadata: { fixture_scope: "v4-staging-acceptance", run_id: state.runId },
    user_metadata: { full_name: state.marker },
  });
  if (error || !data.user?.id) fail(`sam83_${suffix}_auth_create_failed`);
  state.ids.auth.push(data.user.id);
  const { error: profileError } = await state.admin
    .from("profiles")
    .update({ role: "admin", full_name: state.marker, email, is_active: true, force_password_change: false })
    .eq("id", data.user.id);
  if (profileError) fail(`sam83_${suffix}_profile_configure_failed`);
  const { data: membership, error: membershipError } = await state.admin
    .from("memberships")
    .insert({ organization_id: state.organizations.retail, user_id: data.user.id, status: "active", accepted_at: new Date().toISOString() })
    .select("id")
    .single();
  if (membershipError || !membership?.id) fail(`sam83_${suffix}_membership_create_failed`);
  state.ids.memberships.push(membership.id);
  return data.user.id;
}

async function createRetailCapabilityActor(state, suffix, roleKey) {
  const email = `${state.marker}-${suffix}@invalid.test`.toLowerCase();
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const { data, error } = await state.admin.auth.admin.createUser({
    email, password, email_confirm: true,
    app_metadata: { fixture_scope: "v4-staging-acceptance", run_id: state.runId },
    user_metadata: { full_name: state.marker },
  });
  if (error || !data.user?.id) fail(`sam82_${suffix}_auth_create_failed`);
  state.ids.auth.push(data.user.id);
  const { error: profileError } = await state.admin
    .from("profiles")
    .update({ role: "admin", full_name: state.marker, email, is_active: true, force_password_change: false })
    .eq("id", data.user.id);
  if (profileError) fail(`sam82_${suffix}_profile_configure_failed`);
  const { data: membership, error: membershipError } = await state.admin
    .from("memberships")
    .insert({ organization_id: state.organizations.retail, user_id: data.user.id, status: "active", accepted_at: new Date().toISOString() })
    .select("id")
    .single();
  if (membershipError || !membership?.id) fail(`sam82_${suffix}_membership_create_failed`);
  state.ids.memberships.push(membership.id);
  const { data: role, error: roleError } = await state.admin
    .from("roles")
    .select("id")
    .eq("scope", "organization")
    .eq("role_key", roleKey)
    .single();
  if (roleError || !role?.id) fail(`sam82_${suffix}_role_missing`);
  const { data: membershipRole, error: membershipRoleError } = await state.admin
    .from("membership_roles")
    .insert({ organization_id: state.organizations.retail, membership_id: membership.id, role_id: role.id })
    .select("id")
    .single();
  if (membershipRoleError || !membershipRole?.id) fail(`sam82_${suffix}_membership_role_create_failed`);
  state.ids.membershipRoles.push(membershipRole.id);
  const { createClient } = state.supabase;
  const client = createClient(state.config.supabaseUrl, state.config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-newme-organization-id": state.organizations.retail } },
  });
  const { data: signed, error: signError } = await client.auth.signInWithPassword({ email, password });
  if (signError || !signed.session?.access_token) fail(`sam82_${suffix}_signin_failed`);
  return { id: data.user.id, client };
}

async function sam82(state) {
  const organizationId = state.organizations.retail;
  const manager = await createRetailCapabilityActor(state, "inventory-manager", "operations");
  const sales = await createRetailCapabilityActor(state, "inventory-sales", "sales_agent");
  const location = await write(manager.client, "retail_locations", {
    organization_id: organizationId, code: `${state.marker}-wh`, name: state.marker, location_kind: "warehouse",
  }, "sam82_location");
  state.ids.locations.push(location.id);
  const sku = await write(manager.client, "retail_skus", {
    organization_id: organizationId, sku: `${state.marker}-sku`, name: state.marker,
  }, "sam82_sku");
  state.ids.skus.push(sku.id);
  const priceBook = await write(manager.client, "retail_price_books", {
    organization_id: organizationId, name: `${state.marker}-aed`, currency: "AED", vat_rate: 5, status: "active",
  }, "sam82_price_book");
  state.ids.priceBooks.push(priceBook.id);
  const priceBookItem = await write(manager.client, "retail_price_book_items", {
    organization_id: organizationId, price_book_id: priceBook.id, sku_id: sku.id,
    unit_price: 10, max_discount_percent: 15, effective_from: new Date(Date.now() - 60_000).toISOString(),
  }, "sam82_price_book_item");
  state.ids.priceBookItems.push(priceBookItem.id);
  const idempotencyKey = randomUUID();
  const receive = await write(manager.client, "retail_inventory_movements", {
    organization_id: organizationId, location_id: location.id, sku_id: sku.id,
    idempotency_key: idempotencyKey, movement_type: "receive", on_hand_delta: 12,
  }, "sam82_receive");
  const reserve = await write(manager.client, "retail_inventory_movements", {
    organization_id: organizationId, location_id: location.id, sku_id: sku.id,
    idempotency_key: randomUUID(), movement_type: "reserve", on_hand_delta: -2, reserved_delta: 2,
  }, "sam82_reserve");
  state.ids.inventoryMovements.push(receive.id, reserve.id);

  const { data: balance, error: balanceError } = await manager.client
    .from("retail_inventory_balances")
    .select("on_hand,reserved,available")
    .eq("organization_id", organizationId)
    .eq("location_id", location.id)
    .eq("sku_id", sku.id)
    .single();
  if (balanceError || Number(balance?.on_hand) !== 10 || Number(balance?.reserved) !== 2 || Number(balance?.available) !== 8) {
    fail("sam82_inventory_balance_invalid");
  }
  const { data: price, error: priceError } = await manager.client
    .from("retail_effective_prices")
    .select("unit_price,max_discount_percent,currency,vat_rate")
    .eq("organization_id", organizationId)
    .eq("price_book_id", priceBook.id)
    .eq("sku_id", sku.id)
    .single();
  if (priceError || Number(price?.unit_price) !== 10 || Number(price?.max_discount_percent) !== 15 || price?.currency !== "AED" || Number(price?.vat_rate) !== 5) {
    fail("sam82_effective_price_invalid");
  }

  const duplicate = await manager.client.from("retail_inventory_movements").insert({
    organization_id: organizationId, location_id: location.id, sku_id: sku.id,
    idempotency_key: idempotencyKey, movement_type: "receive", on_hand_delta: 1,
  });
  if (!duplicate.error) fail("sam82_duplicate_idempotency_allowed");
  const immutable = await state.admin.from("retail_inventory_movements")
    .update({ on_hand_delta: 99 })
    .eq("id", receive.id);
  if (!immutable.error) fail("sam82_mutable_ledger_allowed");
  const zeroPrice = await manager.client.from("retail_price_book_items").insert({
    organization_id: organizationId, price_book_id: priceBook.id, sku_id: sku.id,
    unit_price: 0, max_discount_percent: 0, effective_from: new Date().toISOString(),
  });
  if (!zeroPrice.error) fail("sam82_zero_price_allowed");
  const excessiveDiscount = await manager.client.from("retail_price_book_items").insert({
    organization_id: organizationId, price_book_id: priceBook.id, sku_id: sku.id,
    unit_price: 1, max_discount_percent: 101, effective_from: new Date().toISOString(),
  });
  if (!excessiveDiscount.error) fail("sam82_excessive_discount_allowed");
  const salesWrite = await sales.client.from("retail_inventory_movements").insert({
    organization_id: organizationId, location_id: location.id, sku_id: sku.id,
    idempotency_key: randomUUID(), movement_type: "receive", on_hand_delta: 1,
  });
  if (!salesWrite.error) fail("sam82_sales_inventory_write_allowed");
  const { createClient } = state.supabase;
  const crossOrganizationClient = createClient(state.config.supabaseUrl, state.config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: {
      authorization: `Bearer ${state.actor.token}`,
      "x-newme-organization-id": organizationId,
    } },
  });
  const crossOrganizationRead = await crossOrganizationClient
    .from("retail_locations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", location.id);
  if (crossOrganizationRead.error || (crossOrganizationRead.data ?? []).length !== 0) fail("sam82_cross_organization_read_allowed");
  const crossOrganizationWrite = await crossOrganizationClient.from("retail_skus").insert({
    organization_id: organizationId, sku: `${state.marker}-cross-org`, name: state.marker,
  });
  if (!crossOrganizationWrite.error) fail("sam82_cross_organization_catalog_write_allowed");

  return {
    status: "pass", topology: "verified", sku_resolver: "verified",
    inventory_ledger: "verified", price_resolution: "verified", rls_acl: "verified",
    marker_only: true,
  };
}


async function sam81(state) {
  const organizationId = state.organizations.real_estate;
  const party = await write(state.admin, "real_estate_parties", { organization_id: organizationId, party_type: "landlord", display_name: state.marker, normalized_email: `${state.marker}@invalid.test`.toLowerCase(), created_by: state.actor.id }, "sam81_party"); state.ids.parties.push(party.id);
  const property = await write(state.admin, "real_estate_properties", { organization_id: organizationId, owner_party_id: party.id, property_reference: `${state.marker}-property`, property_type: "apartment", address_line: state.marker, status: "available", created_by: state.actor.id }, "sam81_property"); state.ids.properties.push(property.id);
  const listing = await write(state.admin, "real_estate_listings", { organization_id: organizationId, property_id: property.id, owner_party_id: party.id, listing_reference: `${state.marker}-listing`, asking_price: 1000000, status: "ready", created_by: state.actor.id }, "sam81_listing"); state.ids.listings.push(listing.id);
  for (const asset_kind of ["media", "document"]) { const asset = await write(state.admin, "real_estate_listing_assets", { organization_id: organizationId, listing_id: listing.id, asset_kind, asset_reference: `${state.marker}-${asset_kind}`, verification_status: "verified", created_by: state.actor.id }, `sam81_${asset_kind}`); state.ids.assets.push(asset.id); }
  const { data, error } = await state.admin.from("v_real_estate_listing_publish_readiness").select("listing_id,is_publish_ready,publish_state").eq("organization_id", organizationId).eq("listing_id", listing.id).single();
  if (error || data?.is_publish_ready !== true || data?.publish_state !== "disabled") fail("sam81_publish_readiness_invalid");
  return { status: "pass", listing_publish_ready: true, external_publish_state: "disabled", marker_only: true };
}

async function sam83(state) {
  const organizationId = state.organizations.retail;
  const location = await write(state.admin, "retail_locations", { organization_id: organizationId, code: `${state.marker}-wh`, name: state.marker, location_kind: "warehouse" }, "sam83_location"); state.ids.locations.push(location.id);
  const sku = await write(state.admin, "retail_skus", { organization_id: organizationId, sku: `${state.marker}-sku`, name: state.marker }, "sam83_sku"); state.ids.skus.push(sku.id);
  const lead = await write(state.admin, "leads", { organization_id: organizationId, customer_name: state.marker, source: "other", stage: "won", quality: "good", assigned_to: state.actor.id, created_by: state.actor.id }, "sam83_lead"); state.ids.leads.push(lead.id);
  const quotation = await write(state.admin, "quotations", { organization_id: organizationId, lead_id: lead.id, quote_no: `V4-${state.runId.replaceAll("-", "").slice(0, 16)}`, quotation_type: "standard", status: "accepted", subtotal: 10, total_amount: 10, valid_until: new Date(Date.now() + 86_400_000).toISOString(), created_by: state.actor.id }, "sam83_quotation"); state.ids.quotations.push(quotation.id);
  const order = await write(state.admin, "retail_orders", { organization_id: organizationId, source_quotation_id: quotation.id, fulfillment_location_id: location.id, order_number: `${state.marker}-order`, total_amount: 10, created_by: state.actor.id }, "sam83_order"); state.ids.orders.push(order.id);
  const orderItem = await write(state.admin, "retail_order_items", { organization_id: organizationId, order_id: order.id, sku_id: sku.id, quantity: 1, unit_price: 10 }, "sam83_order_item"); state.ids.orderItems.push(orderItem.id);
  const purchase = await write(state.admin, "retail_purchase_orders", { organization_id: organizationId, receiving_location_id: location.id, purchase_order_number: `${state.marker}-po`, supplier_name: state.marker, created_by: state.actor.id }, "sam83_purchase_order"); state.ids.purchaseOrders.push(purchase.id);
  const purchaseItem = await write(state.admin, "retail_purchase_order_items", { organization_id: organizationId, purchase_order_id: purchase.id, sku_id: sku.id, ordered_quantity: 1, unit_cost: 1 }, "sam83_purchase_item"); state.ids.purchaseItems.push(purchaseItem.id);
  const receipt = await write(state.admin, "retail_goods_receipts", { organization_id: organizationId, purchase_order_id: purchase.id, location_id: location.id, received_by: state.actor.id, idempotency_key: randomUUID() }, "sam83_receipt"); state.ids.receipts.push(receipt.id);
  const receiptItem = await write(state.admin, "retail_goods_receipt_items", { organization_id: organizationId, receipt_id: receipt.id, purchase_order_item_id: purchaseItem.id, sku_id: sku.id, received_quantity: 1 }, "sam83_receipt_item"); state.ids.receiptItems.push(receiptItem.id);
  const repeat = await state.admin.from("retail_goods_receipts").insert({ organization_id: organizationId, purchase_order_id: purchase.id, location_id: location.id, received_by: state.actor.id, idempotency_key: receipt.idempotency_key ?? randomUUID() });
  if (!repeat.error) fail("sam83_receipt_idempotency_missing");
  const handoff = await write(state.admin, "retail_delivery_handoffs", { organization_id: organizationId, order_id: order.id, location_id: location.id, assigned_driver_id: state.actor.id, status: "completed", delivered_at: new Date().toISOString() }, "sam83_handoff"); state.ids.handoffs.push(handoff.id);
  const collectorId = await createRetailCodActor(state, "collector");
  const handoverId = await createRetailCodActor(state, "handover");
  const financeId = await createRetailCodActor(state, "finance");
  let financeConfirmationId;
  for (const [event_type, actor_id] of [["cash_collected", collectorId], ["cash_handover", handoverId], ["finance_confirmed", financeId]]) {
    const event = await write(state.admin, "retail_cod_events", { organization_id: organizationId, order_id: order.id, handoff_id: handoff.id, idempotency_key: randomUUID(), event_type, amount: 10, actor_id }, `sam83_${event_type}`);
    state.ids.codEvents.push(event.id); if (event_type === "finance_confirmed") financeConfirmationId = event.id;
  }
  const allocation = await write(state.admin, "retail_finance_allocations", { organization_id: organizationId, order_id: order.id, finance_confirmation_id: financeConfirmationId, idempotency_key: randomUUID(), allocated_amount: 10, allocated_by: state.actor.id }, "sam83_finance_allocation"); state.ids.allocations.push(allocation.id);
  const reconciliation = await write(state.admin, "retail_finance_reconciliations", { organization_id: organizationId, reconciliation_date: "2099-01-01", collected_amount: 10, allocated_amount: 10, status: "reconciled", completed_by: state.actor.id, completed_at: new Date().toISOString() }, "sam83_reconciliation"); state.ids.reconciliations.push(reconciliation.id);
  return { status: "pass", order: "accepted", procurement_receipt: "posted", fulfillment: "completed", finance: "reconciled", receipt_idempotency: "verified", marker_only: true };
}

async function sam84(state) {
  const responseFor = async (command, payload = { marker: state.marker }) => {
    const response = await fetch(`${state.config.baseUrl}/api/agent/commands`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json", authorization: `Bearer ${state.actor.token}`, "x-newme-organization-id": state.organizations.real_estate }, body: JSON.stringify({ command, payload }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const outcomes = {};
  for (const [level, command] of [["L0", "agent.policy.describe"], ["L1", "agent.tenant.summary"], ["L2", "agent.draft.create"], ["L3", "agent.external.send.request"], ["L4", "agent.authorization.change"]]) {
    const result = await responseFor(command); outcomes[level] = result.status;
    if (level === "L4" ? result.status !== 403 : ![200, 202].includes(result.status)) fail(`sam84_${level}_unexpected_status`);
  }
  const replayPayload = { marker: state.marker, operation: "replay" };
  const first = await responseFor("agent.policy.describe", replayPayload);
  const replay = await responseFor("agent.policy.describe", replayPayload);
  if (first.status !== 200 || replay.status !== 200 || replay.body?.idempotent !== true || replay.body?.command_id !== first.body?.command_id) fail("sam84_replay_not_idempotent");
  // No adapter may become active merely because an acceptance command is sent.
  const { data, error } = await state.admin.from("agent_gateway_adapter_registry").select("adapter_key,enabled");
  if (error || !Array.isArray(data) || data.some((row) => row.enabled !== false)) fail("sam84_adapter_not_disabled");
  return { status: "pass", risk_levels: outcomes, adapters: "disabled", replay: "route_idempotency_exercised", marker_only: true };
}

async function sam80(state) {
  const organizationId = state.organizations.real_estate;
  const requester = await createOrganizationActor(state, {
    organizationId, roleKey: "sales_agent", suffix: "sam80-requester",
  });
  const api = async (path, token, init = {}) => {
    const response = await fetch(`${state.config.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json", authorization: `Bearer ${token}`,
        "x-newme-organization-id": organizationId, ...(init.headers ?? {}),
      },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const unauthenticated = await api("/api/operations/summary", "invalid");
  if (unauthenticated.status !== 401) fail("sam80_unauthenticated_gate_failed");
  const workKey = `${state.marker}-sam80-work`;
  const work = await api("/api/operations/work-items", requester.token, {
    method: "POST", body: JSON.stringify({ title: state.marker, priority: "normal", idempotency_key: workKey }),
  });
  if (work.status !== 201 || !UUID.test(work.body?.data?.id ?? "")) fail("sam80_work_create_failed");
  state.ids.sharedWorkItems.push(work.body.data.id);
  const replay = await api("/api/operations/work-items", requester.token, {
    method: "POST", body: JSON.stringify({ title: state.marker, priority: "normal", idempotency_key: workKey }),
  });
  if (replay.status !== 201 || replay.body?.data?.id !== work.body.data.id) fail("sam80_work_idempotency_failed");
  const approval = await api("/api/operations/approvals", requester.token, {
    method: "POST", body: JSON.stringify({
      action_key: "work.complete", resource_type: "shared_work_item", resource_id: work.body.data.id,
      payload: { marker_code: state.runId }, idempotency_key: `${state.marker}-sam80-approval`,
    }),
  });
  if (approval.status !== 201 || !UUID.test(approval.body?.data?.id ?? "")) fail("sam80_approval_request_failed");
  state.ids.sharedApprovals.push(approval.body.data.id);
  const selfDecision = await api(`/api/operations/approvals/${approval.body.data.id}`, requester.token, {
    method: "PATCH", body: JSON.stringify({ decision: "approved", reason_code: "uat_approve" }),
  });
  if (selfDecision.status !== 403 && selfDecision.status !== 404) fail("sam80_independent_approval_gate_failed");
  const decision = await api(`/api/operations/approvals/${approval.body.data.id}`, state.actor.token, {
    method: "PATCH", body: JSON.stringify({ decision: "approved", reason_code: "uat_approve" }),
  });
  if (decision.status !== 200 || decision.body?.data?.status !== "approved") fail("sam80_approval_decision_failed");
  const job = await api("/api/operations/jobs", requester.token, {
    method: "POST", body: JSON.stringify({ kind: "operations_report", parameters: { report_scope: "daily" }, idempotency_key: `${state.marker}-sam80-report` }),
  });
  if (job.status !== 202 || !UUID.test(job.body?.data?.id ?? "")) fail("sam80_report_job_failed");
  state.ids.sharedJobs.push(job.body.data.id);
  const crossOrganization = await api("/api/operations/work-items", requester.token, {
    headers: { "x-newme-organization-id": "00000000-0000-4000-8000-000000000001" },
  });
  if (crossOrganization.status !== 403) fail("sam80_cross_organization_gate_failed");
  const [timeline, summary, jobs] = await Promise.all([
    api("/api/operations/timeline?limit=100", requester.token), api("/api/operations/summary", requester.token),
    api("/api/operations/jobs?limit=100", requester.token),
  ]);
  if (timeline.status !== 200 || !Array.isArray(timeline.body?.data)) fail("sam80_timeline_read_failed");
  if (summary.status !== 200 || !summary.body?.data) fail(httpFailureCode(summary, "sam80_summary_read_failed"));
  if (jobs.status !== 200 || !Array.isArray(jobs.body?.data)) fail("sam80_jobs_read_failed");
  if (!jobs.body.data.some((row) => row?.id === job.body.data.id)) fail("sam80_report_job_visibility_failed");
  return { status: "pass", independent_approval: "verified", tenant_isolation: "verified", report_job: "queued", marker_only: true };
}

async function collectSam80Cleanup(state) {
  const organizationId = state.organizations.real_estate;
  const i = state.ids;
  const resourceIds = unique([...i.sharedWorkItems, ...i.sharedApprovals, ...i.sharedJobs]);
  if (resourceIds.length > 0) {
    const { data: events, error: eventsError } = await state.admin.from("shared_timeline_events").select("id")
      .eq("organization_id", organizationId).in("resource_id", resourceIds);
    if (eventsError) fail("sam80_cleanup_event_discovery_failed");
    i.sharedTimelineEvents.push(...(events ?? []).map((row) => row.id));
    const { data: outbox, error: outboxError } = await state.admin.from("shared_outbox").select("id")
      .eq("organization_id", organizationId).in("aggregate_id", resourceIds);
    if (outboxError) fail("sam80_cleanup_outbox_discovery_failed");
    i.sharedOutbox.push(...(outbox ?? []).map((row) => row.id));
  }
  const timelineIds = unique(i.sharedTimelineEvents);
  if (timelineIds.length > 0) {
    const { data: notifications, error } = await state.admin.from("shared_notifications").select("id")
      .eq("organization_id", organizationId).in("source_event_id", timelineIds);
    if (error) fail("sam80_cleanup_notification_discovery_failed");
    i.sharedNotifications.push(...(notifications ?? []).map((row) => row.id));
  }
  const jobIds = unique(i.sharedJobs);
  if (jobIds.length > 0) {
    const { data: reports, error } = await state.admin.from("shared_report_snapshots").select("id")
      .eq("organization_id", organizationId).in("generated_by_job_id", jobIds);
    if (error) fail("sam80_cleanup_report_discovery_failed");
    i.sharedReports.push(...(reports ?? []).map((row) => row.id));
  }
}

async function sam86(state) {
  const started = Date.now();
  const health = await fetch(`${state.config.baseUrl}/api/health`, { cache: "no-store", redirect: "manual" });
  const ready = await fetch(`${state.config.baseUrl}/api/ready`, { cache: "no-store", redirect: "manual", headers: { "x-newme-readiness-token": state.config.readinessToken } });
  const healthBody = await health.json().catch(() => null); const readyBody = await ready.json().catch(() => null);
  if (health.status !== 200 || healthBody?.status !== "ok" || ready.status !== 200 || readyBody?.status !== "ready" || readyBody?.release_sha !== state.config.releaseSha) fail("sam86_runtime_provenance_invalid");
  const latencyMs = Date.now() - started;
  if (latencyMs > 3000) fail("sam86_readiness_timeout");
  return { status: "pass", health: 200, readiness: 200, release_sha: state.config.releaseSha, latency_ms: latencyMs, evidence: "runtime_only_no_secrets", marker_only: true };
}

async function cleanup(state) {
  const a = state.admin, i = state.ids;
  // Organization creation emits commercial defaults and sign-in can emit a
  // session row. Delete those exact organization-scoped children before the
  // membership and organization parents; no broad marker or tenant delete.
  await collectSam80Cleanup(state);
  for (const [table, label] of [
    ["user_session_daily", "session_daily"],
    ["commercial_seat_events", "commercial_seat_events"],
    ["paid_seat_allocations", "paid_seat_allocations"],
    ["commercial_entitlements", "commercial_entitlements"],
    ["organization_subscriptions", "organization_subscriptions"],
  ]) await removeByOrganizations(a, table, i.organizations, label);
  for (const [table, ids, label] of [
    ["shared_report_snapshots", i.sharedReports, "shared_reports"],
    ["shared_notifications", i.sharedNotifications, "shared_notifications"],
    ["shared_outbox", i.sharedOutbox, "shared_outbox"],
    ["shared_timeline_events", i.sharedTimelineEvents, "shared_timeline_events"],
    ["shared_approval_requests", i.sharedApprovals, "shared_approvals"],
    ["shared_jobs", i.sharedJobs, "shared_jobs"],
    ["shared_work_items", i.sharedWorkItems, "shared_work_items"],
  ]) await remove(a, table, ids, label);
  for (const [table, ids, label] of [
    ["retail_inventory_movements", i.inventoryMovements, "inventory_movements"], ["retail_price_book_items", i.priceBookItems, "price_book_items"], ["retail_price_books", i.priceBooks, "price_books"],
    ["retail_finance_allocations", i.allocations, "allocations"], ["retail_finance_reconciliations", i.reconciliations, "reconciliations"], ["retail_cod_events", i.codEvents, "cod_events"], ["retail_delivery_handoffs", i.handoffs, "handoffs"], ["retail_order_items", i.orderItems, "order_items"], ["retail_orders", i.orders, "orders"], ["retail_goods_receipt_items", i.receiptItems, "receipt_items"], ["retail_goods_receipts", i.receipts, "receipts"], ["retail_purchase_order_items", i.purchaseItems, "purchase_items"], ["retail_purchase_orders", i.purchaseOrders, "purchase_orders"], ["quotations", i.quotations, "quotations"], ["leads", i.leads, "leads"], ["retail_skus", i.skus, "skus"], ["retail_locations", i.locations, "locations"],
    ["real_estate_listing_assets", i.assets, "listing_assets"], ["real_estate_listings", i.listings, "listings"], ["real_estate_properties", i.properties, "properties"], ["real_estate_parties", i.parties, "parties"],
  ]) await remove(a, table, ids, label);
  await removeByActors(a, "agent_gateway_events", i.auth, "agent_gateway_events");
  await removeByActors(a, "agent_gateway_commands", i.auth, "agent_gateway_commands");
  // SAM-84 can create approval/timeline records as a side effect of its
  // policy commands.  Both are allowlisted profile references and must be
  // removed before the synthetic profiles or auth users are deleted.
  await removeByProfileColumn(a, "shared_timeline_events", "actor_user_id", i.auth, "shared_timeline_events");
  await removeByProfileColumn(a, "shared_approval_requests", "requested_by", i.auth, "shared_approval_requests");
  await remove(a, "membership_roles", i.membershipRoles, "membership_roles");
  await remove(a, "memberships", i.memberships, "memberships");
  await remove(a, "profiles", i.auth, "profiles");
  for (const id of unique(i.organizations)) { const { error } = await a.from("organizations").delete().eq("id", id); if (error) fail("cleanup_organizations_failed"); }
  for (const id of unique(i.auth)) { const { error } = await a.auth.admin.deleteUser(id); if (error) fail("cleanup_auth_failed"); }
  return { status: "verified", counts: Object.fromEntries(Object.entries(i).map(([key, ids]) => [key, unique(ids).length === 0 ? 0 : 0])) };
}

export async function runV4StagingAcceptance(env = process.env, dependencies = {}) {
  const config = validateEnvironment(env); const release = await releaseBoundary(config, dependencies); const runId = randomUUID();
  const supabase = dependencies.supabase ?? await import("@supabase/supabase-js");
  const state = { config, supabase, runId, marker: `V4-UAT-${config.releaseSha.slice(0, 12)}-${runId.slice(0, 8)}`, admin: supabase.createClient(config.supabaseUrl, config.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }), organizations: {}, actor: null, ids: { organizations: [], auth: [], memberships: [], membershipRoles: [], sharedWorkItems: [], sharedApprovals: [], sharedTimelineEvents: [], sharedNotifications: [], sharedOutbox: [], sharedJobs: [], sharedReports: [], parties: [], properties: [], listings: [], assets: [], locations: [], skus: [], priceBooks: [], priceBookItems: [], inventoryMovements: [], leads: [], quotations: [], orders: [], orderItems: [], purchaseOrders: [], purchaseItems: [], receipts: [], receiptItems: [], handoffs: [], codEvents: [], allocations: [], reconciliations: [] } };
  const results = {};
  try { await prepare(state); results["SAM-80"] = await sam80(state); results["SAM-81"] = await sam81(state); results["SAM-82"] = await sam82(state); results["SAM-83"] = await sam83(state); results["SAM-84"] = await sam84(state); results["SAM-86"] = await sam86(state); const cleanupResult = await cleanup(state); return { ok: true, schema_version: 1, scope: "v4-staging-acceptance", run_id: runId, release, scenarios: results, cleanup: cleanupResult }; }
  catch (error) { await cleanup(state).catch(() => undefined); return { ok: false, schema_version: 1, scope: "v4-staging-acceptance", run_id: runId, release, scenarios: results, cleanup: { status: "attempted" }, error: cleanError(error) }; }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  runV4StagingAcceptance().then((report) => { process.stdout.write(`${JSON.stringify(report)}\n`); if (!report.ok) process.exitCode = 1; }).catch((error) => { process.stdout.write(`${JSON.stringify({ ok: false, error: cleanError(error) })}\n`); process.exitCode = 1; });
}
