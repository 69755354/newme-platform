#!/usr/bin/env node
/**
 * SAM-66 local-only authenticated regression gate.
 *
 * This intentionally has no dotenv loader: operators must supply the local
 * Supabase keys through their process environment, keeping credentials out of
 * the repository, artifacts, and console output.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const RUNS = Number.parseInt(process.env.SAM66_RUNS ?? "2", 10);
const BASE_URL = (process.env.SAM66_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ACTORS = ["boss", "admin", "operator", "sales", "sales-other"];
const REPORT = { ok: false, ui: "not-attempted", runs: [] };
let chromiumInstallAttempted = false;
const SESSION_COOKIES = new Map();

function fail(message) {
  throw new Error(`SAM66_FAIL_CLOSED: ${message}`);
}

function assertLoopback(value, label) {
  let target;
  try {
    target = new URL(value);
  } catch {
    fail(`${label} is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', 'localhost'].includes(target.hostname)) {
    fail(`${label} must use a localhost or 127.0.0.1 endpoint`);
  }
  if (target.username || target.password || target.search || target.hash) {
    fail(`${label} must not include credentials, query, or fragment`);
  }
  return target;
}

function validateEnvironment() {
  assert.ok(Number.isInteger(RUNS) && RUNS === 2, "SAM66_RUNS must be exactly 2 to prove repeatability");
  assert.ok(SUPABASE_URL && ANON_KEY && SERVICE_KEY, "local Supabase URL, anon key, and service key are required");
  for (const [name, value] of Object.entries({
    SAM66_BASE_URL: BASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    ...(process.env.NEXT_PUBLIC_SITE_URL ? { NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL } : {}),
  })) assertLoopback(value, name);
  assert.notEqual(ANON_KEY, SERVICE_KEY, "anon and service keys must differ");
}

function safeText(value) {
  return typeof value === "string" ? value.slice(0, 160).replace(/[\r\n]+/g, " ") : "";
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return safeText(text); }
}

async function api(token, path, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(SESSION_COOKIES.get(token) ? { Cookie: SESSION_COOKIES.get(token) } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await parseResponse(response);
  if (response.status >= 500) fail(`${method} ${path} returned HTTP ${response.status}: ${safeText(JSON.stringify(payload))}`);
  return { status: response.status, payload };
}

function expectStatus(label, response, status, requiredText) {
  assert.equal(response.status, status, `${label} returned unexpected HTTP ${response.status}`);
  if (requiredText) assert.match(JSON.stringify(response.payload), requiredText, `${label} response body mismatch`);
}

async function listAuthUsers(admin) {
  const users = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail("cannot enumerate local auth users for marker-scoped cleanup");
    users.push(...(data.users ?? []));
    if ((data.users ?? []).length < 200) return users;
  }
  fail("local auth user enumeration exceeded the safe page limit");
}

function exactMarker(user, marker) {
  const meta = user.app_metadata ?? {};
  return meta.fixture_scope === "sam66-local-auth-regression" && meta.fixture_kind === "auth-gate" && meta.run_id === marker;
}

function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function createActor(admin, marker, actor, users) {
  const email = `sam66-${marker}-${actor}@invalid.test`;
  const password = `${randomBytes(32).toString("base64url")}Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { fixture_scope: "sam66-local-auth-regression", fixture_kind: "auth-gate", run_id: marker, actor },
    user_metadata: { full_name: `[SAM-66 ${marker}] ${actor}` },
  });
  if (error || !data.user || !exactMarker(data.user, marker)) fail("local auth user creation did not retain its exact marker");
  const { error: profileError } = await admin.from("profiles").update({
    role: "sales-other" === actor ? "sales" : actor,
    full_name: `[SAM-66 ${marker}] ${actor}`,
    email,
    is_active: true,
    force_password_change: false,
  }).eq("id", data.user.id);
  if (profileError) fail("local profile provisioning failed");

  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !signedIn.session || signedIn.user?.id !== data.user.id) fail("password authentication did not produce the created local user");
  const { data: refreshed, error: refreshError } = await client.auth.refreshSession({ refresh_token: signedIn.session.refresh_token });
  if (refreshError || !refreshed.session || refreshed.user?.id !== data.user.id) fail("refresh authentication did not retain the local user");
  const sessionResponse = await fetch(`${BASE_URL}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: refreshed.session.access_token,
      refresh_token: refreshed.session.refresh_token,
      expires_in: refreshed.session.expires_in,
    }),
  });
  if (sessionResponse.status >= 500 || !sessionResponse.ok) fail("same-origin session bootstrap failed");
  const setCookies = typeof sessionResponse.headers.getSetCookie === "function"
    ? sessionResponse.headers.getSetCookie()
    : [sessionResponse.headers.get("set-cookie") ?? ""];
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
  if (!cookie) fail("same-origin session bootstrap did not return cookies");
  SESSION_COOKIES.set(refreshed.session.access_token, cookie);
  users.set(actor, { id: data.user.id, email, password, token: refreshed.session.access_token });
}

async function createLeadFor(admin, marker, user, suffix, leadIds) {
  const { data, error } = await admin.from("leads").insert({
    customer_name: `[SAM-66 ${marker}] ${suffix}`,
    source: "other",
    stage: "new",
    assigned_to: user.id,
    created_by: user.id,
  }).select("id,assigned_to,stage,final_status").single();
  if (error || !data?.id || data.assigned_to !== user.id || data.stage !== "new") fail("marked lead creation/readback failed");
  leadIds.push(data.id);
  return data;
}

async function getContactId(response) {
  const candidate = response.payload?.contact?.contact_id ?? response.payload?.contact?.id ?? response.payload?.contact_id;
  assert.match(candidate ?? "", /^[0-9a-f-]{36}$/i, "contact response did not include an id");
  return candidate;
}

async function runApiFlows(marker, users, leadIds, checks) {
  for (const actor of ACTORS) {
    const me = await api(users.get(actor).token, "/api/auth/me");
    expectStatus(`${actor} authenticated /api/auth/me`, me, 200);
    assert.equal(me.payload?.role, actor === "sales-other" ? "sales" : actor, `${actor} profile role readback mismatch`);
  }
  for (const actor of ["boss", "admin", "operator", "sales"]) {
    const dashboard = await api(users.get(actor).token, "/api/dashboard/summary");
    expectStatus(`${actor} dashboard`, dashboard, 200);
  }
  const negativeDashboard = await api(users.get("sales-other").token, "/api/dashboard/summary");
  expectStatus("negative dashboard role", negativeDashboard, 200);

  const primary = await createLeadFor(serviceClient(), marker, users.get("sales"), "primary", leadIds);
  const crossOwner = await createLeadFor(serviceClient(), marker, users.get("sales-other"), "cross-owner", leadIds);
  const lossLead = await createLeadFor(serviceClient(), marker, users.get("sales"), "lost", leadIds);
  const salesList = await api(users.get("sales").token, "/api/leads/list");
  expectStatus("sales lead read", salesList, 200);
  assert.ok(salesList.payload?.leads?.some((lead) => lead.id === primary.id), "sales lead list omitted its owned marked lead");
  assert.ok(!salesList.payload?.leads?.some((lead) => lead.id === crossOwner.id), "sales lead list exposed a cross-owner marked lead");

  const crossOwnerDenied = await api(users.get("sales").token, `/api/leads/${crossOwner.id}/notes`, {
    method: "POST", body: { note: `[SAM-66 ${marker}] forbidden`, idempotencyKey: randomUUID() },
  });
  expectStatus("cross-owner note denial", crossOwnerDenied, 403, /FORBIDDEN|forbidden/i);

  const contactOne = await api(users.get("sales").token, `/api/leads/${primary.id}/contacts`, {
    method: "POST", body: { contact_method: "phone", contact_time: new Date(Date.now() - 5_000).toISOString(), contact_result: `[SAM-66 ${marker}] reached`, summary: `[SAM-66 ${marker}] first contact` },
  });
  expectStatus("primary contact create", contactOne, 200, /success/i);
  await getContactId(contactOne);
  const quality = await api(users.get("sales").token, `/api/leads/${primary.id}/quality`, { method: "POST", body: { quality: "good" } });
  expectStatus("primary quality update", quality, 200, /good/);
  const firstContact = await api(users.get("sales").token, `/api/leads/${primary.id}/milestone`, {
    method: "POST", body: { milestoneKey: "first_contact", notes: `[SAM-66 ${marker}] explicit confirmation` },
  });
  expectStatus("First Contact", firstContact, 200, /success/i);

  const contactTwo = await api(users.get("sales").token, `/api/leads/${primary.id}/contacts`, {
    method: "POST", body: { contact_method: "whatsapp", contact_time: new Date(Date.now() - 3_000).toISOString(), contact_result: `[SAM-66 ${marker}] follow-up`, summary: `[SAM-66 ${marker}] editable` },
  });
  expectStatus("timeline contact create", contactTwo, 200, /success/i);
  const contactId = await getContactId(contactTwo);
  const edited = await api(users.get("sales").token, `/api/leads/${primary.id}/contacts/${contactId}`, {
    method: "PATCH", body: { contact_method: "whatsapp", contact_time: new Date(Date.now() - 2_000).toISOString(), contact_result: `[SAM-66 ${marker}] edited`, summary: `[SAM-66 ${marker}] edited timeline` },
  });
  expectStatus("timeline contact edit", edited, 200, /edited timeline/);
  const timelineAfterEdit = await api(users.get("sales").token, `/api/leads/${primary.id}/timeline?limit=100`);
  expectStatus("timeline edit readback", timelineAfterEdit, 200, /edited timeline/);
  const deleted = await api(users.get("sales").token, `/api/leads/${primary.id}/contacts/${contactId}`, { method: "DELETE" });
  expectStatus("timeline contact delete", deleted, 200, /success/i);
  const timelineAfterDelete = await api(users.get("sales").token, `/api/leads/${primary.id}/timeline?limit=100`);
  expectStatus("timeline delete readback", timelineAfterDelete, 200);
  assert.doesNotMatch(JSON.stringify(timelineAfterDelete.payload), new RegExp(contactId, "i"), "deleted contact remained in timeline readback");

  for (const [lead, terminal] of [[primary, "won"], [lossLead, "lost"]]) {
    if (lead.id === lossLead.id) {
      const contact = await api(users.get("sales").token, `/api/leads/${lead.id}/contacts`, {
        method: "POST", body: { contact_method: "phone", contact_time: new Date(Date.now() - 4_000).toISOString(), contact_result: `[SAM-66 ${marker}] loss contact`, summary: `[SAM-66 ${marker}] loss` },
      });
      expectStatus("lost lead contact", contact, 200, /success/i);
      const qualityLoss = await api(users.get("sales").token, `/api/leads/${lead.id}/quality`, { method: "POST", body: { quality: "normal" } });
      expectStatus("lost lead quality", qualityLoss, 200, /normal/);
    }
    const transition = await api(users.get("sales").token, `/api/leads/${lead.id}/stage`, {
      method: "PATCH", body: { stage: terminal, note: `[SAM-66 ${marker}] ${terminal}`, idempotencyKey: randomUUID() },
    });
    expectStatus(`${terminal} stage transition`, transition, 200, new RegExp(terminal));
  }
  const readback = await serviceClient().from("leads").select("id,stage,final_status").in("id", [primary.id, lossLead.id]);
  if (readback.error || readback.data?.length !== 2) fail("terminal lead readback failed");
  for (const row of readback.data) assert.equal(row.stage, row.final_status, "terminal stage and status diverged");
  checks.push("auth-refresh", "dashboard", "lead-create-read-update", "first-contact", "timeline-edit-delete-readback", "won-lost", "cross-owner-denial");
}

async function runUi(users) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/executable|browserType\.launch|headless_shell|chromium/i.test(message)) throw error;
    if (chromiumInstallAttempted) return false;
    chromiumInstallAttempted = true;
    try {
      execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium"], { stdio: "ignore" });
      browser = await chromium.launch({ headless: true });
    } catch {
      return false;
    }
  }
  try {
    for (const actor of ["boss", "admin", "operator", "sales"]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(safeText(message.text())); });
      await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.fill('input[type="email"]', users.get(actor).email);
      await page.fill('input[type="password"]', users.get(actor).password);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => url.origin === new URL(BASE_URL).origin && url.pathname !== "/login", { timeout: 20_000 });
      const me = await page.evaluate(async () => ({ status: (await fetch("/api/auth/me", { cache: "no-store" })).status }));
      assert.equal(me.status, 200, `${actor} browser session is not authenticated`);
      assert.equal(consoleErrors.length, 0, `${actor} browser emitted console errors`);
      await context.close();
    }
    return true;
  } finally {
    await browser.close();
  }
}

async function cleanup(marker, userIds, leadIds) {
  const admin = serviceClient();
  const capture = async (label, operation) => {
    const { error } = await operation;
    if (error) fail(`marker-scoped cleanup failed for ${label} (${error.code ?? error.status ?? "unknown"})`);
  };
  for (const leadId of leadIds) {
    for (const [table, column] of [
      ["notifications", "related_id"], ["business_events", "lead_id"], ["activities", "lead_id"],
      ["tasks", "lead_id"], ["follow_up_logs", "lead_id"],
      ["lead_mutation_requests", "lead_id"], ["audit_logs", "target_id"],
      ["transfer_history", "lead_id"], ["lead_deletion_requests", "deleted_lead_id"],
    ]) {
      await capture(`${table}.${column}`, admin.from(table).delete().eq(column, leadId));
    }
    await capture("leads.id", admin.from("leads").delete().eq("id", leadId));
  }
  const matchingUsers = (await listAuthUsers(admin)).filter((user) => exactMarker(user, marker));
  for (const user of matchingUsers) {
    await capture("user_session_daily.user_id", admin.from("user_session_daily").delete().eq("user_id", user.id));
    await capture("audit_logs.actor_id", admin.from("audit_logs").delete().eq("actor_id", user.id));
    const { error } = await admin.auth.admin.deleteUser(user.id, false);
    if (error) fail(`marked auth identity cleanup failed (status ${error.status ?? "unknown"}: ${safeText(error.message)})`);
  }
  const usersLeft = (await listAuthUsers(admin)).filter((user) => exactMarker(user, marker));
  const markerText = `[SAM-66 ${marker}]`;
  const residues = {
    auth: usersLeft.length,
    profiles: (await admin.from("profiles").select("id", { count: "exact", head: true }).like("full_name", `${markerText}%`)).count ?? -1,
    leads: (await admin.from("leads").select("id", { count: "exact", head: true }).like("customer_name", `${markerText}%`)).count ?? -1,
    activities: (await admin.from("activities").select("id", { count: "exact", head: true }).like("content", `${markerText}%`)).count ?? -1,
    tasks: (await admin.from("tasks").select("id", { count: "exact", head: true }).like("title", `${markerText}%`)).count ?? -1,
    business_events: (await admin.from("business_events").select("id", { count: "exact", head: true }).like("description", `${markerText}%`)).count ?? -1,
    notifications: leadIds.length === 0 ? 0 : (await admin.from("notifications").select("id", { count: "exact", head: true }).in("related_id", leadIds)).count ?? -1,
  };
  if (Object.values(residues).some((count) => count !== 0)) fail("marker residue remains after cleanup");
}

async function recoverInterruptedLocalRuns() {
  if (process.env.SAM66_RECOVER_ORPHANS !== "1") return;
  const admin = serviceClient();
  const scoped = (await listAuthUsers(admin)).filter((user) =>
    user.app_metadata?.fixture_scope === "sam66-local-auth-regression"
    && user.app_metadata?.fixture_kind === "auth-gate",
  );
  const markers = [...new Set(scoped.map((user) => user.app_metadata?.run_id))];
  if (markers.some((marker) => typeof marker !== "string" || !marker)) fail("refusing recovery for a malformed local SAM-66 marker");
  for (const marker of markers) {
    const users = scoped.filter((user) => exactMarker(user, marker));
    if (users.length !== ACTORS.length) fail("refusing recovery for an incomplete local SAM-66 actor set");
    const { data: leads, error } = await admin.from("leads").select("id").like("customer_name", `[SAM-66 ${marker}]%`);
    if (error) fail("cannot discover marked leads for interrupted local SAM-66 cleanup");
    await cleanup(marker, users.map((user) => user.id), (leads ?? []).map((lead) => lead.id));
  }
}

async function runOnce(index) {
  const marker = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  const users = new Map();
  const leadIds = [];
  const checks = [];
  let primaryError;
  try {
    const admin = serviceClient();
    for (const actor of ACTORS) await createActor(admin, marker, actor, users);
    await runApiFlows(marker, users, leadIds, checks);
    const uiCovered = await runUi(users);
    REPORT.ui = uiCovered && REPORT.ui !== "not-covered-browser-unavailable" ? "covered" : "not-covered-browser-unavailable";
  } catch (error) {
    primaryError = error;
  } finally {
    await cleanup(marker, [...users.values()].map((user) => user.id), leadIds);
  }
  if (primaryError) throw primaryError;
  REPORT.runs.push({ run: index, actors: ["boss", "admin", "operator", "sales", "sales-other"], checks, cleanup: "verified" });
}

async function main() {
  validateEnvironment();
  await recoverInterruptedLocalRuns();
  const health = await fetch(`${BASE_URL}/api/health`, { cache: "no-store" });
  if (health.status !== 200) fail(`local health endpoint returned HTTP ${health.status}`);
  for (let index = 1; index <= RUNS; index += 1) await runOnce(index);
  REPORT.ok = true;
  console.log(JSON.stringify(REPORT));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, ui: REPORT.ui, runs: REPORT.runs.length, error: error instanceof Error ? safeText(error.message) : "SAM66_FAILED" }));
  process.exitCode = 1;
});
