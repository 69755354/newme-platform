#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import * as XLSX from "xlsx";

const STAGING_REF = "bfsiibofuzoglziltgyd";
const PRODUCTION_REF = "vfopmpxlhwzpxqegayew";
const MAX_XLSX_BYTES = 5 * 1024 * 1024;
const MAX_XLSX_ROWS = 2_000;
const expectedRef = process.env.NEWME_STAGING_PROJECT_REF?.trim();
const expectedSha = process.env.SAM70_EXPECTED_RELEASE_SHA?.trim();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const secretKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const baseUrl = process.env.SAM70_BASE_URL?.replace(/\/+$/, "");
const releaseManifestPath = process.env.SAM70_RELEASE_MANIFEST?.trim();
const confirmation = process.env.SAM70_UAT_CONFIRM?.trim();

const runId = randomBytes(8).toString("hex");
const marker = `SAM70-UAT-${runId}-${expectedSha?.slice(0, 8) ?? "unknown"}`;
const emailPrefix = `sam70-${runId}-`;
const organizationId = randomUUID();
const organizationSlug = `sam70-${runId}`;
const createdUsers = new Map();
const createdUserIds = new Set();
const importedLeadIds = new Set();
const fixtureLeadIds = new Set();
const fixtureQuotationIds = new Set();
const cases = [];
let initialBatchId = null;
let idempotentBatchId = null;
let boundariesValidated = false;
let cleanupCounts = {
  leads: null,
  follow_up_logs: null,
  quotations: null,
  profiles: null,
  auth_fixtures: null,
  organizations: null,
  memberships: null,
  user_session_daily: null,
  audit_logs: null,
};

class HttpStatusError extends Error {
  constructor(operation, expected, actual) {
    super(`${operation} expected HTTP ${expected}, received ${actual}`);
    this.name = "HttpStatusError";
  }
}

function errorSummary(error) {
  if (!error) return null;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "unknown failure",
    ...(error instanceof AggregateError
      ? {
          causes: error.errors.map((cause) =>
            cause instanceof Error ? cause.message : "unknown cleanup failure"),
        }
      : {}),
  };
}

function validateBoundaries() {
  for (const [name, value] of Object.entries(process.env)) {
    assert.ok(
      typeof value !== "string" || !value.includes(PRODUCTION_REF),
      `${name} must not reference the production project`,
    );
  }
  assert.equal(expectedRef, STAGING_REF);
  assert.match(expectedSha ?? "", /^[0-9a-f]{40}$/);
  assert.equal(supabaseUrl, `https://${STAGING_REF}.supabase.co`);
  assert.ok(publishableKey, "staging publishable key is required");
  assert.ok(secretKey, "staging service key is required");
  assert.equal(baseUrl, "https://staging.newme.ae");
  assert.equal(releaseManifestPath, "/runner/release/manifest.json");
  assert.equal(confirmation, "SAM70_STAGING_ONLY");
  for (const value of [
    supabaseUrl,
    publishableKey,
    secretKey,
    baseUrl,
    releaseManifestPath,
  ]) {
    assert.ok(!value?.includes(PRODUCTION_REF));
  }
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function supabaseRequest(path, {
  method = "GET",
  body,
  service = false,
  token,
  headers = {},
} = {}) {
  const key = service ? secretKey : publishableKey;
  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new HttpStatusError(`${method} ${path}`, "2xx", response.status);
  }
  return payload;
}

async function restRows(table, query) {
  const payload = await supabaseRequest(
    `/rest/v1/${table}${query ? `?${query}` : ""}`,
    { service: true },
  );
  assert.ok(Array.isArray(payload), `${table} response must be an array`);
  return payload;
}

