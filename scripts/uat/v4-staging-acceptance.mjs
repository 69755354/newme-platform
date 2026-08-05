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
export const SCENARIOS = ["SAM-81", "SAM-83", "SAM-84", "SAM-86"];
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
  if (error) fail(`cleanup_${label}_failed`);
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
  const { data: membershipRole, error: membershipRoleError } = await state.admin.from("membership_roles").insert({ membership_id: membership.id, role_id: role.id }).select("id").single();
  if (membershipRoleError || !membershipRole?.id) fail("membership_role_fixture_create_failed");
  state.ids.membershipRoles.push(membershipRole.id);
  const { createClient } = state.supabase;
  const { data: signed, error: signError } = await createClient(state.config.supabaseUrl, state.config.anonKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.signInWithPassword({ email, password });
  if (signError || !signed.session?.access_token) fail("auth_fixture_signin_failed");
  state.actor = { id: data.user.id, token: signed.session.access_token };
}

async function prepare(state) {
  for (const industry of ["real_estate", "retail"]) {
    const organization = await write(state.admin, "organizations", { id: randomUUID(), slug: `${state.marker}-${industry}`, name: state.marker, industry_key: industry, plan_key: "growth", billable_seat_limit: 20, status: "active" }, `organization_${industry}`);
    state.organizations[industry] = organization.id; state.ids.organizations.push(organization.id);
  }
  await createActor(state);
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
  const lead = await write(state.admin, "leads", { organization_id: organizationId, customer_name: state.marker, source: "other", stage: "won", quality: "high", assigned_to: state.actor.id, created_by: state.actor.id }, "sam83_lead"); state.ids.leads.push(lead.id);
  const quotation = await write(state.admin, "quotations", { organization_id: organizationId, lead_id: lead.id, quote_no: `V4-${state.runId.replaceAll("-", "").slice(0, 16)}`, quotation_type: "retail", status: "accepted", subtotal: 10, total_amount: 10, valid_until: new Date(Date.now() + 86_400_000).toISOString(), created_by: state.actor.id }, "sam83_quotation"); state.ids.quotations.push(quotation.id);
  const order = await write(state.admin, "retail_orders", { organization_id: organizationId, source_quotation_id: quotation.id, fulfillment_location_id: location.id, order_number: `${state.marker}-order`, total_amount: 10, created_by: state.actor.id }, "sam83_order"); state.ids.orders.push(order.id);
  const orderItem = await write(state.admin, "retail_order_items", { organization_id: organizationId, order_id: order.id, sku_id: sku.id, quantity: 1, unit_price: 10 }, "sam83_order_item"); state.ids.orderItems.push(orderItem.id);
  const purchase = await write(state.admin, "retail_purchase_orders", { organization_id: organizationId, receiving_location_id: location.id, purchase_order_number: `${state.marker}-po`, supplier_name: state.marker, created_by: state.actor.id }, "sam83_purchase_order"); state.ids.purchaseOrders.push(purchase.id);
  const purchaseItem = await write(state.admin, "retail_purchase_order_items", { organization_id: organizationId, purchase_order_id: purchase.id, sku_id: sku.id, ordered_quantity: 1, unit_cost: 1 }, "sam83_purchase_item"); state.ids.purchaseItems.push(purchaseItem.id);
  const receipt = await write(state.admin, "retail_goods_receipts", { organization_id: organizationId, purchase_order_id: purchase.id, location_id: location.id, received_by: state.actor.id, idempotency_key: randomUUID() }, "sam83_receipt"); state.ids.receipts.push(receipt.id);
  const receiptItem = await write(state.admin, "retail_goods_receipt_items", { organization_id: organizationId, receipt_id: receipt.id, purchase_order_item_id: purchaseItem.id, sku_id: sku.id, received_quantity: 1 }, "sam83_receipt_item"); state.ids.receiptItems.push(receiptItem.id);
  const repeat = await state.admin.from("retail_goods_receipts").insert({ organization_id: organizationId, purchase_order_id: purchase.id, location_id: location.id, received_by: state.actor.id, idempotency_key: receipt.idempotency_key ?? randomUUID() });
  if (!repeat.error) fail("sam83_receipt_idempotency_missing");
  const handoff = await write(state.admin, "retail_delivery_handoffs", { organization_id: organizationId, order_id: order.id, location_id: location.id, assigned_driver_id: state.actor.id, status: "completed", delivered_at: new Date().toISOString() }, "sam83_handoff"); state.ids.handoffs.push(handoff.id);
  let financeConfirmationId;
  for (const event_type of ["cash_collected", "cash_handover", "finance_confirmed"]) {
    const event = await write(state.admin, "retail_cod_events", { organization_id: organizationId, order_id: order.id, handoff_id: handoff.id, idempotency_key: randomUUID(), event_type, amount: 10, actor_id: state.actor.id }, `sam83_${event_type}`);
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

async function sam86(state) {
  const started = Date.now();
  const health = await fetch(`${state.config.baseUrl}/api/health`, { cache: "no-store", redirect: "manual" });
  const ready = await fetch(`${state.config.baseUrl}/api/ready`, { cache: "no-store", redirect: "manual", headers: { "x-newme-readiness-token": state.config.readinessToken } });
  const healthBody = await health.json().catch(() => null); const readyBody = await ready.json().catch(() => null);
  if (health.status !== 200 || healthBody?.status !== "ok" || ready.status !== 200 || readyBody?.status !== "ready" || readyBody?.release_sha !== state.config.releaseSha) fail("sam86_runtime_provenance_invalid");
  const latencyMs = Date.now() - started;
  if (latencyMs > 3000) fail("sam86_readiness_timeout");
  return { status: "pass", health: 200, readiness: 200, release_sha: state.config.releaseSha, latency_ms: latencyMs, evidence: "runtime_only_no_secrets" };
}

async function cleanup(state) {
  const a = state.admin, i = state.ids;
  // Organization creation emits commercial defaults and sign-in can emit a
  // session row. Delete those exact organization-scoped children before the
  // membership and organization parents; no broad marker or tenant delete.
  for (const [table, label] of [
    ["user_session_daily", "session_daily"],
    ["commercial_seat_events", "commercial_seat_events"],
    ["paid_seat_allocations", "paid_seat_allocations"],
    ["commercial_entitlements", "commercial_entitlements"],
    ["organization_subscriptions", "organization_subscriptions"],
  ]) await removeByOrganizations(a, table, i.organizations, label);
  for (const [table, ids, label] of [
    ["retail_finance_allocations", i.allocations, "allocations"], ["retail_finance_reconciliations", i.reconciliations, "reconciliations"], ["retail_cod_events", i.codEvents, "cod_events"], ["retail_delivery_handoffs", i.handoffs, "handoffs"], ["retail_order_items", i.orderItems, "order_items"], ["retail_orders", i.orders, "orders"], ["retail_goods_receipt_items", i.receiptItems, "receipt_items"], ["retail_goods_receipts", i.receipts, "receipts"], ["retail_purchase_order_items", i.purchaseItems, "purchase_items"], ["retail_purchase_orders", i.purchaseOrders, "purchase_orders"], ["quotations", i.quotations, "quotations"], ["leads", i.leads, "leads"], ["retail_skus", i.skus, "skus"], ["retail_locations", i.locations, "locations"],
    ["real_estate_listing_assets", i.assets, "listing_assets"], ["real_estate_listings", i.listings, "listings"], ["real_estate_properties", i.properties, "properties"], ["real_estate_parties", i.parties, "parties"],
  ]) await remove(a, table, ids, label);
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
  const state = { config, supabase, runId, marker: `V4-UAT-${config.releaseSha.slice(0, 12)}-${runId.slice(0, 8)}`, admin: supabase.createClient(config.supabaseUrl, config.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }), organizations: {}, actor: null, ids: { organizations: [], auth: [], memberships: [], membershipRoles: [], parties: [], properties: [], listings: [], assets: [], locations: [], skus: [], leads: [], quotations: [], orders: [], orderItems: [], purchaseOrders: [], purchaseItems: [], receipts: [], receiptItems: [], handoffs: [], codEvents: [], allocations: [], reconciliations: [] } };
  const results = {};
  try { await prepare(state); results["SAM-81"] = await sam81(state); results["SAM-83"] = await sam83(state); results["SAM-84"] = await sam84(state); results["SAM-86"] = await sam86(state); const cleanupResult = await cleanup(state); return { ok: true, schema_version: 1, scope: "v4-staging-acceptance", run_id: runId, release, scenarios: results, cleanup: cleanupResult }; }
  catch (error) { await cleanup(state).catch(() => undefined); return { ok: false, schema_version: 1, scope: "v4-staging-acceptance", run_id: runId, release, scenarios: results, cleanup: { status: "attempted" }, error: cleanError(error) }; }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  runV4StagingAcceptance().then((report) => { process.stdout.write(`${JSON.stringify(report)}\n`); if (!report.ok) process.exitCode = 1; }).catch((error) => { process.stdout.write(`${JSON.stringify({ ok: false, error: cleanError(error) })}\n`); process.exitCode = 1; });
}
