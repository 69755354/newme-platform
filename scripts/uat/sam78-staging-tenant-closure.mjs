#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { runProductSaasFinalUat } from "./product-saas-final.mjs";

export const STAGING_PROJECT_REF = "bfsiibofuzoglziltgyd";
export const PRODUCTION_PROJECT_REF = "vfopmpxlhwzpxqegayew";
export const FIXED_MANIFEST_PATH = "/runner/release/manifest.json";
export const CONFIRMATION = "SAM78_STAGING_TENANT_CLOSURE_ONLY";
export const SCOPE = "sam78-staging-tenant-closure";
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(`SAM78_FAIL_CLOSED:${message}`);
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message.replaceAll(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1000);
}

export function validateEnvironment(env = process.env) {
  const config = {
    releaseSha: env.SAM78_EXPECTED_RELEASE_SHA,
    baseUrl: env.SAM78_BASE_URL,
    manifestPath: env.SAM78_RELEASE_MANIFEST,
    confirmation: env.SAM78_UAT_CONFIRM,
    projectRef: env.NEWME_STAGING_PROJECT_REF,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };
  if (!SHA_PATTERN.test(config.releaseSha ?? "")) fail("invalid_release_sha");
  if (config.baseUrl !== "http://127.0.0.1:3101") fail("non_loopback_staging_url");
  if (config.manifestPath !== FIXED_MANIFEST_PATH) fail("non_fixed_manifest_path");
  if (config.confirmation !== CONFIRMATION) fail("missing_staging_confirmation");
  if (config.projectRef !== STAGING_PROJECT_REF) fail("wrong_staging_project");
  if (config.supabaseUrl !== `https://${STAGING_PROJECT_REF}.supabase.co`) {
    fail("wrong_staging_supabase_url");
  }
  for (const value of [config.supabaseUrl, config.anonKey, config.serviceKey]) {
    if (!value || value.includes(PRODUCTION_PROJECT_REF)) fail("production_or_missing_credential");
  }
  return config;
}