async function createUser(role, suffix = role) {
  const email = `${emailPrefix}${suffix}@example.test`;
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const created = await supabaseRequest("/auth/v1/admin/users", {
    method: "POST",
    service: true,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `[SAM-70] ${suffix}` },
    },
  });
  const id = created?.id;
  assert.match(id ?? "", /^[0-9a-f-]{36}$/i);
  createdUserIds.add(id);

  await supabaseRequest(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      service: true,
      body: {
        role,
        full_name: `[SAM-70] ${suffix}`,
        email,
        is_active: true,
        force_password_change: false,
      },
    },
  );
  const profiles = await restRows(
    "profiles",
    `select=id,role,is_active,force_password_change&id=eq.${encodeURIComponent(id)}`,
  );
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].role, role);
  assert.equal(profiles[0].is_active, true);
  assert.equal(profiles[0].force_password_change, false);

  await supabaseRequest("/rest/v1/memberships", {
    method: "POST",
    service: true,
    body: {
      organization_id: organizationId,
      user_id: id,
      status: "active",
      accepted_at: new Date().toISOString(),
    },
  });
  const memberships = await restRows(
    "memberships",
    `select=id,status&organization_id=eq.${encodeURIComponent(organizationId)}`
      + `&user_id=eq.${encodeURIComponent(id)}`,
  );
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].status, "active");

  const session = await supabaseRequest("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });
  assert.ok(session?.access_token, `${role} access token is missing`);
  createdUsers.set(suffix, {
    id,
    email,
    password,
    token: session.access_token,
    role,
  });
}

async function appRequest(path, {
  method = "GET",
  token,
  json,
  rawBody,
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "x-newme-organization-id": organizationId,
      ...(json !== undefined || rawBody !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: json !== undefined
      ? JSON.stringify(json)
      : rawBody,
  });
  return {
    response,
    payload: await parseResponse(response),
  };
}

function expectStatus(result, expected, operation) {
  if (result.response.status !== expected) {
    throw new HttpStatusError(operation, expected, result.response.status);
  }
}

async function recordCase(name, operation) {
  await operation();
  cases.push({ name, status: "pass" });
}

async function serviceInsert(table, body) {
  const payload = await supabaseRequest(
    `/rest/v1/${table}?select=*`,
    {
      method: "POST",
      service: true,
      headers: { Prefer: "return=representation" },
      body,
    },
  );
  assert.ok(Array.isArray(payload) && payload.length === 1);
  return payload[0];
}

async function createOrganization() {
  const organization = await serviceInsert("organizations", {
    id: organizationId,
    slug: organizationSlug,
    name: `[SAM-70] ${runId}`,
    industry_key: "real_estate",
    status: "active",
  });
  assert.equal(organization.id, organizationId);
  assert.equal(organization.slug, organizationSlug);
  assert.equal(organization.status, "active");
}

