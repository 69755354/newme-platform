#!/usr/bin/env node
/**
 * Final staging-only Product/SaaS UAT for SAM-11, SAM-13, SAM-25, SAM-35,
 * SAM-49, SAM-61, and the commercial customer-exit lifecycle.
 *
 * The versioned staging controller invokes this runner with the approved
 * release SHA, fixed local release manifest, and staging-only Supabase
 * credentials. No secret or credential is included in the JSON report.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

export const STAGING_PROJECT_REF = "bfsiibofuzoglziltgyd";
export const PRODUCTION_PROJECT_REF = "vfopmpxlhwzpxqegayew";
export const FIXED_MANIFEST_PATH = "/runner/release/manifest.json";
export const CONFIRMATION = "PRODUCT_SAAS_STAGING_ONLY";
export const FIXTURE_SCOPE = "product-saas-final";
export const REQUIRED_ROLES = ["boss", "admin", "operator", "sales", "finance", "designer"];
export const NON_MANAGEMENT_ROLES = ["operator", "sales", "finance", "designer"];
const ORGANIZATION_ROLE_BY_PROFILE = {
  boss: "org_owner",
  admin: "org_admin",
  operator: "operations",
  sales: "sales_agent",
  finance: "finance",
  designer: "specialist",
};
export const LINEAR_IDS = ["SAM-11", "SAM-13", "SAM-25", "SAM-35", "SAM-49", "SAM-61"];
export const CUSTOMER_EXIT_RESULT_ID = "CUSTOMER-EXIT";
export const REQUIRED_RESULT_IDS = [...LINEAR_IDS, CUSTOMER_EXIT_RESULT_ID];
export const SAM13_CONTRACT_VERSION = 1;
export const SAM13_DANGEROUS_PATHS = [
  "/revert_passwords.py",
  "/scripts/fix-lead-customer-name.ts",
  "/scripts/seed-products.ts",
];

const ALLOWED_BASE_URLS = new Set([
  "https://staging.newme.ae",
  "http://127.0.0.1:3101",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function fail(message) {
  throw new Error(`PRODUCT_SAAS_UAT_FAIL_CLOSED: ${message}`);
}

function required(env, name) {
  const value = env[name];
  if (!value) fail(`missing required environment variable ${name}`);
  return value;
}

function normalizedBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("PRODUCT_UAT_BASE_URL is not a valid URL");
  }
  const normalized = url.toString().replace(/\/+$/, "");
  if (!ALLOWED_BASE_URLS.has(normalized)) {
    fail("PRODUCT_UAT_BASE_URL is not an approved staging endpoint");
  }
  if (url.username || url.password || url.search || url.hash) {
    fail("PRODUCT_UAT_BASE_URL must not contain credentials, query, or fragment");
  }
  return normalized;
}

export function validateEnvironment(env = process.env) {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.includes(PRODUCTION_PROJECT_REF)) {
      fail(`${name} contains the production project reference`);
    }
  }

  if (required(env, "PRODUCT_UAT_CONFIRM") !== CONFIRMATION) {
    fail("PRODUCT_UAT_CONFIRM does not authorize this staging-only run");
  }
  if (required(env, "NEWME_STAGING_PROJECT_REF") !== STAGING_PROJECT_REF) {
    fail("NEWME_STAGING_PROJECT_REF does not match the approved staging project");
  }

  const supabaseUrl = new URL(required(env, "NEXT_PUBLIC_SUPABASE_URL"));
  if (
    supabaseUrl.protocol !== "https:"
    || supabaseUrl.hostname !== `${STAGING_PROJECT_REF}.supabase.co`
    || supabaseUrl.username
    || supabaseUrl.password
    || supabaseUrl.search
    || supabaseUrl.hash
  ) {
    fail("NEXT_PUBLIC_SUPABASE_URL does not resolve exactly to approved staging");
  }

  const releaseSha = required(env, "PRODUCT_UAT_RELEASE_SHA");
  if (!SHA_PATTERN.test(releaseSha)) {
    fail("PRODUCT_UAT_RELEASE_SHA must be a lowercase 40-character SHA");
  }
  if (required(env, "PRODUCT_UAT_RELEASE_MANIFEST") !== FIXED_MANIFEST_PATH) {
    fail(`PRODUCT_UAT_RELEASE_MANIFEST must be ${FIXED_MANIFEST_PATH}`);
  }

  const anonKey = required(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (anonKey === serviceKey) fail("anon and service-role credentials must differ");

  return {
    baseUrl: normalizedBaseUrl(required(env, "PRODUCT_UAT_BASE_URL")),
    releaseSha,
    manifestPath: FIXED_MANIFEST_PATH,
    supabaseUrl: supabaseUrl.toString().replace(/\/+$/, ""),
    anonKey,
    serviceKey,
  };
}

export async function verifyReleaseBoundary(config, dependencies = {}) {
  const readManifest = dependencies.readManifest ?? readFile;
  const request = dependencies.fetch ?? fetch;
  let manifest;
  try {
    manifest = JSON.parse(await readManifest(config.manifestPath, "utf8"));
  } catch {
    fail("fixed local release manifest is missing or invalid JSON");
  }
  if (manifest?.git_sha !== config.releaseSha) {
    fail("release manifest git_sha does not equal the approved release SHA");
  }

  const health = await request(`${config.baseUrl}/api/health`, {
    method: "GET",
    redirect: "manual",
    cache: "no-store",
  });
  if (health.status !== 200) {
    fail(`health endpoint returned HTTP ${health.status}; no fixture write is permitted`);
  }
  let body;
  try {
    body = await health.json();
  } catch {
    fail("health endpoint body is not JSON");
  }
  if (body?.status !== "ok") {
    fail("health endpoint body status is not ok");
  }
  return { project: STAGING_PROJECT_REF, release_sha: config.releaseSha, health: 200 };
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message
    .replace(/[A-Za-z0-9._%+-]+@invalid\.test/gi, "[fixture-email]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 300).replace(/[\r\n]+/g, " ");
  }
}

function expectStatus(label, response, expected) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert.ok(
    allowed.includes(response.status),
    `${label}: expected HTTP ${allowed.join("/")}, received ${response.status}`,
  );
}

function assertUuid(value, label) {
  assert.match(value ?? "", UUID_PATTERN, `${label} must be a UUID`);
}

function exactIdentityMarker(user, runId) {
  const metadata = user?.app_metadata ?? {};
  return metadata.fixture_scope === FIXTURE_SCOPE
    && metadata.fixture_kind === "final-product-uat"
    && metadata.run_id === runId
    && REQUIRED_ROLES.includes(metadata.role);
}

function makeClients(config, organizationId) {
  const admin = createClient(config.supabaseUrl, config.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-newme-organization-id": organizationId } },
  });
  const userClient = (token) => createClient(config.supabaseUrl, config.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-newme-organization-id": organizationId,
      },
    },
  });
  return { admin, userClient };
}

async function listAllAuthUsers(admin) {
  const users = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail("Admin API cannot enumerate marker-scoped auth users");
    users.push(...(data.users ?? []));
    if ((data.users ?? []).length < 200) return users;
  }
  fail("auth user enumeration exceeded the safe pagination limit");
}

async function createActor(state, role, actorKey = role) {
  const email = `${state.marker}-${actorKey}@invalid.test`;
  const password = `${randomBytes(32).toString("base64url")}Aa1!`;
  const { data, error } = await state.admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: {
      fixture_scope: FIXTURE_SCOPE,
      fixture_kind: "final-product-uat",
      run_id: state.runId,
      role,
      actor_key: actorKey,
    },
    user_metadata: { full_name: `[PRODUCT-UAT ${state.runId}] ${actorKey}` },
  });
  if (error || !data.user || !exactIdentityMarker(data.user, state.runId)) {
    fail(`could not create exact marked ${role} identity`);
  }
  state.userIds.add(data.user.id);

  const { error: profileError } = await state.admin.from("profiles").update({
    role,
    full_name: `[PRODUCT-UAT ${state.runId}] ${actorKey}`,
    email,
    is_active: true,
    force_password_change: false,
  }).eq("id", data.user.id);
  if (profileError) fail(`could not configure ${role} profile`);

  const { data: membership, error: membershipError } = await state.admin
    .from("memberships")
    .insert({
      organization_id: state.organizationId,
      user_id: data.user.id,
      status: "active",
      accepted_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (membershipError || !membership?.id) {
    fail(`could not create ${role} organization membership`);
  }

  const { data: organizationRole, error: roleError } = await state.admin
    .from("roles")
    .select("id")
    .eq("scope", "organization")
    .eq("role_key", ORGANIZATION_ROLE_BY_PROFILE[role])
    .single();
  if (roleError || !organizationRole?.id) {
    fail(`could not resolve ${role} organization role`);
  }
  const { error: membershipRoleError } = await state.admin
    .from("membership_roles")
    .insert({ membership_id: membership.id, role_id: organizationRole.id });
  if (membershipRoleError) fail(`could not map ${role} organization role`);

  const client = createClient(state.config.supabaseUrl, state.config.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-newme-organization-id": state.organizationId } },
  });
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signedIn.session || signedIn.user?.id !== data.user.id) {
    fail(`could not authenticate exact marked ${role} identity`);
  }
  state.actors.set(actorKey, {
    id: data.user.id,
    email,
    password,
    token: signedIn.session.access_token,
    client: state.userClient(signedIn.session.access_token),
  });
}

function initializeState(config, runId) {
  const organizationId = randomUUID();
  const { admin, userClient } = makeClients(config, organizationId);
  return {
    config,
    runId,
    marker: `product-saas-${runId}`,
    markerText: `[PRODUCT-UAT ${runId}]`,
    organizationId,
    admin,
    userClient,
    actors: new Map(),
    userIds: new Set(),
    leadIds: new Set(),
    quotationIds: new Set(),
    contractIds: new Set(),
    paymentIds: new Set(),
    projectIds: new Set(),
    installmentPlanIds: new Set(),
    contractApprovalIds: new Set(),
    paymentAllocationIds: new Set(),
    importBatchIds: new Set(),
    archiveBatchIds: new Set(),
    platformStaffIds: new Set(),
    supportSessionIds: new Set(),
    exitRequestIds: new Set(),
    sam13FixtureEmails: new Set(),
  };
}

async function prepareFixtures(state) {
  const { admin, organizationId, runId } = state;
  const { error: organizationError } = await admin.from("organizations").insert({
    id: organizationId,
    slug: `product-saas-${runId}`,
    name: `${state.markerText} organization`,
    industry_key: "real_estate",
    plan_key: "growth",
    billable_seat_limit: 10,
    status: "active",
  });
  if (organizationError) fail("could not create exact marked staging organization");

  for (const role of REQUIRED_ROLES) await createActor(state, role);
}

async function appRequest(state, role, path, { method = "GET", body } = {}) {
  const actor = state.actors.get(role);
  if (!actor) fail(`missing ${role} fixture identity`);
  const response = await fetch(`${state.config.baseUrl}${path}`, {
    method,
    redirect: "manual",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${actor.token}`,
      "x-newme-organization-id": state.organizationId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    payload: await responsePayload(response),
  };
}

async function anonymousAppRequest(state, path, { method = "GET", body } = {}) {
  const response = await fetch(`${state.config.baseUrl}${path}`, {
    method,
    redirect: "manual",
    cache: "no-store",
    headers: {
      "x-newme-organization-id": state.organizationId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: await responsePayload(response) };
}

async function createLead(state, suffix, overrides = {}) {
  const sales = state.actors.get("sales");
  const { data, error } = await state.admin.from("leads").insert({
    organization_id: state.organizationId,
    customer_name: `${state.markerText} ${suffix}`,
    source: "other",
    stage: "new",
    quality: "pending",
    assigned_to: sales.id,
    created_by: sales.id,
    ...overrides,
  }).select("id, stage, assigned_to, customer_name").single();
  if (error || !data?.id) fail(`could not create marked ${suffix} lead`);
  state.leadIds.add(data.id);
  return data;
}

async function runSam11(state) {
  const rows = [
    {
      "Customer Name": `${state.markerText} import UAE`,
      Phone: `+97150${state.runId.replaceAll("-", "").slice(0, 7)}`,
      Source: "Instagram",
      "Client Quality": "0.8",
      Country: "UAE",
      Notes: `${state.markerText} country=UAE`,
    },
    {
      "Customer Name": `${state.markerText} import KSA`,
      Phone: `+96650${state.runId.replaceAll("-", "").slice(0, 7)}`,
      Source: "Facebook",
      "Client Quality": "0.5",
      Country: "KSA",
      Notes: `${state.markerText} country=KSA`,
    },
    {
      "Customer Name": `${state.markerText} import Qatar`,
      Phone: `+97450${state.runId.replaceAll("-", "").slice(0, 7)}`,
      Source: "Referral",
      "Client Quality": "0.1",
      Country: "Qatar",
      Notes: `${state.markerText} country=Qatar`,
    },
  ];

  const salesDenied = await appRequest(state, "sales", "/api/leads/import/preview", {
    method: "POST",
    body: { rows },
  });
  expectStatus("sales import preview denial", salesDenied, 403);

  const preview = await appRequest(state, "admin", "/api/leads/import/preview", {
    method: "POST",
    body: { rows },
  });
  expectStatus("admin import preview", preview, 200);
  assert.equal(preview.payload?.total_rows, 3, "import preview total_rows mismatch");
  assert.equal(preview.payload?.importable, 3, "import preview importable mismatch");
  assert.equal(preview.payload?.skipped, 0, "import preview skipped mismatch");
  assert.deepEqual(
    preview.payload?.all_rows?.map((row) => row.raw_import_data?.raw_country),
    ["UAE", "KSA", "Qatar"],
    "import preview did not preserve raw country values",
  );

  const confirm = await appRequest(state, "admin", "/api/leads/import/confirm", {
    method: "POST",
    body: { rows: preview.payload.all_rows },
  });
  expectStatus("admin import confirm", confirm, 200);
  assert.equal(confirm.payload?.imported, 3, "first import count mismatch");
  assert.equal(confirm.payload?.failed, 0, "first import reported failures");
  assert.equal(confirm.payload?.skipped_duplicates, 0, "first import skipped rows");
  assertUuid(confirm.payload?.batch_id, "import batch id");
  state.importBatchIds.add(confirm.payload.batch_id);
  for (const id of confirm.payload?.imported_ids ?? []) {
    assertUuid(id, "imported lead id");
    state.leadIds.add(id);
  }

  const duplicate = await appRequest(state, "boss", "/api/leads/import/confirm", {
    method: "POST",
    body: { rows: preview.payload.all_rows },
  });
  expectStatus("duplicate import confirm", duplicate, 200);
  assert.equal(duplicate.payload?.imported, 0, "duplicate import created new rows");
  assert.equal(duplicate.payload?.skipped_duplicates, 3, "duplicate import skip count mismatch");
  assert.equal(duplicate.payload?.failed, 0, "duplicate import reported failures");

  const archiveLead = await createLead(state, "archive");
  const salesArchiveDenied = await appRequest(state, "sales", "/api/leads/archive", {
    method: "POST",
    body: { lead_ids: [archiveLead.id], archive_reason: state.markerText },
  });
  expectStatus("sales archive denial", salesArchiveDenied, 403);

  const previewArchive = await appRequest(
    state,
    "boss",
    `/api/leads/archive?owner_id=${encodeURIComponent(state.actors.get("sales").id)}`,
  );
  expectStatus("boss archive preview", previewArchive, 200);
  assert.ok(previewArchive.payload?.lead_ids?.includes(archiveLead.id), "archive preview omitted marked lead");

  const archived = await appRequest(state, "boss", "/api/leads/archive", {
    method: "POST",
    body: { lead_ids: [archiveLead.id], archive_reason: state.markerText },
  });
  expectStatus("boss archive", archived, 200);
  assert.equal(archived.payload?.requested_count, 1, "archive requested_count mismatch");
  assert.equal(archived.payload?.archived_count, 1, "archive count mismatch");
  assertUuid(archived.payload?.archive_batch_id, "archive batch id");
  state.archiveBatchIds.add(archived.payload.archive_batch_id);

  const batch = await appRequest(
    state,
    "admin",
    `/api/leads/archive?batch_id=${encodeURIComponent(archived.payload.archive_batch_id)}`,
  );
  expectStatus("archive batch readback", batch, 200);
  assert.equal(batch.payload?.count, 1, "archive batch readback count mismatch");
  assert.equal(batch.payload?.leads?.[0]?.id, archiveLead.id, "archive batch returned wrong lead");

  const restored = await appRequest(
    state,
    "boss",
    `/api/leads/archive?batch_id=${encodeURIComponent(archived.payload.archive_batch_id)}`,
    { method: "DELETE" },
  );
  expectStatus("archive restore", restored, 200);
  assert.equal(restored.payload?.restored_count, 1, "archive restore count mismatch");
  state.archiveBatchIds.delete(archived.payload.archive_batch_id);

  const month = new Date().toISOString().slice(0, 7);
  const dashboard = await appRequest(
    state,
    "sales",
    `/api/dashboard/summary?month=${encodeURIComponent(month)}`,
  );
  expectStatus("sales month dashboard", dashboard, 200);
  assert.ok(
    dashboard.payload?.leads?.some((lead) => lead.id === archiveLead.id),
    "dashboard omitted the marked sales lead",
  );
  assert.equal(typeof dashboard.payload?.periodLeads?.count, "number", "month dashboard period count missing");

  return {
    import: { rows: 3, duplicate_skips: 3 },
    archive: { archived: 1, restored: 1 },
    dashboard: { month, marked_lead_visible: true },
  };
}

async function runSam35(state) {
  const lead = await createLead(state, "first-contact");
  const early = await appRequest(state, "sales", `/api/leads/${lead.id}/milestone`, {
    method: "POST",
    body: { milestoneKey: "first_contact", notes: `${state.markerText} too early` },
  });
  expectStatus("First Contact precondition", early, 400);

  const contact = await appRequest(state, "sales", `/api/leads/${lead.id}/contacts`, {
    method: "POST",
    body: {
      contact_method: "phone",
      contact_time: new Date(Date.now() - 5_000).toISOString(),
      contact_result: `${state.markerText} reached`,
      summary: `${state.markerText} first contact`,
    },
  });
  expectStatus("First Contact contact record", contact, 200);

  const quality = await appRequest(state, "sales", `/api/leads/${lead.id}/quality`, {
    method: "POST",
    body: { quality: "good" },
  });
  expectStatus("First Contact quality", quality, 200);

  const completed = await appRequest(state, "sales", `/api/leads/${lead.id}/milestone`, {
    method: "POST",
    body: { milestoneKey: "first_contact", notes: `${state.markerText} confirmed` },
  });
  expectStatus("First Contact completion", completed, 200);
  assert.equal(completed.payload?.success, true, "First Contact completion did not report success");

  const timeline = await appRequest(state, "sales", `/api/leads/${lead.id}/timeline?limit=100`);
  expectStatus("First Contact timeline", timeline, 200);
  assert.match(JSON.stringify(timeline.payload), new RegExp(state.runId, "i"), "timeline omitted marker");

  return { precondition_denied: true, completed: true, timeline_marker: true };
}

async function countForLead(state, table, leadId) {
  const { count, error } = await state.admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId);
  if (error || count === null) fail(`could not count ${table} for marked lead`);
  return count;
}

async function countWhere(state, table, column, value) {
  const { count, error } = await state.admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(column, value);
  if (error || count === null) fail(`could not count ${table}.${column}`);
  return count;
}

async function runSam49(state) {
  const unknown = await createLead(state, "hermes-unknown");
  const nonPositive = await createLead(state, "hermes-non-positive");

  const before = {};
  for (const lead of [unknown, nonPositive]) {
    before[lead.id] = {};
    for (const table of ["quotations", "activities", "business_events"]) {
      before[lead.id][table] = await countForLead(state, table, lead.id);
    }
  }

  const unknownResponse = await appRequest(state, "sales", "/api/hermes/generate-quote", {
    method: "POST",
    body: {
      lead_id: unknown.id,
      devices_json: { product_saas_unknown_device: 1 },
    },
  });
  expectStatus("Hermes unknown device guard", unknownResponse, 400);
  assert.equal(unknownResponse.payload?.error, "Unknown device_ids", "unknown device error mismatch");
  assert.deepEqual(
    unknownResponse.payload?.unknown_devices,
    ["product_saas_unknown_device"],
    "unknown device list mismatch",
  );

  const nonPositiveResponse = await appRequest(state, "sales", "/api/hermes/generate-quote", {
    method: "POST",
    body: {
      lead_id: nonPositive.id,
      devices_json: { knx_ip_router: 0 },
    },
  });
  expectStatus("Hermes non-positive guard", nonPositiveResponse, 400);
  assert.equal(
    nonPositiveResponse.payload?.error,
    "Quotation total must be greater than zero",
    "non-positive total error mismatch",
  );

  for (const lead of [unknown, nonPositive]) {
    for (const table of ["quotations", "activities", "business_events"]) {
      assert.equal(
        await countForLead(state, table, lead.id),
        before[lead.id][table],
        `${table} changed after rejected Hermes request`,
      );
    }
    const { data, error } = await state.admin.from("leads").select("stage").eq("id", lead.id).single();
    if (error || data?.stage !== "new") fail("Hermes rejection changed a marked lead stage");
  }

  return {
    unknown_devices: { status: 400, writes: 0 },
    non_positive_total: { status: 400, writes: 0 },
  };
}

async function runSam25(state) {
  const lead = await createLead(state, "lead-quote-contract-payment-project", {
    stage: "solution_submitted",
    property_type: "apartment",
    property_size_sqm: 150,
    location: `${state.markerText} Dubai`,
    phone: `+97150${state.runId.replaceAll("-", "").slice(0, 7)}`,
  });
  assert.equal(
    lead.stage,
    "solution_submitted",
    "positive quotation fixture did not start at the sequential predecessor stage",
  );
  const negativeMatrix = [];
  const recordNegative = (name, status) => {
    negativeMatrix.push({ name, status, writes: 0 });
  };

  const beforeAnonymous = await countForLead(state, "quotations", lead.id);
  const anonymous = await anonymousAppRequest(state, "/api/hermes/generate-quote", {
    method: "POST",
    body: { lead_id: lead.id, devices_json: { knx_ip_router: 1 } },
  });
  expectStatus("unauthenticated Hermes denial", anonymous, 401);
  assert.equal(
    await countForLead(state, "quotations", lead.id),
    beforeAnonymous,
    "unauthenticated Hermes request wrote a quotation",
  );
  recordNegative("hermes_unauthenticated", 401);

  const generated = await appRequest(state, "sales", "/api/hermes/generate-quote", {
    method: "POST",
    body: { lead_id: lead.id, devices_json: { knx_ip_router: 1 } },
  });
  expectStatus("Hermes positive quotation", generated, 200);
  assert.equal(generated.payload?.status, "ok", "Hermes positive status mismatch");
  assertUuid(generated.payload?.quote_id, "positive quotation id");
  assert.match(generated.payload?.quote_no ?? "", /^NM-\d{4}-\d{4,}$/);
  assert.ok(generated.payload?.total_aed > 0, "positive quotation total must be greater than zero");
  state.quotationIds.add(generated.payload.quote_id);

  const { data: quotation, error: quotationError } = await state.admin
    .from("quotations")
    .select("id, lead_id, quote_no, status, total_amount, devices_json, contract_id")
    .eq("id", generated.payload.quote_id)
    .single();
  if (quotationError || !quotation) fail("could not read back positive quotation");
  assert.equal(quotation.lead_id, lead.id, "quotation did not link to marked lead");
  assert.equal(quotation.status, "draft", "new quotation status was not draft");
  assert.equal(quotation.contract_id, null, "new quotation unexpectedly linked a contract");
  assert.equal(quotation.total_amount, generated.payload.total_aed, "quotation total readback drifted");
  assert.equal(
    quotation.devices_json?.knx_ip_router?.qty,
    1,
    "quotation product detail did not preserve the exact device quantity",
  );
  const { data: quotedLead, error: quotedLeadError } = await state.admin
    .from("leads")
    .select("stage")
    .eq("id", lead.id)
    .single();
  if (quotedLeadError || quotedLead?.stage !== "quotation_submitted") {
    fail("positive quotation did not advance the marked lead");
  }

  const firstDueDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const draftConversion = await appRequest(
    state,
    "sales",
    `/api/quotations/${generated.payload.quote_id}/convert`,
    {
      method: "POST",
      body: {
        installments: [{
          seq: 1,
          amount: generated.payload.total_aed,
          due_date: firstDueDate,
          description: state.markerText,
        }],
      },
    },
  );
  expectStatus("draft quotation conversion denial", draftConversion, 400);
  assert.equal(await countWhere(state, "contracts", "lead_id", lead.id), 0);
  assert.equal(await countWhere(state, "projects", "lead_id", lead.id), 0);
  recordNegative("draft_conversion", 400);

  const { error: acceptError } = await state.admin
    .from("quotations")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", generated.payload.quote_id);
  if (acceptError) fail("could not mark the exact fixture quotation accepted");

  const financeConversion = await appRequest(
    state,
    "finance",
    `/api/quotations/${generated.payload.quote_id}/convert`,
    { method: "POST", body: {} },
  );
  expectStatus("finance quotation conversion denial", financeConversion, 403);
  assert.equal(await countWhere(state, "contracts", "lead_id", lead.id), 0);
  assert.equal(await countWhere(state, "projects", "lead_id", lead.id), 0);
  recordNegative("finance_conversion", 403);

  const converted = await appRequest(
    state,
    "operator",
    `/api/quotations/${generated.payload.quote_id}/convert`,
    {
      method: "POST",
      body: {
        first_payment_due_date: firstDueDate,
        installments: [{
          seq: 1,
          amount: generated.payload.total_aed,
          due_date: firstDueDate,
          description: `${state.markerText} first installment`,
        }],
      },
    },
  );
  expectStatus("accepted quotation conversion", converted, 200);
  assert.equal(converted.payload?.success, true, "quotation conversion did not report success");
  assert.equal(
    converted.payload?.quotation_status,
    "contract_created",
    "quotation conversion status mismatch",
  );
  assertUuid(converted.payload?.contract_id, "positive contract id");
  assert.match(converted.payload?.contract_no ?? "", /^NEW-\d{8}-\d{3,}$/);
  state.contractIds.add(converted.payload.contract_id);

  const { data: contract, error: contractError } = await state.admin
    .from("contracts")
    .select("id, lead_id, quotation_id, sales_id, contract_no, contract_amount, status")
    .eq("id", converted.payload.contract_id)
    .single();
  if (contractError || !contract) fail("could not read back positive contract");
  assert.equal(contract.lead_id, lead.id, "contract did not link to marked lead");
  assert.equal(contract.quotation_id, generated.payload.quote_id, "contract quotation link drifted");
  assert.equal(contract.sales_id, state.actors.get("sales").id, "contract sales owner drifted");
  assert.equal(contract.contract_amount, generated.payload.total_aed, "contract amount drifted");
  assert.equal(contract.status, "draft", "new contract status drifted");
  const { data: convertedQuotation, error: convertedQuotationError } = await state.admin
    .from("quotations")
    .select("status, contract_id")
    .eq("id", generated.payload.quote_id)
    .single();
  if (
    convertedQuotationError
    || convertedQuotation?.status !== "contract_created"
    || convertedQuotation.contract_id !== contract.id
  ) {
    fail("quotation did not link back to the exact contract");
  }
  const { data: wonLead, error: wonLeadError } = await state.admin
    .from("leads")
    .select("final_status")
    .eq("id", lead.id)
    .single();
  if (wonLeadError || wonLead?.final_status !== "won") {
    fail("converted quotation did not mark the exact lead won");
  }

  const { data: plans, error: plansError } = await state.admin
    .from("installment_plans")
    .select("id, contract_id, seq, amount, allocated_amount, status")
    .eq("contract_id", contract.id);
  if (plansError || plans?.length !== 1) fail("positive contract did not create one installment");
  for (const plan of plans) {
    assertUuid(plan.id, "installment plan id");
    state.installmentPlanIds.add(plan.id);
  }
  assert.equal(plans[0].contract_id, contract.id, "installment contract link drifted");
  assert.equal(plans[0].seq, 1, "first installment sequence drifted");
  assert.equal(plans[0].amount, generated.payload.total_aed, "installment amount drifted");

  const { data: approvals, error: approvalsError } = await state.admin
    .from("contract_approvals")
    .select("id, contract_id, step, status")
    .eq("contract_id", contract.id);
  if (approvalsError || approvals?.length !== 1) {
    fail("positive contract did not create one approval record");
  }
  for (const approval of approvals) {
    assertUuid(approval.id, "contract approval id");
    state.contractApprovalIds.add(approval.id);
  }
  assert.equal(approvals[0].contract_id, contract.id, "approval contract link drifted");
  assert.equal(approvals[0].step, "admin_review", "contract approval step drifted");
  assert.equal(approvals[0].status, "pending", "contract approval status drifted");

  const { data: projects, error: projectsError } = await state.admin
    .from("projects")
    .select("id, lead_id, contract_id, sales_id, contract_amount, paid_amount, status")
    .eq("contract_id", contract.id);
  if (projectsError || projects?.length !== 1) {
    fail("positive conversion did not create one project");
  }
  for (const project of projects) {
    assertUuid(project.id, "positive project id");
    state.projectIds.add(project.id);
  }
  assert.equal(projects[0].lead_id, lead.id, "project lead link drifted");
  assert.equal(projects[0].contract_id, contract.id, "project contract link drifted");
  assert.equal(projects[0].sales_id, state.actors.get("sales").id, "project sales owner drifted");
  assert.equal(projects[0].contract_amount, generated.payload.total_aed, "project amount drifted");
  assert.equal(projects[0].status, "active", "project status drifted");

  const duplicateBefore = {
    contracts: await countWhere(state, "contracts", "lead_id", lead.id),
    projects: await countWhere(state, "projects", "lead_id", lead.id),
  };
  const duplicateConversion = await appRequest(
    state,
    "operator",
    `/api/quotations/${generated.payload.quote_id}/convert`,
    { method: "POST", body: {} },
  );
  expectStatus("duplicate quotation conversion denial", duplicateConversion, 400);
  assert.equal(
    await countWhere(state, "contracts", "lead_id", lead.id),
    duplicateBefore.contracts,
    "duplicate conversion created a contract",
  );
  assert.equal(
    await countWhere(state, "projects", "lead_id", lead.id),
    duplicateBefore.projects,
    "duplicate conversion created a project",
  );
  recordNegative("duplicate_conversion", 400);

  const paymentDate = new Date().toISOString().slice(0, 10);
  const zeroPayment = await appRequest(state, "finance", "/api/payments", {
    method: "POST",
    body: {
      contract_id: contract.id,
      amount: 0,
      payment_date: paymentDate,
      payment_method: "bank_transfer",
      reference_no: `${state.marker}-zero`,
    },
  });
  expectStatus("zero payment denial", zeroPayment, 400);
  assert.equal(await countWhere(state, "payments", "contract_id", contract.id), 0);
  recordNegative("zero_amount_payment", 400);

  const paymentAmount = Math.min(1_000, generated.payload.total_aed);
  const payment = await appRequest(state, "finance", "/api/payments", {
    method: "POST",
    body: {
      contract_id: contract.id,
      amount: paymentAmount,
      payment_date: paymentDate,
      payment_method: "bank_transfer",
      reference_no: `${state.marker}-payment`,
      notes: state.markerText,
    },
  });
  expectStatus("positive payment creation", payment, 201);
  assertUuid(payment.payload?.id, "positive payment id");
  assert.equal(payment.payload?.amount, paymentAmount, "positive payment amount drifted");
  state.paymentIds.add(payment.payload.id);

  const operatorConfirmation = await appRequest(
    state,
    "operator",
    `/api/payments/${payment.payload.id}/confirm`,
    { method: "POST", body: {} },
  );
  expectStatus("operator payment confirmation denial", operatorConfirmation, 403);
  const { data: unconfirmed, error: unconfirmedError } = await state.admin
    .from("payments")
    .select("confirmed, confirmed_by")
    .eq("id", payment.payload.id)
    .single();
  if (unconfirmedError || unconfirmed?.confirmed !== false || unconfirmed.confirmed_by !== null) {
    fail("denied operator confirmation changed payment state");
  }
  recordNegative("operator_confirmation", 403);

  const confirmed = await appRequest(
    state,
    "finance",
    `/api/payments/${payment.payload.id}/confirm`,
    { method: "POST", body: {} },
  );
  expectStatus("finance payment confirmation", confirmed, 200);
  assert.equal(confirmed.payload?.data?.success, true, "payment confirmation did not report success");
  assert.equal(
    confirmed.payload?.data?.payment_id,
    payment.payload.id,
    "payment confirmation returned the wrong payment",
  );

  const allocated = await appRequest(
    state,
    "finance",
    `/api/payments/${payment.payload.id}/allocate`,
    {
      method: "POST",
      body: { allocations: [{ plan_id: plans[0].id, amount: paymentAmount }] },
    },
  );
  expectStatus("confirmed payment allocation", allocated, 200);
  assert.equal(allocated.payload?.data?.success, true, "payment allocation did not report success");
  assert.equal(allocated.payload?.data?.allocations_count, 1, "payment allocation count drifted");

  const { data: allocations, error: allocationsError } = await state.admin
    .from("payment_allocations")
    .select("id, payment_id, plan_id, amount_allocated, allocated_by")
    .eq("payment_id", payment.payload.id);
  if (allocationsError || allocations?.length !== 1) {
    fail("positive payment did not create one allocation");
  }
  for (const allocation of allocations) {
    assertUuid(allocation.id, "payment allocation id");
    state.paymentAllocationIds.add(allocation.id);
  }
  assert.equal(allocations[0].payment_id, payment.payload.id, "allocation payment link drifted");
  assert.equal(allocations[0].plan_id, plans[0].id, "allocation installment link drifted");
  assert.equal(allocations[0].amount_allocated, paymentAmount, "allocation amount drifted");
  assert.equal(
    allocations[0].allocated_by,
    state.actors.get("finance").id,
    "allocation actor drifted",
  );

  const { data: finalPayment, error: finalPaymentError } = await state.admin
    .from("payments")
    .select("id, contract_id, amount, confirmed, confirmed_by")
    .eq("id", payment.payload.id)
    .single();
  if (
    finalPaymentError
    || finalPayment?.contract_id !== contract.id
    || finalPayment.amount !== paymentAmount
    || finalPayment.confirmed !== true
    || finalPayment.confirmed_by !== state.actors.get("finance").id
  ) {
    fail("confirmed payment readback drifted");
  }

  const { data: finalProject, error: finalProjectError } = await state.admin
    .from("projects")
    .select("id, paid_amount")
    .eq("id", projects[0].id)
    .single();
  if (finalProjectError || finalProject?.paid_amount !== paymentAmount) {
    fail("confirmed payment did not update the linked project");
  }

  const { data: tasks, error: tasksError } = await state.admin
    .from("tasks")
    .select("id, lead_id")
    .eq("lead_id", lead.id);
  if (tasksError || (tasks ?? []).some((task) => task.lead_id !== lead.id)) {
    fail("marked lead task consistency check failed");
  }
  const relatedIds = [
    lead.id,
    generated.payload.quote_id,
    contract.id,
    payment.payload.id,
    projects[0].id,
  ];
  const { data: notifications, error: notificationsError } = await state.admin
    .from("notifications")
    .select("id, related_id")
    .in("related_id", relatedIds);
  if (
    notificationsError
    || (notifications ?? []).some((notification) => !relatedIds.includes(notification.related_id))
  ) {
    fail("pipeline notification consistency check failed");
  }

  assert.deepEqual(
    negativeMatrix,
    [
      { name: "hermes_unauthenticated", status: 401, writes: 0 },
      { name: "draft_conversion", status: 400, writes: 0 },
      { name: "finance_conversion", status: 403, writes: 0 },
      { name: "duplicate_conversion", status: 400, writes: 0 },
      { name: "zero_amount_payment", status: 400, writes: 0 },
      { name: "operator_confirmation", status: 403, writes: 0 },
    ],
    "SAM-25 negative matrix drifted",
  );

  return {
    positive_chain: {
      lead_id: lead.id,
      quotation_id: generated.payload.quote_id,
      contract_id: contract.id,
      payment_id: payment.payload.id,
      project_id: projects[0].id,
      installment_plan_ids: [plans[0].id],
      payment_allocation_ids: [allocations[0].id],
      quote_no: generated.payload.quote_no,
      contract_no: converted.payload.contract_no,
      total_aed: generated.payload.total_aed,
      payment_confirmed: true,
      project_paid_amount: finalProject.paid_amount,
      product_quantity: quotation.devices_json.knx_ip_router.qty,
      task_count: tasks?.length ?? 0,
      notification_count: notifications?.length ?? 0,
    },
    negative_matrix: negativeMatrix,
  };
}

async function runSam61(state) {
  const outcomes = {};
  for (const role of REQUIRED_ROLES) {
    const actor = state.actors.get(role);
    const { data, error } = await actor.client.rpc("next_quote_no");
    const allowed = ["admin", "boss", "sales"].includes(role);
    if (allowed) {
      if (error || !/^NM-\d{4}-\d{4,}$/.test(data ?? "")) {
        fail(`next_quote_no rejected allowed ${role} role`);
      }
      outcomes[role] = "allowed";
    } else {
      if (!error || !/FORBIDDEN_QUOTE_NUMBER/i.test(error.message ?? "")) {
        fail(`next_quote_no did not reject ${role} role`);
      }
      outcomes[role] = "denied";
    }
  }

  const sales = state.actors.get("sales");
  const sessionDate = "2099-12-31";
  const { count: sessionBefore, error: sessionBeforeError } = await state.admin
    .from("user_session_daily")
    .select("id", { count: "exact", head: true })
    .eq("user_id", sales.id)
    .eq("tenant_id", state.organizationId)
    .eq("session_date", sessionDate);
  if (sessionBeforeError || sessionBefore !== 0) {
    fail("SAM-61 session denial fixture was not initially empty");
  }
  const auditAttempt = await sales.client.from("audit_logs").insert({
    action: `${state.marker}:denied-write`,
    actor_id: sales.id,
    target_id: state.runId,
    target_type: "product_uat",
  });
  if (!auditAttempt.error) fail("authenticated browser role could write audit_logs");

  const sessionAttempt = await sales.client.from("user_session_daily").insert({
    user_id: sales.id,
    session_date: sessionDate,
    tenant_id: state.organizationId,
  });
  if (!sessionAttempt.error) fail("authenticated browser role could write user_session_daily");

  const { count: auditCount, error: auditCountError } = await state.admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("target_id", state.runId);
  const { count: sessionCount, error: sessionCountError } = await state.admin
    .from("user_session_daily")
    .select("id", { count: "exact", head: true })
    .eq("user_id", sales.id)
    .eq("tenant_id", state.organizationId)
    .eq("session_date", sessionDate);
  if (auditCountError || sessionCountError || auditCount !== 0 || sessionCount !== 0) {
    fail("denied audit/session writes left rows behind");
  }

  return {
    next_quote_no: outcomes,
    audit_logs_authenticated_write: "denied",
    user_session_daily_authenticated_write: "denied",
  };
}

async function runCustomerExit(state) {
  const admin = state.actors.get("admin");
  const boss = state.actors.get("boss");
  const operatorStaffId = randomUUID();
  const approverStaffId = randomUUID();
  const supportSessionId = randomUUID();
  state.platformStaffIds.add(operatorStaffId);
  state.platformStaffIds.add(approverStaffId);
  state.supportSessionIds.add(supportSessionId);

  const { error: staffError } = await state.admin.from("platform_staff").insert([
    {
      id: operatorStaffId,
      user_id: admin.id,
      staff_ref: `EXIT-${state.runId.slice(0, 8)}-OP`,
      status: "active",
    },
    {
      id: approverStaffId,
      user_id: boss.id,
      staff_ref: `EXIT-${state.runId.slice(0, 8)}-APP`,
      status: "active",
    },
  ]);
  if (staffError) fail("could not create customer-exit platform staff fixtures");

  const { error: supportError } = await state.admin.from("support_sessions").insert({
    id: supportSessionId,
    organization_id: state.organizationId,
    platform_staff_id: operatorStaffId,
    approved_by_platform_staff_id: approverStaffId,
    ticket_ref: `EXIT-${state.runId}`,
    reason: "Synthetic customer exit verification",
    scope: ["organization:read"],
    status: "active",
    approved_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  if (supportError) fail("could not create customer-exit support session");

  const idempotencyKey = `exit-${state.runId}`;
  const prepared = await appRequest(state, "admin", "/api/platform/organization-exit", {
    method: "POST",
    body: {
      action: "prepare",
      organization_id: state.organizationId,
      approver_user_id: boss.id,
      idempotency_key: idempotencyKey,
      reason: "Synthetic customer-approved staging exit verification",
    },
  });
  expectStatus("customer exit prepare", prepared, 201);
  assert.equal(prepared.payload?.status, "prepared");
  assert.equal(prepared.payload?.organization_status, "read_only");
  assertUuid(prepared.payload?.exit_request_id, "customer exit request");
  state.exitRequestIds.add(prepared.payload.exit_request_id);

  const deniedWrite = await state.admin.from("leads").insert({
    organization_id: state.organizationId,
    customer_name: `${state.markerText} forbidden after freeze`,
    source: "other",
    stage: "new",
  });
  if (!deniedWrite.error || !/organization_is_not_writable/.test(deniedWrite.error.message ?? "")) {
    fail("read-only customer organization accepted a business write");
  }

  const exported = await appRequest(state, "admin", "/api/organizations/export");
  expectStatus("customer export", exported, 200);
  assert.equal(exported.payload?.contract_version, 1);
  assert.match(exported.payload?.data_sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(exported.payload?.data?.counts?.organizations, 1);
  assert.ok(exported.payload?.data?.counts?.memberships >= REQUIRED_ROLES.length);
  assert.ok(exported.payload?.data?.counts?.leads >= 1);

  const completionBody = {
    action: "complete",
    organization_id: state.organizationId,
    approver_user_id: boss.id,
    idempotency_key: idempotencyKey,
    expected_export_sha256: exported.payload.data_sha256,
    backup_evidence_ref: `staging-backup-${state.config.releaseSha}`,
    customer_confirmation_ref: `synthetic-confirmation-${state.runId}`,
    retention_basis: "synthetic-staging-seven-year-contractual-retention",
  };
  const completed = await appRequest(state, "admin", "/api/platform/organization-exit", {
    method: "POST",
    body: completionBody,
  });
  expectStatus("customer exit complete", completed, 200);
  assert.equal(completed.payload?.status, "completed");
  assert.equal(completed.payload?.organization_status, "closed");
  assert.equal(completed.payload?.data_deleted, false);

  const retried = await appRequest(state, "admin", "/api/platform/organization-exit", {
    method: "POST",
    body: completionBody,
  });
  expectStatus("customer exit idempotent retry", retried, 200);
  assert.equal(retried.payload?.idempotent, true);

  const [organization, activeMemberships, supportSession, retainedLeads] = await Promise.all([
    state.admin.from("organizations").select("status,closed_at").eq("id", state.organizationId).single(),
    state.admin.from("memberships").select("id", { count: "exact", head: true })
      .eq("organization_id", state.organizationId).eq("status", "active"),
    state.admin.from("support_sessions").select("status,revoked_at").eq("id", supportSessionId).single(),
    state.admin.from("leads").select("id", { count: "exact", head: true })
      .eq("organization_id", state.organizationId),
  ]);
  if (organization.error || organization.data?.status !== "closed" || !organization.data?.closed_at) {
    fail("customer exit did not close the organization");
  }
  if (activeMemberships.error || activeMemberships.count !== 0) {
    fail("customer exit did not deactivate every membership");
  }
  if (supportSession.error || supportSession.data?.status !== "revoked" || !supportSession.data?.revoked_at) {
    fail("customer exit did not revoke support access");
  }
  if (retainedLeads.error || !retainedLeads.count) {
    fail("customer exit deleted retained business data");
  }

  const deniedAfterClose = await appRequest(state, "admin", "/api/organizations/export");
  expectStatus("closed organization customer access", deniedAfterClose, [401, 403]);

  return {
    exit_request_id: prepared.payload.exit_request_id,
    export_sha256: exported.payload.data_sha256,
    organization_status: organization.data.status,
    active_memberships: activeMemberships.count,
    support_session_status: supportSession.data.status,
    retained_leads: retainedLeads.count,
    completion_retry: "idempotent",
    data_deleted: false,
  };
}

function exactSam13FixtureIdentity(user, state) {
  const email = typeof user?.email === "string" ? user.email.toLowerCase() : "";
  const metadata = user?.user_metadata ?? {};
  return state.sam13FixtureEmails.has(email)
    && typeof metadata.full_name === "string"
    && metadata.full_name.startsWith(`${state.markerText} SAM-13 `)
    && REQUIRED_ROLES.includes(metadata.role);
}

async function discoverSam13FixtureUsers(state) {
  const users = await listAllAuthUsers(state.admin);
  const discovered = users.filter((user) => exactSam13FixtureIdentity(user, state));
  for (const user of discovered) state.userIds.add(user.id);
  return discovered;
}

function sam13UserInput(state, suffix) {
  const email = `${state.marker}-sam13-${suffix}@invalid.test`.toLowerCase();
  const input = {
    email,
    password: `${randomBytes(32).toString("base64url")}Aa1!`,
    full_name: `${state.markerText} SAM-13 ${suffix}`,
    role: "sales",
  };
  state.sam13FixtureEmails.add(email);
  return input;
}

async function createSam13User(state, actorRole, suffix) {
  const input = sam13UserInput(state, suffix);
  const response = await appRequest(state, actorRole, "/api/users", {
    method: "POST",
    body: input,
  });
  expectStatus(`${actorRole} user create`, response, 201);
  assert.equal(
    response.payload?.organization_id,
    state.organizationId,
    `${actorRole} user create escaped the marked organization`,
  );
  assertUuid(response.payload?.user?.id, `${actorRole} created user id`);
  assert.equal(response.payload?.user?.email, input.email, `${actorRole} created wrong email`);
  state.userIds.add(response.payload.user.id);
  return { ...input, id: response.payload.user.id };
}

async function membershipSnapshot(state, userId) {
  const { data, error } = await state.admin
    .from("memberships")
    .select("id,status,version,deactivated_at,recovery_deadline")
    .eq("organization_id", state.organizationId)
    .eq("user_id", userId)
    .single();
  if (error || !data) fail("could not read exact SAM-13 membership");
  return data;
}

async function profileSnapshot(state, userId) {
  const { data, error } = await state.admin
    .from("profiles")
    .select("id,is_active,password_changed_at")
    .eq("id", userId)
    .single();
  if (error || !data) fail("could not read exact SAM-13 profile");
  return data;
}

async function signInSam13User(state, user, label) {
  const client = createClient(state.config.supabaseUrl, state.config.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-newme-organization-id": state.organizationId } },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error || !data.session || data.user?.id !== user.id) {
    fail(`${label} credentials were not accepted`);
  }
  return data.session;
}

function expectAccessError(label, response, status, code) {
  expectStatus(label, response, status);
  assert.equal(response.payload?.error, code, `${label}: unexpected error code`);
}

async function runSam13(state) {
  const adminCreated = await createSam13User(state, "admin", "admin-created");
  const bossCreated = await createSam13User(state, "boss", "boss-created");

  for (const role of ["admin", "boss"]) {
    const listed = await appRequest(state, role, "/api/users");
    expectStatus(`${role} user list`, listed, 200);
    assert.equal(listed.payload?.organization_id, state.organizationId);
    for (const user of [adminCreated, bossCreated]) {
      assert.ok(
        listed.payload?.users?.some((entry) => entry.id === user.id),
        `${role} user list omitted ${user.id}`,
      );
    }
  }

  const originalMembership = await membershipSnapshot(state, adminCreated.id);
  const originalPasswordProfile = await profileSnapshot(state, bossCreated.id);
  const deniedEmails = new Set();
  const denied = {};
  for (const role of NON_MANAGEMENT_ROLES) {
    const deniedInput = sam13UserInput(state, `denied-${role}`);
    deniedEmails.add(deniedInput.email);
    const createResponse = await appRequest(state, role, "/api/users", {
      method: "POST",
      body: deniedInput,
    });
    expectAccessError(
      `${role} user create denial`,
      createResponse,
      403,
      "organization_admin_required",
    );

    const deleteResponse = await appRequest(
      state,
      role,
      `/api/users/${adminCreated.id}`,
      { method: "DELETE" },
    );
    expectAccessError(
      `${role} user deactivate denial`,
      deleteResponse,
      403,
      "organization_admin_required",
    );

    const passwordResponse = await appRequest(
      state,
      role,
      `/api/users/${bossCreated.id}/password`,
      {
        method: "PATCH",
        body: { password: `${randomBytes(32).toString("base64url")}Aa1!` },
      },
    );
    expectAccessError(
      `${role} password reset denial`,
      passwordResponse,
      403,
      "organization_admin_required",
    );
    denied[role] = { create: 403, deactivate: 403, password_reset: 403 };
  }

  const afterDeniedMembership = await membershipSnapshot(state, adminCreated.id);
  const afterDeniedPasswordProfile = await profileSnapshot(state, bossCreated.id);
  assert.deepEqual(
    afterDeniedMembership,
    originalMembership,
    "non-management deactivate attempts changed membership state",
  );
  assert.deepEqual(
    afterDeniedPasswordProfile,
    originalPasswordProfile,
    "non-management password attempts changed profile state",
  );
  await signInSam13User(state, bossCreated, "original password after denied resets");
  const afterDeniedUsers = await discoverSam13FixtureUsers(state);
  assert.equal(
    afterDeniedUsers.filter((user) => deniedEmails.has(user.email?.toLowerCase())).length,
    0,
    "non-management create attempt left an auth identity",
  );

  const adminResetPassword = `${randomBytes(32).toString("base64url")}Aa1!`;
  const bossReset = await appRequest(
    state,
    "boss",
    `/api/users/${adminCreated.id}/password`,
    { method: "PATCH", body: { password: adminResetPassword } },
  );
  expectStatus("boss password reset", bossReset, 200);
  assert.equal(bossReset.payload?.success, true);
  adminCreated.password = adminResetPassword;
  await signInSam13User(state, adminCreated, "boss-reset password");

  const bossResetPassword = `${randomBytes(32).toString("base64url")}Aa1!`;
  const adminReset = await appRequest(
    state,
    "admin",
    `/api/users/${bossCreated.id}/password`,
    { method: "PATCH", body: { password: bossResetPassword } },
  );
  expectStatus("admin password reset", adminReset, 200);
  assert.equal(adminReset.payload?.success, true);
  bossCreated.password = bossResetPassword;
  await signInSam13User(state, bossCreated, "admin-reset password");

  const bossDeactivate = await appRequest(
    state,
    "boss",
    `/api/users/${adminCreated.id}`,
    { method: "DELETE" },
  );
  expectStatus("boss user deactivate", bossDeactivate, 200);
  assert.equal(bossDeactivate.payload?.success, true);
  const adminDeactivate = await appRequest(
    state,
    "admin",
    `/api/users/${bossCreated.id}`,
    { method: "DELETE" },
  );
  expectStatus("admin user deactivate", adminDeactivate, 200);
  assert.equal(adminDeactivate.payload?.success, true);
  assert.equal((await membershipSnapshot(state, adminCreated.id)).status, "inactive");
  assert.equal((await membershipSnapshot(state, bossCreated.id)).status, "inactive");

  const { data: auditEvents, error: auditEventsError } = await state.admin
    .from("audit_events")
    .select("action,metadata")
    .eq("organization_id", state.organizationId)
    .eq("action", "organization.member.deactivate");
  if (auditEventsError) fail("could not verify SAM-13 deactivation audit events");
  assert.equal(auditEvents?.length, 2, "SAM-13 deactivation audit event count mismatch");
  assert.deepEqual(
    new Set((auditEvents ?? []).map((event) => event.metadata?.target_user_id)),
    new Set([adminCreated.id, bossCreated.id]),
    "deactivation audit events did not match exact SAM-13 target users",
  );

  await createActor(state, "admin", "inactive-admin");
  const inactiveActor = state.actors.get("inactive-admin");
  const { error: inactiveError } = await state.admin
    .from("profiles")
    .update({ is_active: false })
    .eq("id", inactiveActor.id);
  if (inactiveError) fail("could not deactivate the exact SAM-13 profile");
  const inactiveSession = await signInSam13User(
    state,
    inactiveActor,
    "inactive Supabase identity",
  );
  inactiveActor.token = inactiveSession.access_token;
  inactiveActor.client = state.userClient(inactiveSession.access_token);

  const inactiveMe = await appRequest(state, "inactive-admin", "/api/auth/me");
  expectAccessError("inactive auth/me", inactiveMe, 401, "inactive_account");
  const inactiveUsers = await appRequest(state, "inactive-admin", "/api/users");
  expectAccessError("inactive users API", inactiveUsers, 401, "inactive_account");
  const inactiveInput = sam13UserInput(state, "denied-inactive-admin");
  const inactiveCreate = await appRequest(state, "inactive-admin", "/api/users", {
    method: "POST",
    body: inactiveInput,
  });
  expectAccessError("inactive user create denial", inactiveCreate, 401, "inactive_account");
  const inactiveTeam = await appRequest(state, "inactive-admin", "/team");
  expectStatus("inactive protected team route", inactiveTeam, 307);
  assert.ok(inactiveTeam.location, "inactive protected team route omitted Location");
  const inactiveLocation = new URL(inactiveTeam.location, state.config.baseUrl);
  assert.equal(inactiveLocation.pathname, "/login");
  assert.equal(inactiveLocation.searchParams.get("reason"), "inactive_account");
  assert.equal((await profileSnapshot(state, inactiveActor.id)).is_active, false);
  assert.equal((await membershipSnapshot(state, inactiveActor.id)).status, "active");
  const afterInactiveUsers = await discoverSam13FixtureUsers(state);
  assert.equal(
    afterInactiveUsers.filter((user) => user.email?.toLowerCase() === inactiveInput.email).length,
    0,
    "inactive user create attempt left an auth identity",
  );

  const dangerousPaths = {};
  for (const path of SAM13_DANGEROUS_PATHS) {
    const response = await appRequest(state, "admin", path);
    expectStatus(`dangerous release path ${path}`, response, 404);
    dangerousPaths[path] = 404;
  }

  return {
    contract_version: SAM13_CONTRACT_VERSION,
    admin_boss: {
      list: 2,
      create: 2,
      password_reset: 2,
      deactivate: 2,
      audit_events: 2,
    },
    non_management: denied,
    inactive_profile: {
      supabase_session_obtained: true,
      auth_me: 401,
      users_api: 401,
      create: 401,
      protected_team: 307,
      writes: 0,
    },
    dangerous_release_paths: dangerousPaths,
  };
}

async function deleteByLeadIds(state, table, column = "lead_id") {
  if (state.leadIds.size === 0) return;
  const { error } = await state.admin.from(table).delete().in(column, [...state.leadIds]);
  if (error) fail(`cleanup failed for ${table}.${column}`);
}

async function countByLeadIds(state, table, column = "lead_id") {
  if (state.leadIds.size === 0) return 0;
  const { count, error } = await state.admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .in(column, [...state.leadIds]);
  if (error || count === null) fail(`cleanup verification failed for ${table}.${column}`);
  return count;
}

async function cleanup(state) {
  const errors = [];
  const organizationMembershipIds = [];
  const capture = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      errors.push(`${label}: ${safeMessage(error)}`);
    }
  };

  await capture("reopen exact organization for cleanup", async () => {
    const { error } = await state.admin
      .from("organizations")
      .update({ status: "active", closed_at: null })
      .eq("id", state.organizationId);
    if (error) fail("could not reopen exact marked organization for cleanup");
  });

  for (const batchId of state.archiveBatchIds) {
    await capture("restore archive batch", async () => {
      const { error } = await state.admin.from("leads").update({
        archived: false,
        archived_at: null,
        archive_batch_id: null,
        archive_reason: null,
      }).eq("archive_batch_id", batchId);
      if (error) fail("could not restore marked archive batch");
    });
  }

  await capture("discover marked leads", async () => {
    const { data, error } = await state.admin
      .from("leads")
      .select("id")
      .like("customer_name", `${state.markerText}%`);
    if (error) fail("could not discover all marked leads before cleanup");
    for (const lead of data ?? []) {
      if (UUID_PATTERN.test(lead.id ?? "")) state.leadIds.add(lead.id);
    }
  });

  await capture("discover marked quotations", async () => {
    if (state.leadIds.size === 0) return;
    const { data, error } = await state.admin
      .from("quotations")
      .select("id,contract_id")
      .in("lead_id", [...state.leadIds]);
    if (error) fail("could not discover marked quotations before cleanup");
    for (const quotation of data ?? []) {
      if (UUID_PATTERN.test(quotation.id ?? "")) state.quotationIds.add(quotation.id);
      if (UUID_PATTERN.test(quotation.contract_id ?? "")) state.contractIds.add(quotation.contract_id);
    }
  });
  await capture("discover marked contracts", async () => {
    if (state.leadIds.size === 0) return;
    const { data, error } = await state.admin
      .from("contracts")
      .select("id")
      .in("lead_id", [...state.leadIds]);
    if (error) fail("could not discover marked contracts before cleanup");
    for (const contract of data ?? []) {
      if (UUID_PATTERN.test(contract.id ?? "")) state.contractIds.add(contract.id);
    }
  });
  await capture("discover marked projects", async () => {
    if (state.leadIds.size === 0) return;
    const { data, error } = await state.admin
      .from("projects")
      .select("id,contract_id")
      .in("lead_id", [...state.leadIds]);
    if (error) fail("could not discover marked projects before cleanup");
    for (const project of data ?? []) {
      if (UUID_PATTERN.test(project.id ?? "")) state.projectIds.add(project.id);
      if (UUID_PATTERN.test(project.contract_id ?? "")) state.contractIds.add(project.contract_id);
    }
  });
  await capture("discover marked contract children", async () => {
    if (state.contractIds.size === 0) return;
    for (const [table, target] of [
      ["installment_plans", state.installmentPlanIds],
      ["contract_approvals", state.contractApprovalIds],
      ["payments", state.paymentIds],
    ]) {
      const { data, error } = await state.admin
        .from(table)
        .select("id")
        .in("contract_id", [...state.contractIds]);
      if (error) fail(`could not discover marked ${table} before cleanup`);
      for (const row of data ?? []) {
        if (UUID_PATTERN.test(row.id ?? "")) target.add(row.id);
      }
    }
  });
  await capture("discover marked payment allocations", async () => {
    if (state.paymentIds.size === 0) return;
    const { data, error } = await state.admin
      .from("payment_allocations")
      .select("id")
      .in("payment_id", [...state.paymentIds]);
    if (error) fail("could not discover marked payment allocations before cleanup");
    for (const allocation of data ?? []) {
      if (UUID_PATTERN.test(allocation.id ?? "")) state.paymentAllocationIds.add(allocation.id);
    }
  });

  const leadTables = [
    ["activities", "lead_id"],
    ["business_events", "lead_id"],
    ["tasks", "lead_id"],
    ["lead_milestones", "lead_id"],
    ["lead_workflow_stages", "lead_id"],
    ["follow_up_logs", "lead_id"],
    ["lead_mutation_requests", "lead_id"],
    ["transfer_history", "lead_id"],
    ["lead_deletion_requests", "deleted_lead_id"],
    ["chat_messages", "lead_id"],
    ["lead_documents", "lead_id"],
  ];
  const directlyDeletedLeadTables = leadTables.filter(
    ([table]) => table !== "lead_milestones",
  );
  for (const [table, column] of directlyDeletedLeadTables) {
    await capture(`${table}.${column}`, () => deleteByLeadIds(state, table, column));
  }
  await capture("archive activity marker", async () => {
    const { error } = await state.admin.from("activities").delete().like("content", `%${state.markerText}%`);
    if (error) fail("could not delete marked archive activities");
  });
  await capture("archive business-event marker", async () => {
    const { error } = await state.admin.from("business_events").delete().like("description", `%${state.markerText}%`);
    if (error) fail("could not delete marked archive business events");
  });
  await capture("pipeline notifications", async () => {
    const relatedIds = [
      ...state.leadIds,
      ...state.quotationIds,
      ...state.contractIds,
      ...state.paymentIds,
      ...state.projectIds,
      ...state.installmentPlanIds,
    ];
    if (relatedIds.length === 0) return;
    const { error } = await state.admin.from("notifications").delete().in("related_id", relatedIds);
    if (error) fail("could not delete marked pipeline notifications");
  });
  await capture("payment allocations", async () => {
    if (state.paymentAllocationIds.size === 0) return;
    const { error } = await state.admin
      .from("payment_allocations")
      .delete()
      .in("id", [...state.paymentAllocationIds]);
    if (error) fail("could not delete marked payment allocations");
  });
  await capture("payments", async () => {
    if (state.paymentIds.size === 0) return;
    const { error } = await state.admin.from("payments").delete().in("id", [...state.paymentIds]);
    if (error) fail("could not delete marked payments");
  });
  await capture("installment plans", async () => {
    if (state.installmentPlanIds.size === 0) return;
    const { error } = await state.admin
      .from("installment_plans")
      .delete()
      .in("id", [...state.installmentPlanIds]);
    if (error) fail("could not delete marked installment plans");
  });
  await capture("contract approvals", async () => {
    if (state.contractApprovalIds.size === 0) return;
    const { error } = await state.admin
      .from("contract_approvals")
      .delete()
      .in("id", [...state.contractApprovalIds]);
    if (error) fail("could not delete marked contract approvals");
  });
  await capture("projects", async () => {
    if (state.projectIds.size === 0) return;
    const { error } = await state.admin.from("projects").delete().in("id", [...state.projectIds]);
    if (error) fail("could not delete marked projects");
  });
  await capture("break quotation contract links", async () => {
    if (state.quotationIds.size === 0) return;
    const { error } = await state.admin
      .from("quotations")
      .update({ contract_id: null })
      .in("id", [...state.quotationIds]);
    if (error) fail("could not break marked quotation contract links");
  });
  await capture("contracts", async () => {
    if (state.contractIds.size === 0) return;
    const { error } = await state.admin.from("contracts").delete().in("id", [...state.contractIds]);
    if (error) fail("could not delete marked contracts");
  });
  await capture("quotations", async () => {
    if (state.quotationIds.size === 0) return;
    const { error } = await state.admin
      .from("quotations")
      .delete()
      .in("id", [...state.quotationIds]);
    if (error) fail("could not delete marked quotations");
  });
  await capture("marked leads", () => deleteByLeadIds(state, "leads", "id"));
  await capture("discovered marked leads", async () => {
    const { error } = await state.admin.from("leads").delete().like("customer_name", `${state.markerText}%`);
    if (error) fail("could not delete discovered marked leads");
  });

  const discovered = await listAllAuthUsers(state.admin).catch((error) => {
    errors.push(`discover marked auth users: ${safeMessage(error)}`);
    return [];
  });
  for (const user of discovered) {
    if (exactIdentityMarker(user, state.runId) || exactSam13FixtureIdentity(user, state)) {
      state.userIds.add(user.id);
    }
  }
  for (const id of state.userIds) {
    await capture("user_session_daily", async () => {
      const { error } = await state.admin.from("user_session_daily").delete().eq("user_id", id);
      if (error) fail("could not delete marked user sessions");
    });
    await capture("audit_logs", async () => {
      const { error } = await state.admin.from("audit_logs").delete().eq("actor_id", id);
      if (error) fail("could not delete marked audit logs");
    });
    await capture("activity_logs", async () => {
      const { error } = await state.admin.from("activity_logs").delete().eq("user_id", id);
      if (error) fail("could not delete marked activity logs");
    });
    await capture("activities by user", async () => {
      const { error } = await state.admin.from("activities").delete().eq("user_id", id);
      if (error) fail("could not delete marked user activities");
    });
  }
  await capture("audit_events", async () => {
    const { error } = await state.admin
      .from("audit_events")
      .delete()
      .eq("organization_id", state.organizationId);
    if (error) fail("could not delete marked audit events");
  });
  await capture("support sessions", async () => {
    if (state.supportSessionIds.size === 0) return;
    const { error } = await state.admin
      .from("support_sessions")
      .delete()
      .in("id", [...state.supportSessionIds]);
    if (error) fail("could not delete marked support sessions");
  });
  await capture("organization exit requests", async () => {
    if (state.exitRequestIds.size === 0) return;
    const { error } = await state.admin
      .from("organization_exit_requests")
      .delete()
      .in("id", [...state.exitRequestIds]);
    if (error) fail("could not delete marked organization exit requests");
  });
  await capture("discover organization memberships", async () => {
    const { data, error } = await state.admin
      .from("memberships")
      .select("id")
      .eq("organization_id", state.organizationId);
    if (error) fail("could not discover marked memberships");
    for (const membership of data ?? []) {
      if (UUID_PATTERN.test(membership.id ?? "")) {
        organizationMembershipIds.push(membership.id);
      }
    }
  });
  await capture("membership_roles", async () => {
    if (organizationMembershipIds.length === 0) return;
    const { error } = await state.admin
      .from("membership_roles")
      .delete()
      .in("membership_id", organizationMembershipIds);
    if (error) fail("could not delete marked membership roles");
  });
  await capture("memberships", async () => {
    const { error } = await state.admin.from("memberships").delete().eq("organization_id", state.organizationId);
    if (error) fail("could not delete marked memberships");
  });
  await capture("platform staff", async () => {
    if (state.platformStaffIds.size === 0) return;
    const { error } = await state.admin
      .from("platform_staff")
      .delete()
      .in("id", [...state.platformStaffIds]);
    if (error) fail("could not delete marked platform staff");
  });

  for (const id of state.userIds) {
    await capture("auth identity", async () => {
      const { error } = await state.admin.auth.admin.deleteUser(id, false);
      if (error) fail("could not delete exact marked auth identity");
    });
    await capture("profile", async () => {
      const { error } = await state.admin.from("profiles").delete().eq("id", id);
      if (error) fail("could not delete marked profile");
    });
  }
  await capture("organization", async () => {
    const { error } = await state.admin.from("organizations").delete().eq("id", state.organizationId);
    if (error) fail("could not delete marked organization");
  });

  const remainingAuth = (await listAllAuthUsers(state.admin))
    .filter((candidate) => (
      exactIdentityMarker(candidate, state.runId)
      || exactSam13FixtureIdentity(candidate, state)
    )).length;
  const pipelineRelatedIds = [
    ...state.leadIds,
    ...state.quotationIds,
    ...state.contractIds,
    ...state.paymentIds,
    ...state.projectIds,
    ...state.installmentPlanIds,
  ];
  const counts = {
    auth_users: remainingAuth,
    profiles: await exactCount(state.admin, "profiles", "id", [...state.userIds]),
    organizations: await exactCount(state.admin, "organizations", "id", [state.organizationId]),
    memberships: await exactCount(state.admin, "memberships", "organization_id", [state.organizationId]),
    support_sessions: await exactCount(
      state.admin,
      "support_sessions",
      "id",
      [...state.supportSessionIds],
    ),
    organization_exit_requests: await exactCount(
      state.admin,
      "organization_exit_requests",
      "id",
      [...state.exitRequestIds],
    ),
    platform_staff: await exactCount(
      state.admin,
      "platform_staff",
      "id",
      [...state.platformStaffIds],
    ),
    membership_roles: await exactCount(
      state.admin,
      "membership_roles",
      "membership_id",
      organizationMembershipIds,
    ),
    leads: await exactLikeCount(state.admin, "leads", "customer_name", `${state.markerText}%`),
    audit_logs: await exactCount(state.admin, "audit_logs", "actor_id", [...state.userIds]),
    activity_logs: await exactCount(state.admin, "activity_logs", "user_id", [...state.userIds]),
    activities: await exactCount(state.admin, "activities", "user_id", [...state.userIds]),
    audit_events: await exactCount(
      state.admin,
      "audit_events",
      "organization_id",
      [state.organizationId],
    ),
    user_session_daily: await exactCount(state.admin, "user_session_daily", "user_id", [...state.userIds]),
    quotations: await exactCount(state.admin, "quotations", "id", [...state.quotationIds]),
    contracts: await exactCount(state.admin, "contracts", "id", [...state.contractIds]),
    payments: await exactCount(state.admin, "payments", "id", [...state.paymentIds]),
    projects: await exactCount(state.admin, "projects", "id", [...state.projectIds]),
    installment_plans: await exactCount(
      state.admin,
      "installment_plans",
      "id",
      [...state.installmentPlanIds],
    ),
    contract_approvals: await exactCount(
      state.admin,
      "contract_approvals",
      "id",
      [...state.contractApprovalIds],
    ),
    payment_allocations: await exactCount(
      state.admin,
      "payment_allocations",
      "id",
      [...state.paymentAllocationIds],
    ),
    pipeline_notifications: await exactCount(
      state.admin,
      "notifications",
      "related_id",
      pipelineRelatedIds,
    ),
    lead_children: 0,
  };
  for (const [table, column] of leadTables) {
    counts.lead_children += await countByLeadIds(state, table, column);
  }
  if (errors.length > 0 || Object.values(counts).some((count) => count !== 0)) {
    fail(`cleanup was not exact: ${JSON.stringify({ counts, errors })}`);
  }
  return counts;
}

async function exactCount(admin, table, column, values) {
  if (values.length === 0) return 0;
  const { count, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .in(column, values);
  if (error || count === null) fail(`could not verify ${table} cleanup`);
  return count;
}

async function exactLikeCount(admin, table, column, pattern) {
  const { count, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .like(column, pattern);
  if (error || count === null) fail(`could not verify ${table} marker cleanup`);
  return count;
}

async function recordIssue(report, linearId, operation) {
  try {
    const evidence = await operation();
    report.results[linearId] = { status: "pass", evidence };
  } catch (error) {
    report.results[linearId] = { status: "fail", error: safeMessage(error) };
    report.ok = false;
  }
}

export async function runProductSaasFinalUat(env = process.env, dependencies = {}) {
  const config = validateEnvironment(env);
  const release = await verifyReleaseBoundary(config, dependencies);
  const runId = randomUUID();
  const report = {
    ok: true,
    scope: FIXTURE_SCOPE,
    run_id: runId,
    release,
    results: {},
    cleanup: "not-run",
    cleanupCounts: null,
  };
  const state = initializeState(config, runId);
  let cleanupError;
  try {
    await prepareFixtures(state);
    await recordIssue(report, "SAM-11", () => runSam11(state));
    await recordIssue(report, "SAM-25", () => runSam25(state));
    await recordIssue(report, "SAM-35", () => runSam35(state));
    await recordIssue(report, "SAM-49", () => runSam49(state));
    await recordIssue(report, "SAM-61", () => runSam61(state));
    await recordIssue(report, "SAM-13", () => runSam13(state));
    await recordIssue(report, CUSTOMER_EXIT_RESULT_ID, () => runCustomerExit(state));
  } finally {
    try {
      report.cleanupCounts = await cleanup(state);
      report.cleanup = "verified";
    } catch (error) {
      report.ok = false;
      report.cleanup = "failed";
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
  if (Object.keys(report.results).length !== REQUIRED_RESULT_IDS.length) {
    fail("not every required Product/SaaS acceptance result was produced");
  }
  return report;
}

async function main() {
  try {
    const report = await runProductSaasFinalUat();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${safeMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
