#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const CLEANROOM_REF = "bfsiibofuzoglziltgyd";
const PRODUCTION_REF = "vfopmpxlhwzpxqegayew";
const expectedRef = process.env.NEWME_STAGING_PROJECT_REF?.trim();
const expectedSha = process.env.SAM26_EXPECTED_RELEASE_SHA?.trim();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const secretKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const baseUrl = (
  process.env.SAM26_BASE_URL || "http://127.0.0.1:3101"
).replace(/\/+$/, "");
const chromiumExecutable = process.env.SAM26_CHROMIUM_EXECUTABLE?.trim();
const releaseManifestPath = process.env.SAM26_RELEASE_MANIFEST?.trim();
const resolveStagingLocally = process.env.SAM26_RESOLVE_STAGING_LOCALLY === "1";

const ROLES = ["admin", "boss", "operator", "sales", "finance", "designer"];
const MANAGEMENT_ROLES = new Set(["admin", "boss", "operator"]);
const PROTECTED_ROUTES = new Map([
  ["/team", new Set(["admin", "boss"])],
  ["/settings", new Set(["admin", "boss", "operator"])],
  ["/pipeline", new Set(["admin", "boss", "operator", "sales"])],
]);
const API_ROLE_MATRIX = new Map([
  ["/api/workbench", new Set(["sales"])],
  ["/api/pipeline/list", new Set(["admin", "boss", "operator", "sales"])],
  ["/api/dashboard/summary", new Set(["admin", "boss", "operator", "sales"])],
  ["/api/analytics/summary", new Set(["admin", "boss", "operator", "sales"])],
]);
const MANAGEMENT_NAV = [
  "/dashboard",
  "/leads",
  "/quotes",
  "/contracts",
  "/pipeline",
  "/analytics",
  "/ads",
  "/products",
  "/team",
  "/projects",
  "/settings",
];
const SALES_NAV = [
  "/workbench",
  "/leads",
  "/quotes",
  "/contracts",
  "/payments",
  "/pipeline",
  "/analytics",
  "/products",
];
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

function validateBoundaries() {
  for (const [name, value] of Object.entries(process.env)) {
    assert.ok(
      typeof value !== "string" || !value.includes(PRODUCTION_REF),
      `${name} must not reference the production project`,
    );
  }

  assert.equal(
    expectedRef,
    CLEANROOM_REF,
    "NEWME_STAGING_PROJECT_REF must equal the cleanroom-2 ref",
  );
  assert.match(
    expectedSha ?? "",
    /^[0-9a-f]{40}$/,
    "SAM26_EXPECTED_RELEASE_SHA must be an exact 40-character commit SHA",
  );
  assert.equal(
    releaseManifestPath,
    "/runner/release/manifest.json",
    "SAM26_RELEASE_MANIFEST must use the fixed read-only container path",
  );

  assert.ok(supabaseUrl, "NEXT_PUBLIC_SUPABASE_URL is required");
  const dbUrl = new URL(supabaseUrl);
  assert.equal(dbUrl.protocol, "https:", "Supabase URL must use HTTPS");
  assert.equal(
    dbUrl.hostname,
    `${CLEANROOM_REF}.supabase.co`,
    "Supabase URL must point to cleanroom-2",
  );
  assert.equal(dbUrl.pathname, "/", "Supabase URL must not contain a path");
  assert.ok(
    publishableKey && secretKey?.startsWith("sb_secret_"),
    "cleanroom publishable and secret keys are required",
  );
  assert.notEqual(
    publishableKey,
    secretKey,
    "publishable and secret keys must be different",
  );

  const isApprovedAppUrl = (candidate) => {
    const appUrl = new URL(candidate);
    const isLoopback =
      appUrl.protocol === "http:"
      && ["127.0.0.1", "localhost"].includes(appUrl.hostname)
      && appUrl.port === "3101";
    const isStagingHost =
      appUrl.protocol === "https:"
      && appUrl.hostname === "staging.newme.ae"
      && !appUrl.port;
    assert.ok(
      isLoopback || isStagingHost,
      "SAM26 URLs must be staging.newme.ae or loopback port 3101",
    );
    assert.equal(appUrl.pathname, "/", "SAM26 URLs must not contain a path");
    assert.equal(appUrl.search, "", "SAM26 URLs must not contain a query");
    assert.equal(appUrl.hash, "", "SAM26 URLs must not contain a fragment");
    assert.equal(appUrl.username, "", "SAM26 URLs must not contain credentials");
    assert.equal(appUrl.password, "", "SAM26 URLs must not contain credentials");
    return { isLoopback, isStagingHost };
  };
  const appBoundary = isApprovedAppUrl(baseUrl);
  assert.ok(
    !resolveStagingLocally || appBoundary.isStagingHost,
    "local staging resolution requires https://staging.newme.ae",
  );
}