async function testAuthenticationAndImports() {
  const admin = createdUsers.get("admin");
  const boss = createdUsers.get("boss");
  const sales = createdUsers.get("sales");
  assert.ok(admin && boss && sales);

  const sourceRows = [{
    "Client Name": marker,
    "Phone": `+9715${runId.slice(0, 7)}`,
    "Source": "other",
    "Notes": marker,
  }];

  await recordCase("unauthenticated import endpoints return 401", async () => {
    for (const path of [
      "/api/leads/import/preview",
      "/api/leads/import/confirm",
    ]) {
      const result = await appRequest(path, {
        method: "POST",
        json: { rows: sourceRows },
      });
      expectStatus(result, 401, path);
    }
  });

  let previewRows;
  await recordCase("non-management import endpoints return 403", async () => {
    for (const path of [
      "/api/leads/import/preview",
      "/api/leads/import/confirm",
    ]) {
      const forbidden = await appRequest(path, {
        method: "POST",
        token: sales.token,
        json: { rows: sourceRows },
      });
      expectStatus(forbidden, 403, `sales ${path}`);
    }
  });

  await recordCase("admin import succeeds with exact IDs and batch", async () => {
    const preview = await appRequest("/api/leads/import/preview", {
      method: "POST",
      token: admin.token,
      json: { rows: sourceRows },
    });
    expectStatus(preview, 200, "admin preview");
    assert.equal(preview.payload?.total_rows, 1);
    assert.equal(preview.payload?.importable, 1);
    previewRows = preview.payload?.all_rows;
    assert.ok(Array.isArray(previewRows) && previewRows.length === 1);

    const confirm = await appRequest("/api/leads/import/confirm", {
      method: "POST",
      token: admin.token,
      json: { rows: previewRows },
    });
    expectStatus(confirm, 200, "admin confirm");
    assert.equal(confirm.payload?.imported, 1);
    assert.equal(confirm.payload?.failed, 0);
    assert.equal(confirm.payload?.skipped_duplicates, 0);
    assert.match(confirm.payload?.batch_id ?? "", /^[0-9a-f-]{36}$/i);
    assert.ok(
      Array.isArray(confirm.payload?.imported_ids)
        && confirm.payload.imported_ids.length === 1,
    );
    initialBatchId = confirm.payload.batch_id;
    for (const id of confirm.payload.imported_ids) {
      assert.match(id, /^[0-9a-f-]{36}$/i);
      importedLeadIds.add(id);
    }
  });

  await recordCase("boss idempotent replay creates no duplicate", async () => {
    const replay = await appRequest("/api/leads/import/confirm", {
      method: "POST",
      token: boss.token,
      json: { rows: previewRows },
    });
    expectStatus(replay, 200, "boss idempotent confirm");
    assert.equal(replay.payload?.imported, 0);
    assert.equal(replay.payload?.failed, 0);
    assert.equal(replay.payload?.skipped_duplicates, 1);
    assert.deepEqual(replay.payload?.imported_ids, []);
    assert.match(replay.payload?.batch_id ?? "", /^[0-9a-f-]{36}$/i);
    idempotentBatchId = replay.payload.batch_id;
    const residue = await restRows(
      "leads",
      `select=id,import_batch_id,customer_name&customer_name=eq.${encodeURIComponent(marker)}`,
    );
    assert.equal(residue.length, 1);
    assert.equal(residue[0].id, [...importedLeadIds][0]);
    assert.equal(residue[0].import_batch_id, initialBatchId);
  });
}

async function testServerAbuseGuards() {
  const admin = createdUsers.get("admin");
  assert.ok(admin);

  await recordCase("requests over 5 MiB fail closed", async () => {
    const rawBody = `{"rows":[{"notes":"${"x".repeat(MAX_XLSX_BYTES + 1)}"}]}`;
    for (const path of [
      "/api/leads/import/preview",
      "/api/leads/import/confirm",
    ]) {
      const result = await appRequest(path, {
        method: "POST",
        token: admin.token,
        rawBody,
      });
      expectStatus(result, 413, `${path} oversized request`);
    }
  });

  await recordCase("2,001 rows fail closed", async () => {
    const rows = Array.from(
      { length: MAX_XLSX_ROWS + 1 },
      (_, index) => ({ customer_name: `${marker}-${index}` }),
    );
    for (const path of [
      "/api/leads/import/preview",
      "/api/leads/import/confirm",
    ]) {
      const result = await appRequest(path, {
        method: "POST",
        token: admin.token,
        json: { rows },
      });
      expectStatus(result, 413, `${path} row limit`);
    }
  });

  await recordCase("prototype-pollution keys fail closed", async () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const unsafeRow = JSON.parse(`{"${key}":"blocked"}`);
      for (const path of [
        "/api/leads/import/preview",
        "/api/leads/import/confirm",
      ]) {
        const result = await appRequest(path, {
          method: "POST",
          token: admin.token,
          json: { rows: [unsafeRow] },
        });
        expectStatus(result, 413, `${path} ${key}`);
      }
    }
  });
}

