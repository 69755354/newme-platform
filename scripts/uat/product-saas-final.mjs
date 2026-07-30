#!/usr/bin/env node
/**
 * Final staging-only Product/SaaS UAT for SAM-11, SAM-35, SAM-49, and SAM-61.
 *
 * The runner is intentionally not wired into a package script or controller.
 * An operator must provide the approved release SHA, the fixed local release
 * manifest, and staging-only Supabase credentials. No secret or credential is
 * included in the JSON report.
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
export const LINEAR_IDS = ["SAM-11", "SAM-35", "SAM-49", "SAM-61"];

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

async function createActor(state, role) {
  const email = `${state.marker}-${role}@invalid.test`;
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
    },
    user_metadata: { full_name: `[PRODUCT-UAT ${state.runId}] ${role}` },
  });
  if (error || !data.user || !exactIdentityMarker(data.user, state.runId)) {
    fail(`could not create exact marked ${role} identity`);
  }
  state.userIds.add(data.user.id);

  const { error: profileError } = await state.admin.from("profiles").update({
    role,
    full_name: `[PRODUCT-UAT ${state.runId}] ${role}`,
    email,
    is_active: true,
    force_password_change: false,
  }).eq("id", data.user.id);
  if (profileError) fail(`could not configure ${role} profile`);

  const { error: membershipError } = await state.admin.from("memberships").insert({
    organization_id: state.organizationId,
    user_id: data.user.id,
    status: "active",
    accepted_at: new Date().toISOString(),
  });
  if (membershipError) fail(`could not create ${role} organization membership`);

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
  state.actors.set(role, {
    id: data.user.id,
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
    importBatchIds: new Set(),
    archiveBatchIds: new Set(),
  };
}

async function prepareFixtures(state) {
  const { admin, organizationId, runId } = state;
  const { error: organizationError } = await admin.from("organizations").insert({
    id: organizationId,
    slug: `product-saas-${runId}`,
    name: `${state.markerText} organization`,
    industry_key: "real_estate",
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

async function runSam49(state) {
  const unknown = await createLead(state, "hermes-unknown", {
    devices_json: { product_saas_unknown_device: 1 },
  });
  const nonPositive = await createLead(state, "hermes-non-positive", {
    devices_json: { knx_ip_router: 0 },
  });

  const before = {};
  for (const lead of [unknown, nonPositive]) {
    before[lead.id] = {};
    for (const table of ["quotations", "activities", "business_events"]) {
      before[lead.id][table] = await countForLead(state, table, lead.id);
    }
  }

  const unknownResponse = await appRequest(state, "sales", "/api/hermes/generate-quote", {
    method: "POST",
    body: { lead_id: unknown.id },
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
    body: { lead_id: nonPositive.id },
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
  const auditAttempt = await sales.client.from("audit_logs").insert({
    action: `${state.marker}:denied-write`,
    actor_id: sales.id,
    target_id: state.runId,
    target_type: "product_uat",
  });
  if (!auditAttempt.error) fail("authenticated browser role could write audit_logs");

  const sessionAttempt = await sales.client.from("user_session_daily").insert({
    user_id: sales.id,
    session_date: new Date().toISOString().slice(0, 10),
    tenant_id: state.marker,
  });
  if (!sessionAttempt.error) fail("authenticated browser role could write user_session_daily");

  const { count: auditCount, error: auditCountError } = await state.admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("target_id", state.runId);
  const { count: sessionCount, error: sessionCountError } = await state.admin
    .from("user_session_daily")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", state.marker);
  if (auditCountError || sessionCountError || auditCount !== 0 || sessionCount !== 0) {
    fail("denied audit/session writes left rows behind");
  }

  return {
    next_quote_no: outcomes,
    audit_logs_authenticated_write: "denied",
    user_session_daily_authenticated_write: "denied",
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
  const capture = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      errors.push(`${label}: ${safeMessage(error)}`);
    }
  };

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

  const leadTables = [
    ["notifications", "related_id"],
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
    ["quotations", "lead_id"],
  ];
  for (const [table, column] of leadTables) {
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
  await capture("marked leads", () => deleteByLeadIds(state, "leads", "id"));
  await capture("discovered marked leads", async () => {
    const { error } = await state.admin.from("leads").delete().like("customer_name", `${state.markerText}%`);
    if (error) fail("could not delete discovered marked leads");
  });

  for (const id of state.userIds) {
    await capture("user_session_daily", async () => {
      const { error } = await state.admin.from("user_session_daily").delete().eq("user_id", id);
      if (error) fail("could not delete marked user sessions");
    });
    await capture("audit_logs", async () => {
      const { error } = await state.admin.from("audit_logs").delete().eq("actor_id", id);
      if (error) fail("could not delete marked audit logs");
    });
  }
  await capture("memberships", async () => {
    const { error } = await state.admin.from("memberships").delete().eq("organization_id", state.organizationId);
    if (error) fail("could not delete marked memberships");
  });

  const discovered = await listAllAuthUsers(state.admin).catch((error) => {
    errors.push(`discover marked auth users: ${safeMessage(error)}`);
    return [];
  });
  for (const user of discovered.filter((candidate) => exactIdentityMarker(candidate, state.runId))) {
    state.userIds.add(user.id);
  }
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
    .filter((candidate) => exactIdentityMarker(candidate, state.runId)).length;
  const counts = {
    auth_users: remainingAuth,
    profiles: await exactCount(state.admin, "profiles", "id", [...state.userIds]),
    organizations: await exactCount(state.admin, "organizations", "id", [state.organizationId]),
    memberships: await exactCount(state.admin, "memberships", "organization_id", [state.organizationId]),
    leads: await exactLikeCount(state.admin, "leads", "customer_name", `${state.markerText}%`),
    audit_logs: await exactCount(state.admin, "audit_logs", "actor_id", [...state.userIds]),
    user_session_daily: await exactCount(state.admin, "user_session_daily", "user_id", [...state.userIds]),
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
    await recordIssue(report, "SAM-35", () => runSam35(state));
    await recordIssue(report, "SAM-49", () => runSam49(state));
    await recordIssue(report, "SAM-61", () => runSam61(state));
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
  if (Object.keys(report.results).length !== LINEAR_IDS.length) {
    fail("not every required Linear issue produced a result");
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