export async function verifyReleaseBoundary(config, dependencies = {}) {
  const read = dependencies.readFile ?? readFile;
  const request = dependencies.fetch ?? fetch;
  const manifest = JSON.parse(await read(config.manifestPath, "utf8"));
  if (manifest.git_sha !== config.releaseSha) fail("manifest_sha_mismatch");
  const response = await request(`${config.baseUrl}/api/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
  const payload = await response.json().catch(() => null);
  if (response.status !== 200 || payload?.status !== "ok") fail("staging_health_not_ok");
  return { project_ref: config.projectRef, manifest_sha: manifest.git_sha, health: 200 };
}

function clients(config, organizationId, token) {
  const options = { auth: { autoRefreshToken: false, persistSession: false } };
  return {
    admin: createClient(config.supabaseUrl, config.serviceKey, options),
    user: createClient(config.supabaseUrl, config.anonKey, {
      ...options,
      global: { headers: {
        Authorization: `Bearer ${token}`,
        "x-newme-organization-id": organizationId,
      } },
    }),
  };
}

async function count(admin, table, column, values) {
  if (values.length === 0) return 0;
  const { count: value, error } = await admin.from(table).select("*", { count: "exact", head: true }).in(column, values);
  if (error || value === null) fail(`cleanup_count_${table}`);
  return value;
}

async function authUserCount(admin, userId) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail("cleanup_count_auth_users");
    if ((data.users ?? []).some((user) => user.id === userId)) return 1;
    if ((data.users ?? []).length < 200) return 0;
  }
  fail("cleanup_auth_user_pagination_exceeded");
}

async function runTwoOrganizationMatrix(config) {
  const runId = randomUUID();
  const marker = `sam78-${runId}`;
  const organizationIds = [randomUUID(), randomUUID()];
  const leadIds = [randomUUID(), randomUUID()];
  const membershipIds = [];
  let userId;
  const root = createClient(config.supabaseUrl, config.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const cleanupCounts = {};
  try {
    const { error: orgError } = await root.from("organizations").insert(organizationIds.map((id, index) => ({
      id,
      slug: `${marker}-${index + 1}`,
      name: `[SAM78 ${runId}] organization ${index + 1}`,
      industry_key: index === 0 ? "real_estate" : "retail",
      plan_key: "growth",
      billable_seat_limit: 20,
      status: "active",
    })));
    if (orgError) fail("organization_fixture_create");

    const email = `${marker}@invalid.test`;
    const password = `${randomBytes(32).toString("base64url")}Aa1!`;
    const { data: created, error: userError } = await root.auth.admin.createUser({
      email, password, email_confirm: true,
      app_metadata: { fixture_scope: SCOPE, run_id: runId },
      user_metadata: { full_name: `[SAM78 ${runId}] multi organization actor` },
    });
    if (userError || !created.user) fail("identity_fixture_create");
    userId = created.user.id;
    const { error: profileError } = await root.from("profiles").update({
      role: "boss", full_name: `[SAM78 ${runId}] actor`, email, is_active: true,
      force_password_change: false,
    }).eq("id", userId);
    if (profileError) fail("profile_fixture_configure");

    const { data: ownerRole, error: roleError } = await root.from("roles")
      .select("id").eq("scope", "organization").eq("role_key", "org_owner").single();
    if (roleError || !ownerRole?.id) fail("organization_owner_role_missing");
    for (const organizationId of organizationIds) {
      const { data: membership, error } = await root.from("memberships").insert({
        organization_id: organizationId, user_id: userId, status: "active",
        accepted_at: new Date().toISOString(),
      }).select("id").single();
      if (error || !membership?.id) fail("membership_fixture_create");
      membershipIds.push(membership.id);
      const { error: mappingError } = await root.from("membership_roles").insert({
        membership_id: membership.id, role_id: ownerRole.id,
      });
      if (mappingError) fail("membership_role_fixture_create");
    }

    const authClient = createClient(config.supabaseUrl, config.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: signedIn, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
    if (signInError || !signedIn.session) fail("identity_fixture_sign_in");
    const token = signedIn.session.access_token;

    const { error: leadError } = await root.from("leads").insert(organizationIds.map((organizationId, index) => ({
      id: leadIds[index], organization_id: organizationId,
      customer_name: `[SAM78 ${runId}] tenant ${index + 1}`,
      source: "other", stage: "new", quality: "pending",
      assigned_to: userId, created_by: userId,
    })));
    if (leadError) fail("lead_fixture_create");

    for (let index = 0; index < organizationIds.length; index += 1) {
      const selected = organizationIds[index];
      const foreign = organizationIds[1 - index];
      const foreignLead = leadIds[1 - index];
      const { user } = clients(config, selected, token);
      const visible = await user.from("leads").select("id,organization_id,customer_name").ilike("customer_name", `[SAM78 ${runId}]%`);
      if (visible.error || visible.data?.length !== 1 || visible.data[0].organization_id !== selected) {
        fail(`selected_organization_list_isolation_${index}`);
      }
      const direct = await user.from("leads").select("id").eq("id", foreignLead);
      if (direct.error || direct.data?.length !== 0) fail(`direct_id_cross_tenant_${index}`);
      const foreignOrg = await user.from("organizations").select("id").eq("id", foreign);
      if (foreignOrg.error || foreignOrg.data?.length !== 0) fail(`organization_cross_tenant_${index}`);
      const selectedOrg = await user.from("organizations").select("id").eq("id", selected);
      if (selectedOrg.error || selectedOrg.data?.length !== 1 || selectedOrg.data[0].id !== selected) {
        fail(`selected_organization_not_visible_${index}`);
      }
    }

    return {
      status: "pass",
      run_id: runId,
      organizations: 2,
      shared_identity_memberships: 2,
      checks: ["selected_org", "search", "direct_id", "organization_row"],
      cleanup_counts: cleanupCounts,
    };
  } finally {
    const cleanupErrors = [];
    const remove = async (label, operation) => {
      const { error } = await operation;
      if (error) cleanupErrors.push(`${label}:${error.code ?? "unknown"}`);
    };
    if (userId) {
      await remove("audit_logs", root.from("audit_logs").delete().in("organization_id", organizationIds));
      await remove("audit_events", root.from("audit_events").delete().in("organization_id", organizationIds));
      await remove("activity_logs", root.from("activity_logs").delete().in("organization_id", organizationIds));
      await remove("activities", root.from("activities").delete().in("organization_id", organizationIds));
      for (const table of [
        "commercial_action_events", "commercial_state_events", "commercial_usage_events",
        "commercial_invoice_references", "commercial_action_requests", "commercial_seat_events",
        "paid_seat_allocations", "commercial_entitlements", "organization_subscriptions",
      ]) {
        await remove(table, root.from(table).delete().in("organization_id", organizationIds));
      }
      await remove("leads", root.from("leads").delete().in("id", leadIds));
      if (membershipIds.length) {
        await remove("membership_roles", root.from("membership_roles").delete().in("membership_id", membershipIds));
      }
      await remove("memberships", root.from("memberships").delete().in("organization_id", organizationIds));
      await remove("profiles", root.from("profiles").delete().eq("id", userId));
      const { error: authDeleteError } = await root.auth.admin.deleteUser(userId);
      if (authDeleteError) cleanupErrors.push(`auth_users:${authDeleteError.status ?? "unknown"}`);
    }
    await remove("organizations", root.from("organizations").delete().in("id", organizationIds));
    cleanupCounts.organizations = await count(root, "organizations", "id", organizationIds);
    cleanupCounts.memberships = await count(root, "memberships", "organization_id", organizationIds);
    cleanupCounts.membership_roles = await count(root, "membership_roles", "membership_id", membershipIds);
    cleanupCounts.leads = await count(root, "leads", "id", leadIds);
    cleanupCounts.audit_events = await count(root, "audit_events", "organization_id", organizationIds);
    cleanupCounts.audit_logs = await count(root, "audit_logs", "organization_id", organizationIds);
    cleanupCounts.activity_logs = await count(root, "activity_logs", "organization_id", organizationIds);
    cleanupCounts.activities = await count(root, "activities", "organization_id", organizationIds);
    for (const table of [
      "commercial_action_events", "commercial_state_events", "commercial_usage_events",
      "commercial_invoice_references", "commercial_action_requests", "commercial_seat_events",
      "paid_seat_allocations", "commercial_entitlements", "organization_subscriptions",
    ]) cleanupCounts[table] = await count(root, table, "organization_id", organizationIds);
    cleanupCounts.profiles = userId ? await count(root, "profiles", "id", [userId]) : 0;
    cleanupCounts.auth_users = userId ? await authUserCount(root, userId) : 0;
    if (cleanupErrors.length || Object.values(cleanupCounts).some((value) => value !== 0)) {
      fail(`fixture_cleanup_failed:${cleanupErrors.join(",")}`);
    }
  }
}

export async function runSam78StagingTenantClosure(env = process.env, dependencies = {}) {
  const config = validateEnvironment(env);
  const release = await verifyReleaseBoundary(config, dependencies);
  const product = await (dependencies.runProductSaasFinalUat ?? runProductSaasFinalUat)(env, dependencies.productDependencies);
  if (!product?.ok || product.cleanup !== "verified" || product.results?.["CUSTOMER-EXIT"]?.status !== "pass") {
    fail("product_lifecycle_prerequisite_failed");
  }
  const tenantIsolation = await (dependencies.runTwoOrganizationMatrix ?? runTwoOrganizationMatrix)(config);
  return {
    ok: true,
    scope: SCOPE,
    release,
    product_lifecycle: {
      status: "pass",
      cleanup: product.cleanup,
      customer_exit: product.results["CUSTOMER-EXIT"].status,
    },
    tenant_isolation: tenantIsolation,
    cleanup: "verified",
  };
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await runSam78StagingTenantClosure(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${safeMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