async function loginBrowser(page, credentials) {
  await page.goto(`${baseUrl}/login`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  assert.equal(new URL(page.url()).origin, new URL(baseUrl).origin);
  await page.fill('input[type="email"]', credentials.email);
  await page.fill('input[type="password"]', credentials.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(
    (url) => url.origin === new URL(baseUrl).origin && url.pathname !== "/login",
    { timeout: 20_000 },
  );
}

async function openImportDialog(page) {
  await page.goto(`${baseUrl}/leads`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const importButton = page.locator("button:has(svg.lucide-upload)").last();
  await importButton.waitFor({ state: "visible", timeout: 10_000 });
  await importButton.click();
  const input = page.locator('input[type="file"][accept=".xlsx,.xls"]');
  await input.waitFor({ state: "attached", timeout: 5_000 });
  return input;
}

function validWorkbookBytes() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Client Name", "Phone", "Source", "Notes"],
    [marker, `+9715${runId.slice(0, 7)}`, "other", marker],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Leads");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

async function testBrowserXlsxGuards() {
  const admin = createdUsers.get("admin");
  assert.ok(admin);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([{
      name: "newme-organization-id",
      value: organizationId,
      url: baseUrl,
      sameSite: "Strict",
      secure: true,
    }]);
    const page = await context.newPage();
    await loginBrowser(page, admin);

    await recordCase("normal workbook reaches authenticated preview", async () => {
      const input = await openImportDialog(page);
      const previewResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/leads/import/preview",
        { timeout: 15_000 },
      );
      await input.setInputFiles({
        name: `${marker}.xlsx`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: validWorkbookBytes(),
      });
      const response = await previewResponse;
      assert.equal(response.status(), 200);
      assert.equal(new URL(response.url()).origin, new URL(baseUrl).origin);
    });

    await recordCase("corrupt workbook is rejected before preview", async () => {
      const input = await openImportDialog(page);
      let previewRequests = 0;
      const observe = (request) => {
        if (new URL(request.url()).pathname === "/api/leads/import/preview") {
          previewRequests += 1;
        }
      };
      page.on("request", observe);
      await input.setInputFiles({
        name: `${marker}-corrupt.xlsx`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      });
      await page.locator(".text-red-400").first().waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await page.waitForTimeout(300);
      page.off("request", observe);
      assert.equal(previewRequests, 0);
    });

    await recordCase("workbook over 5 MiB is rejected before preview", async () => {
      const input = await openImportDialog(page);
      let previewRequests = 0;
      const observe = (request) => {
        if (new URL(request.url()).pathname === "/api/leads/import/preview") {
          previewRequests += 1;
        }
      };
      page.on("request", observe);
      await input.setInputFiles({
        name: `${marker}-oversized.xlsx`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.alloc(MAX_XLSX_BYTES + 1),
      });
      const error = page.locator(".text-red-400").first();
      await error.waitFor({ state: "visible", timeout: 10_000 });
      assert.match((await error.textContent()) ?? "", /too large/i);
      await page.waitForTimeout(300);
      page.off("request", observe);
      assert.equal(previewRequests, 0);
    });
    await context.close();
  } finally {
    await browser.close();
  }
}

async function testExportOwnership() {
  const admin = createdUsers.get("admin");
  const boss = createdUsers.get("boss");
  const owner = createdUsers.get("sales");
  const outsider = createdUsers.get("sales-outsider");
  assert.ok(admin && boss && owner && outsider);

  const lead = await serviceInsert("leads", {
    organization_id: organizationId,
    customer_name: marker,
    source: "other",
    assigned_to: owner.id,
    notes: marker,
  });
  assert.match(lead?.id ?? "", /^[0-9a-f-]{36}$/i);
  fixtureLeadIds.add(lead.id);

  const quotation = await serviceInsert("quotations", {
    lead_id: lead.id,
    quote_no: marker,
    quotation_type: "standard",
    status: "draft",
    subtotal: 1,
    total_amount: 1,
    valid_until: new Date(Date.now() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10),
    notes: marker,
  });
  assert.match(quotation?.id ?? "", /^[0-9a-f-]{36}$/i);
  fixtureQuotationIds.add(quotation.id);

  await recordCase("quotation export enforces ownership and management access", async () => {
    const path = `/api/quotations/export?id=${encodeURIComponent(quotation.id)}`;
    const unauthenticated = await appRequest(path);
    expectStatus(unauthenticated, 401, "unauthenticated export");

    const hidden = await appRequest(path, { token: outsider.token });
    expectStatus(hidden, 404, "cross-owner export is hidden");

    for (const [label, token] of [
      ["owner", owner.token],
      ["admin", admin.token],
      ["boss", boss.token],
    ]) {
      const result = await appRequest(path, { token });
      expectStatus(result, 200, `${label} export`);
      assert.match(
        result.response.headers.get("content-type") ?? "",
        /^text\/csv/i,
      );
      assert.match(
        result.response.headers.get("content-disposition") ?? "",
        /^attachment;/i,
      );
      assert.equal(typeof result.payload, "string");
      assert.ok(result.payload.includes(marker));
    }
  });
}

async function deleteRows(path) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    method: "DELETE",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      Prefer: "return=representation",
    },
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new HttpStatusError(`DELETE ${path}`, "2xx", response.status);
  }
  assert.ok(Array.isArray(payload));
  return payload;
}