const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const emailPrefix = `sam26-${runId}-`;
const createdUserIds = [];
const createdEmails = new Set();
const testUsers = new Map();
const checks = [];
let baseline = null;

class HttpError extends Error {
  constructor(label, status) {
    super(`${label}: HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

function record(scope, role, viewport, ok, detail) {
  checks.push({
    scope,
    role,
    viewport,
    status: ok ? "pass" : "fail",
    detail,
  });
}

function errorSummary(error) {
  if (!error) return null;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "unknown error",
    ...(error instanceof AggregateError
      ? {
          causes: error.errors.map((cause) =>
            cause instanceof Error ? cause.message : "unknown error"),
        }
      : {}),
  };
}

async function apiRequest(path, {
  method = "GET",
  body,
  service = false,
  token,
} = {}) {
  const key = service ? secretKey : publishableKey;
  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    throw new HttpError(`${method} ${path}`, response.status);
  }
  return payload;
}

async function restRows(table, query) {
  const suffix = query ? `?${query}` : "";
  const rows = await apiRequest(`/rest/v1/${table}${suffix}`, { service: true });
  assert.ok(Array.isArray(rows), `${table} must return an array`);
  return rows;
}

async function authUserCount() {
  return (await listAuthUsers()).length;
}

async function listAuthUsers() {
  const payload = await apiRequest(
    "/auth/v1/admin/users?page=1&per_page=1000",
    { service: true },
  );
  const users = Array.isArray(payload) ? payload : payload?.users;
  assert.ok(Array.isArray(users), "Auth admin user list is unavailable");
  assert.ok(users.length < 1000, "Auth user baseline exceeds the safe page size");
  return users;
}

async function snapshotBaseline() {
  const [authUsers, profiles, leads] = await Promise.all([
    authUserCount(),
    restRows("profiles", "select=id"),
    restRows("leads", "select=id"),
  ]);
  return {
    auth_users: authUsers,
    profiles: profiles.length,
    leads: leads.length,
  };
}

async function createUser(role) {
  const email = `${emailPrefix}${role}@example.test`;
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  createdEmails.add(email);
  const created = await apiRequest("/auth/v1/admin/users", {
    method: "POST",
    service: true,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `[SAM-26] ${role}` },
    },
  });
  const createdId = created?.id;
  if (typeof createdId === "string") createdUserIds.push(createdId);
  assert.match(createdId ?? "", /^[0-9a-f-]{36}$/i);

  await apiRequest(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(createdId)}`,
    {
      method: "PATCH",
      service: true,
      body: {
        role,
        full_name: `[SAM-26] ${role}`,
        email,
        is_active: true,
        force_password_change: false,
      },
    },
  );
  const profiles = await restRows(
    "profiles",
    `select=id,role,is_active,force_password_change&id=eq.${encodeURIComponent(createdId)}`,
  );
  assert.equal(profiles.length, 1, `${role} profile must exist`);
  assert.equal(profiles[0].role, role, `${role} profile role mismatch`);
  assert.equal(profiles[0].is_active, true, `${role} profile must be active`);
  assert.equal(
    profiles[0].force_password_change,
    false,
    `${role} profile must not require a password reset`,
  );
  testUsers.set(role, { email, password });
}

async function deleteWhere(table, column, value) {
  await apiRequest(
    `/rest/v1/${table}?${column}=eq.${encodeURIComponent(value)}`,
    { method: "DELETE", service: true },
  );
}

async function cleanup() {
  const cleanupErrors = [];
  const cleanupIds = new Set(createdUserIds);
  const capture = async (label, operation) => {
    try {
      return await operation();
    } catch (error) {
      cleanupErrors.push(
        new Error(`${label}: ${error instanceof Error ? error.message : "unknown error"}`),
      );
      return null;
    }
  };

  const authUsers = await capture("discover auth users", listAuthUsers);
  for (const user of authUsers ?? []) {
    if (
      typeof user?.email === "string"
      && (user.email.startsWith(emailPrefix) || createdEmails.has(user.email))
      && typeof user?.id === "string"
    ) {
      cleanupIds.add(user.id);
    }
  }

  const prefixProfiles = await capture(
    "discover prefixed profiles",
    () => restRows(
      "profiles",
      `select=id,email&email=like.${encodeURIComponent(`${emailPrefix}*`)}`,
    ),
  );
  for (const profile of prefixProfiles ?? []) {
    if (typeof profile?.id === "string") cleanupIds.add(profile.id);
  }

  const dependentTables = [
    ["user_session_daily", "user_id"],
    ["audit_logs", "actor_id"],
  ];
  for (const id of cleanupIds) {
    for (const [table, column] of dependentTables) {
      await capture(
        `delete ${table}.${column}`,
        () => deleteWhere(table, column, id),
      );
    }
  }
  for (const id of [...cleanupIds].reverse()) {
    await capture(
      "delete auth user",
      () => apiRequest(`/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: "DELETE",
        service: true,
      }),
    );
    await capture("delete profile", () => deleteWhere("profiles", "id", id));
  }

  const remainingAuthUsers = await capture("verify auth users", listAuthUsers);
  if (remainingAuthUsers) {
    const residue = remainingAuthUsers.filter((user) =>
      (typeof user?.id === "string" && cleanupIds.has(user.id))
      || (
        typeof user?.email === "string"
        && (user.email.startsWith(emailPrefix) || createdEmails.has(user.email))
      ));
    if (residue.length > 0) {
      cleanupErrors.push(new Error("auth user residue remains for this SAM-26 run"));
    }
  }

  const remainingProfiles = await capture(
    "verify prefixed profiles",
    () => restRows(
      "profiles",
      `select=id,email&email=like.${encodeURIComponent(`${emailPrefix}*`)}`,
    ),
  );
  if (remainingProfiles && remainingProfiles.length > 0) {
    cleanupErrors.push(new Error("profile residue remains for this SAM-26 run"));
  }

  for (const id of cleanupIds) {
    for (const [table, column] of dependentTables) {
      const residue = await capture(
        `verify ${table}.${column}`,
        () => restRows(
          table,
          `select=${column}&${column}=eq.${encodeURIComponent(id)}`,
        ),
      );
      if (residue && residue.length > 0) {
        cleanupErrors.push(
          new Error(`${table}.${column} residue remains for this SAM-26 run`),
        );
      }
    }
    const profiles = await capture(
      "verify profile id",
      () => restRows("profiles", `select=id&id=eq.${encodeURIComponent(id)}`),
    );
    if (profiles && profiles.length > 0) {
      cleanupErrors.push(new Error("profile id residue remains for this SAM-26 run"));
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "SAM-26 cleanup verification failed");
  }
}

async function verifyBaselineRestored() {
  let latest = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    latest = await snapshotBaseline();
    if (JSON.stringify(latest) === JSON.stringify(baseline)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.deepEqual(latest, baseline, "cleanroom baseline was not restored");
  return latest;
}

function assertBrowserOrigin(url) {
  const current = new URL(url);
  const expected = new URL(baseUrl);
  assert.equal(
    current.origin,
    expected.origin,
    "browser left the approved staging origin",
  );
}

async function waitForSettledPath(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
  await page.waitForTimeout(250);
  assertBrowserOrigin(page.url());
  return new URL(page.url()).pathname;
}

async function navigateForRoleCheck(page, route, shouldAllow) {
  await page.goto(`${baseUrl}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  if (!shouldAllow) {
    await page.waitForURL(
      (url) => url.origin === new URL(baseUrl).origin && url.pathname !== route,
      { timeout: 5_000 },
    ).catch(() => {});
  }
  return waitForSettledPath(page);
}

async function login(page, role) {
  const credentials = testUsers.get(role);
  assert.ok(credentials, `missing ${role} credentials`);
  const authFlow = [];
  const captureAuthStatus = (response) => {
    const url = response.url();
    if (url.includes("/auth/v1/token")) {
      authFlow.push(`token:${response.status()}`);
    } else if (url.includes("/api/auth/session")) {
      authFlow.push(`session:${response.status()}`);
    } else if (url.includes("/api/auth/me")) {
      authFlow.push(`me:${response.status()}`);
    }
  };
  page.on("response", captureAuthStatus);
  await page.goto(`${baseUrl}/login`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  assertBrowserOrigin(page.url());
  await page.fill('input[type="email"]', credentials.email);
  await page.fill('input[type="password"]', credentials.password);
  await page.click('button[type="submit"]');
  try {
    await page.waitForURL(
      (url) => url.origin === new URL(baseUrl).origin && url.pathname !== "/login",
      { timeout: 20_000 },
    );
  } catch {
    const visibleError = await page.locator(".text-red-400").first().textContent()
      .catch(() => null);
    throw new Error(
      `login did not leave /login (${authFlow.join(",") || "no auth responses"}`
      + `${visibleError ? `; page error: ${visibleError.trim()}` : ""})`,
    );
  } finally {
    page.off("response", captureAuthStatus);
  }
  await waitForSettledPath(page);
}

async function openMobileNav(page) {
  const toggle = page.locator("button.lg\\:hidden").first();
  await toggle.waitFor({ state: "visible", timeout: 5_000 });
  await toggle.click();
  await page.locator("aside").waitFor({ state: "visible", timeout: 5_000 });
}

async function visibleNavHrefs(page) {
  return page.locator("aside nav a").evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")).filter(Boolean),
  );
}

function checkMenu(role, viewport, hrefs) {
  const unique = [...new Set(hrefs)].sort();
  const expected =
    MANAGEMENT_ROLES.has(role)
      ? [...MANAGEMENT_NAV].sort()
      : role === "sales"
        ? [...SALES_NAV].sort()
        : null;

  if (expected) {
    record(
      "menu",
      role,
      viewport,
      JSON.stringify(unique) === JSON.stringify(expected),
      "role navigation matches its declared matrix",
    );
  }

  const hasSalesWorkbench = unique.includes("/workbench");
  record(
    "menu",
    role,
    viewport,
    role === "sales" ? hasSalesWorkbench : !hasSalesWorkbench,
    role === "sales"
      ? "sales workspace is visible"
      : "sales workspace is hidden",
  );
}

async function checkUsersApi(page, role, viewport) {
  const responseStatus = await page.evaluate(async () => {
    const response = await fetch("/api/users", { cache: "no-store" });
    return response.status;
  });
  const expectedStatus = ["admin", "boss"].includes(role) ? 200 : 403;
  record(
    "api/users",
    role,
    viewport,
    responseStatus === expectedStatus,
    `expected HTTP ${expectedStatus}, received HTTP ${responseStatus}`,
  );
}

async function checkApiRoleBoundaries(page, role) {
  for (const [route, allowedRoles] of API_ROLE_MATRIX) {
    const responseStatus = await page.evaluate(async (path) => {
      const response = await fetch(path, { cache: "no-store" });
      return response.status;
    }, route);
    const expectedStatus = allowedRoles.has(role) ? 200 : 403;
    record(
      "api/role-boundary",
      role,
      "desktop",
      responseStatus === expectedStatus,
      `${route}: expected HTTP ${expectedStatus}, received HTTP ${responseStatus}`,
    );
  }
}

async function checkProtectedRedirects(page, role, viewport) {
  for (const [route, allowedRoles] of PROTECTED_ROUTES) {
    const shouldAllow = allowedRoles.has(role);
    const finalPath = await navigateForRoleCheck(page, route, shouldAllow);
    const ok = shouldAllow ? finalPath === route : finalPath !== route;
    record(
      "route",
      role,
      viewport,
      ok,
      shouldAllow
        ? `${route} remains accessible`
        : `${route} redirects away for a non-management role`,
    );
  }
}

async function runRole(browser, role) {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await context.newPage();
  try {
    await login(page, role);
    const desktopHrefs = await visibleNavHrefs(page);
    checkMenu(role, "desktop", desktopHrefs);
    await checkUsersApi(page, role, "desktop");
    await checkApiRoleBoundaries(page, role);
    await checkProtectedRedirects(page, role, "desktop");

    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto(`${baseUrl}${MANAGEMENT_ROLES.has(role) ? "/dashboard" : "/workbench"}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await waitForSettledPath(page);
    await openMobileNav(page);
    const mobileHrefs = await visibleNavHrefs(page);
    checkMenu(role, "mobile", mobileHrefs);
    await checkUsersApi(page, role, "mobile");

    const representativeRoute = "/team";
    const mobileRouteAllowed = PROTECTED_ROUTES.get(representativeRoute).has(role);
    const finalPath = await navigateForRoleCheck(
      page,
      representativeRoute,
      mobileRouteAllowed,
    );
    record(
      "route",
      role,
      "mobile",
      mobileRouteAllowed
        ? finalPath === representativeRoute
        : finalPath !== representativeRoute,
      mobileRouteAllowed
        ? `${representativeRoute} remains accessible`
        : `${representativeRoute} redirects away for a non-management role`,
    );
  } catch (error) {
    record(
      "role-run",
      role,
      "both",
      false,
      error instanceof Error ? error.message : "unknown role-run failure",
    );
  } finally {
    await context.close();
  }
}

async function main() {
  let browser = null;
  let primaryError = null;
  let cleanupError = null;
  let healthBody = null;
  let releaseManifest = null;
  try {
    validateBoundaries();
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200, "staging health endpoint must return HTTP 200");
    healthBody = await health.json();
    assert.equal(healthBody?.status, "ok", "staging health must report ok");
    releaseManifest = JSON.parse(
      await readFile(releaseManifestPath, "utf8"),
    );
    assert.equal(
      releaseManifest?.git_sha,
      expectedSha,
      "staging release manifest does not match SAM26_EXPECTED_RELEASE_SHA",
    );

    baseline = await snapshotBaseline();
    for (const role of ROLES) await createUser(role);

    browser = await chromium.launch({
      headless: true,
      ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
      ...(resolveStagingLocally
        ? { args: ["--host-resolver-rules=MAP staging.newme.ae 127.0.0.1"] }
        : {}),
    });
    for (const role of ROLES) await runRole(browser, role);
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupPhaseErrors = [];
    try {
      await browser?.close();
    } catch (error) {
      cleanupPhaseErrors.push(
        new Error(
          `close browser: ${error instanceof Error ? error.message : "unknown error"}`,
        ),
      );
    }
    if (createdEmails.size > 0 || createdUserIds.length > 0) {
      try {
        await cleanup();
      } catch (error) {
        cleanupPhaseErrors.push(error);
      }
    }
    if (baseline) {
      try {
        await verifyBaselineRestored();
      } catch (error) {
        cleanupPhaseErrors.push(error);
      }
    }
    if (cleanupPhaseErrors.length > 0) {
      cleanupError = new AggregateError(
        cleanupPhaseErrors,
        "SAM-26 cleanup phase failed",
      );
    }
  }

  const failures = checks.filter((check) => check.status === "fail");
  const report = {
    ok: failures.length === 0 && !primaryError && !cleanupError,
    project_ref: CLEANROOM_REF,
    expected_release_sha: expectedSha,
    runtime_version: releaseManifest?.git_sha ?? null,
    run_id: runId,
    checks,
    cleanup: cleanupError ? "failed" : "verified",
    primary_error: errorSummary(primaryError),
    cleanup_error: errorSummary(cleanupError),
    failure_count:
      failures.length + (primaryError ? 1 : 0) + (cleanupError ? 1 : 0),
  };
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    project_ref: CLEANROOM_REF,
    run_id: runId,
    error: error instanceof Error ? error.message : "unknown failure",
    cleanup: baseline ? "attempted" : "not-required",
  }));
  process.exitCode = 1;
});

