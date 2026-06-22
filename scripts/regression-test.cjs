#!/usr/bin/env node
/** Regression tests for CRM security fixes — uses Supabase JS SDK for auth */
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const BASE = "http://localhost:3001";

const adminClient = createClient(SUPA_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let passed = 0, failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}: ${detail}`); }
}

async function login(email, password) {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  return res.json();
}

async function apiCall(token, path, method = "POST", body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  console.log("🔧 Setup: creating test users...");
  const ts = Date.now();
  const salesEmail = `rtest_sales_${ts}@test.local`;
  const adminEmail = `rtest_admin_${ts}@test.local`;
  const pw = "Test1234!";

  // Create users via admin API and ensure profiles exist
  for (const [email, role] of [[salesEmail, "sales"], [adminEmail, "admin"]]) {
    const { data: { user: newUser }, error: createErr } = await adminClient.auth.admin.createUser({ email, password: pw, email_confirm: true, user_metadata: { role } });
    if (createErr) { console.log("❌ create user failed:", createErr); process.exit(1); }
    // Ensure profiles row exists (trigger may not fire for admin-created users)
    const { data: existingProfile } = await adminClient.from("profiles").select("id").eq("id", newUser.id).maybeSingle();
    if (!existingProfile) {
      await adminClient.from("profiles").insert({ id: newUser.id, email, role });
    } else {
      await adminClient.from("profiles").update({ role }).eq("id", newUser.id);
    }
  }

  // Login
  const salesLogin = await login(salesEmail, pw);
  const adminLogin = await login(adminEmail, pw);
  if (!salesLogin.access_token) { console.log("❌ Sales login failed:", salesLogin); process.exit(1); }
  if (!adminLogin.access_token) { console.log("❌ Admin login failed:", adminLogin); process.exit(1); }

  const salesToken = salesLogin.access_token;
  const adminToken = adminLogin.access_token;

  // Get user IDs from auth (profiles.email may be null due to trigger)
  const { data: { users: allUsers } } = await adminClient.auth.admin.listUsers();
  const salesUser = allUsers.find(u => u.email === salesEmail);
  const adminUser = allUsers.find(u => u.email === adminEmail);
  const salesId = salesUser?.id;
  const adminId = adminUser?.id;
  if (!salesId || !adminId) { console.log("❌ user lookup failed"); process.exit(1); }

  // Ensure profiles role is set correctly
  await adminClient.from("profiles").upsert({ id: salesId, email: salesEmail, role: "sales" }, { onConflict: "id" });
  await adminClient.from("profiles").upsert({ id: adminId, email: adminEmail, role: "admin" }, { onConflict: "id" });

  // Create leads
  const leadPayload = (assigned_to) => ({
    customer_name: `TestCustomer_${ts}`, source: "website", quality: "valid",
    lead_status: "new", stage: "new", next_action: "call",
    next_followup_date: new Date().toISOString().split("T")[0],
    ...(assigned_to ? { assigned_to } : {})
  });

  const { data: ownLead } = await adminClient.from("leads").insert(leadPayload(salesId)).select("id").single();
  const { data: otherLead } = await adminClient.from("leads").insert(leadPayload(null)).select("id").single();
  if (!ownLead || !otherLead) { console.log("❌ Lead creation failed"); process.exit(1); }

  console.log(`  sales=${salesId?.slice(0,8)} own=${ownLead.id.slice(0,8)} other=${otherLead.id.slice(0,8)}\n`);

  // ─── Tests ───
  // Activities
  test("ACT-1: sales+own→200", (await apiCall(salesToken, `/api/activities?lead_id=${ownLead.id}`, "GET")).status === 200);
  test("ACT-2: sales+other→403", (await apiCall(salesToken, `/api/activities?lead_id=${otherLead.id}`, "GET")).status === 403);
  test("ACT-3: admin+own→200", (await apiCall(adminToken, `/api/activities?lead_id=${ownLead.id}`, "GET")).status === 200);

  // Quotations
  const qtBody = (lid) => ({ lead_id: lid, devices: { knx_ip_router: 1 } });
  test("QT-1: sales+own→200", (await apiCall(salesToken, "/api/quotations/generate", "POST", qtBody(ownLead.id))).status === 200);
  test("QT-2: sales+other→403", (await apiCall(salesToken, "/api/quotations/generate", "POST", qtBody(otherLead.id))).status === 403);
  test("QT-3: admin+other→200", (await apiCall(adminToken, "/api/quotations/generate", "POST", qtBody(otherLead.id))).status === 200);
  test("QT-4: no-lead→400", (await apiCall(salesToken, "/api/quotations/generate", "POST", { devices: { knx_ip_router: 1 } })).status === 400);

  // COS
  test("COS-1: valid→200", (await apiCall(salesToken, "/api/cos/download-url", "POST", { key: "quotations/t.pdf", lead_id: ownLead.id })).status === 200);
  test("COS-2: no-lead→400", (await apiCall(salesToken, "/api/cos/download-url", "POST", { key: "quotations/t.pdf" })).status === 400);
  test("COS-3: bad-prefix→400", (await apiCall(salesToken, "/api/cos/download-url", "POST", { key: "bad/x.pdf", lead_id: ownLead.id })).status === 400);
  test("COS-4: traversal→400", (await apiCall(salesToken, "/api/cos/download-url", "POST", { key: "../../etc", lead_id: ownLead.id })).status === 400);

  // KNX
  test("KNX-1: sales+own→200", (await apiCall(salesToken, "/api/hermes/knx-design", "POST", { lead_id: ownLead.id })).status === 200);
  test("KNX-2: sales+other→403", (await apiCall(salesToken, "/api/hermes/knx-design", "POST", { lead_id: otherLead.id })).status === 403);
  test("KNX-3: no-lead→400", (await apiCall(salesToken, "/api/hermes/knx-design", "POST", {})).status === 400);

  // Cleanup
  await adminClient.from("leads").delete().in("id", [ownLead.id, otherLead.id]);
  const { data: users } = await adminClient.from("profiles").select("id").in("email", [salesEmail, adminEmail]);
  for (const u of (users || [])) await adminClient.auth.admin.deleteUser(u.id);

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