async function listAuthUsers() {
  const payload = await supabaseRequest(
    "/auth/v1/admin/users?page=1&per_page=1000",
    { service: true },
  );
  const users = Array.isArray(payload) ? payload : payload?.users;
  assert.ok(Array.isArray(users));
  assert.ok(users.length < 1000);
  return users;
}

async function cleanupFixtures() {
  const errors = [];
  const capture = async (label, operation) => {
    try {
      return await operation();
    } catch (error) {
      errors.push(
        new Error(`${label}: ${error instanceof Error ? error.message : "failed"}`),
      );
      return null;
    }
  };

  const markerLeads = await capture(
    "discover marker leads",
    () => restRows(
      "leads",
      `select=id,import_batch_id,customer_name&customer_name=eq.${encodeURIComponent(marker)}`,
    ),
  ) ?? [];
  for (const lead of markerLeads) {
    if (typeof lead?.id === "string") {
      if (lead.import_batch_id) importedLeadIds.add(lead.id);
      else fixtureLeadIds.add(lead.id);
    }
  }
  const allLeadIds = new Set([...importedLeadIds, ...fixtureLeadIds]);

  if (allLeadIds.size > 0) {
    const inFilter = [...allLeadIds].join(",");
    await capture(
      "delete dependent follow-up logs",
      () => deleteRows(`/rest/v1/follow_up_logs?lead_id=in.(${inFilter})`),
    );
  }

  const markerQuotes = await capture(
    "discover marker quotations",
    () => restRows(
      "quotations",
      `select=id,quote_no&quote_no=eq.${encodeURIComponent(marker)}`,
    ),
  ) ?? [];
  for (const quote of markerQuotes) {
    if (typeof quote?.id === "string") fixtureQuotationIds.add(quote.id);
  }
  for (const id of fixtureQuotationIds) {
    await capture(
      `delete quotation ${id}`,
      () => deleteRows(
        `/rest/v1/quotations?id=eq.${encodeURIComponent(id)}`
        + `&quote_no=eq.${encodeURIComponent(marker)}`,
      ),
    );
  }

  for (const lead of markerLeads) {
    if (typeof lead?.id !== "string") continue;
    const batchFilter = lead.import_batch_id
      ? `&import_batch_id=eq.${encodeURIComponent(lead.import_batch_id)}`
      : "&import_batch_id=is.null";
    await capture(
      `delete lead ${lead.id}`,
      () => deleteRows(
        `/rest/v1/leads?id=eq.${encodeURIComponent(lead.id)}`
        + `&customer_name=eq.${encodeURIComponent(marker)}${batchFilter}`,
      ),
    );
  }

  const authUsers = await capture("list auth fixtures", listAuthUsers) ?? [];
  for (const user of authUsers) {
    if (
      typeof user?.id === "string"
      && typeof user?.email === "string"
      && user.email.startsWith(emailPrefix)
    ) {
      createdUserIds.add(user.id);
    }
  }
  for (const id of createdUserIds) {
    await capture(
      `delete user_session_daily ${id}`,
      () => deleteRows(`/rest/v1/user_session_daily?user_id=eq.${encodeURIComponent(id)}`),
    );
    await capture(
      `delete audit_logs ${id}`,
      () => deleteRows(`/rest/v1/audit_logs?actor_id=eq.${encodeURIComponent(id)}`),
    );
  }
  await capture(
    "delete organization memberships",
    () => deleteRows(
      `/rest/v1/memberships?organization_id=eq.${encodeURIComponent(organizationId)}`,
    ),
  );
  for (const id of [...createdUserIds].reverse()) {
    await capture(
      `delete auth fixture ${id}`,
      () => supabaseRequest(`/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: "DELETE",
        service: true,
      }),
    );
    await capture(
      `delete profile fixture ${id}`,
      () => deleteRows(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`),
    );
  }
  await capture(
    "delete organization",
    () => deleteRows(`/rest/v1/organizations?id=eq.${encodeURIComponent(organizationId)}`),
  );

  const allLeadIdFilter = [...allLeadIds].join(",");
  const profileIdFilter = [...createdUserIds].join(",");
  const [
    leadResidue,
    logResidue,
    quotationResidue,
    profileResidue,
    remainingAuthUsers,
    organizationResidue,
    membershipResidue,
    sessionResidue,
    auditResidue,
  ] = await Promise.all([
    restRows(
      "leads",
      `select=id&customer_name=eq.${encodeURIComponent(marker)}`,
    ),
    allLeadIdFilter
      ? restRows("follow_up_logs", `select=id&lead_id=in.(${allLeadIdFilter})`)
      : [],
    restRows(
      "quotations",
      `select=id&quote_no=eq.${encodeURIComponent(marker)}`,
    ),
    profileIdFilter
      ? restRows("profiles", `select=id&id=in.(${profileIdFilter})`)
      : [],
    listAuthUsers(),
    restRows(
      "organizations",
      `select=id&id=eq.${encodeURIComponent(organizationId)}`,
    ),
    restRows(
      "memberships",
      `select=id&organization_id=eq.${encodeURIComponent(organizationId)}`,
    ),
    profileIdFilter
      ? restRows("user_session_daily", `select=id&user_id=in.(${profileIdFilter})`)
      : [],
    profileIdFilter
      ? restRows("audit_logs", `select=id&actor_id=in.(${profileIdFilter})`)
      : [],
  ]);
  cleanupCounts = {
    leads: leadResidue.length,
    follow_up_logs: logResidue.length,
    quotations: quotationResidue.length,
    profiles: profileResidue.length,
    auth_fixtures: remainingAuthUsers.filter(
      (user) =>
        typeof user?.email === "string"
      && user.email.startsWith(emailPrefix),
    ).length,
    organizations: organizationResidue.length,
    memberships: membershipResidue.length,
    user_session_daily: sessionResidue.length,
    audit_logs: auditResidue.length,
  };
  for (const [name, count] of Object.entries(cleanupCounts)) {
    if (count !== 0) errors.push(new Error(`${name} cleanup residue=${count}`));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "SAM-70 cleanup verification failed");
  }
}

async function main() {
  let primaryError = null;
  let cleanupError = null;
  let manifest = null;
  try {
    validateBoundaries();
    boundariesValidated = true;
    manifest = JSON.parse(await readFile(releaseManifestPath, "utf8"));
    assert.equal(manifest?.git_sha, expectedSha);
    const health = await fetch(`${baseUrl}/api/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json())?.status, "ok");

    await createOrganization();
    await createUser("admin");
    await createUser("boss");
    await createUser("sales");
    await createUser("sales", "sales-outsider");
    await testAuthenticationAndImports();
    await testServerAbuseGuards();
    await testBrowserXlsxGuards();
    await testExportOwnership();
  } catch (error) {
    primaryError = error;
  } finally {
    if (boundariesValidated) {
      try {
        await cleanupFixtures();
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  const report = {
    ok: !primaryError && !cleanupError,
    linearId: "SAM-70",
    projectRef: STAGING_REF,
    releaseSha: manifest?.git_sha ?? expectedSha ?? null,
    marker,
    initialBatchId,
    idempotentBatchId,
    importedIds: [...importedLeadIds],
    cases,
    cleanup: cleanupError ? "failed" : "verified",
    cleanupCounts,
    primaryError: errorSummary(primaryError),
    cleanupError: errorSummary(cleanupError),
  };
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    linearId: "SAM-70",
    projectRef: STAGING_REF,
    releaseSha: expectedSha ?? null,
    marker,
    initialBatchId,
    idempotentBatchId,
    importedIds: [...importedLeadIds],
    cases,
    cleanup: "failed",
    cleanupCounts,
    primaryError: errorSummary(error),
  }));
  process.exitCode = 1;
});
