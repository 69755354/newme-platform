#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_PROJECT_REF = "bfsiibofuzoglziltgyd";
const CONFIRMATION = "SAM22_STAGING_ONLY";
const RELEASE_MANIFEST_PATH = "/runner/release/manifest.json";
const ORGANIZATION_HEADER = "x-newme-organization-id";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function parsed(response) {
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body, text };
}

function headers(token, organizationId, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    [ORGANIZATION_HEADER]: organizationId,
    ...extra,
  };
}

async function main() {
  const baseUrl = required("SAM22_UAT_BASE_URL").replace(/\/$/, "");
  const releaseSha = required("SAM22_RELEASE_SHA");
  const projectRef = required("SUPABASE_PROJECT_REF");
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const webhookSecret = required("META_CAPI_WEBHOOK_SECRET");
  const cronSecret = required("CRON_SECRET");
  assert(
    process.env.SAM22_UAT_CONFIRM === CONFIRMATION,
    `confirmation_required:${CONFIRMATION}`,
  );
  assert(projectRef === EXPECTED_PROJECT_REF, `wrong_project_ref:${projectRef}`);
  assert(
    new URL(supabaseUrl).hostname.startsWith(`${EXPECTED_PROJECT_REF}.`),
    `wrong_supabase_url:${new URL(supabaseUrl).hostname}`,
  );

  const health = await parsed(await fetch(`${baseUrl}/api/health`, {
    redirect: "manual",
  }));
  assert(health.response.status === 200, `health_http:${health.response.status}`);
  assert(health.body?.status === "ok", "health_status_not_ok");
  const manifest = JSON.parse(await readFile(RELEASE_MANIFEST_PATH, "utf8"));
  assert(manifest?.git_sha === releaseSha, `manifest_sha:${manifest?.git_sha}`);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  const runId = randomUUID();
  const marker = `sam22-${runId}`;
  const password = `Sam22-${randomUUID()}!aA1`;
  const users = [];
  const organizationIds = [];
  const leadIds = [];
  const snapshotIds = [];
  const results = {};
  const cleanupErrors = [];
  const cleanupCounts = {
    organizations: 0,
    memberships: 0,
    leads: 0,
    snapshots: 0,
    audit_events: 0,
    child_records: 0,
    user_session_daily: 0,
    audit_logs: 0,
    profiles: 0,
    auth_fixtures: 0,
  };
  let executionError = null;

  async function createUser(label, role) {
    const email = `${marker}-${label}@invalid.test`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `Synthetic ${label}` },
    });
    if (error || !data.user) {
      throw new Error(`create_user_failed:${label}:${error?.message ?? "no_user"}`);
    }
    users.push(data.user.id);
    const { error: profileError } = await admin
      .from("profiles")
      .update({ role, is_active: true })
      .eq("id", data.user.id);
    if (profileError) {
      throw new Error(`profile_update_failed:${label}:${profileError.message}`);
    }
    return { id: data.user.id, email };
  }

  async function signIn(email) {
    const client = createClient(supabaseUrl, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.session?.access_token) {
      throw new Error(`sign_in_failed:${email}:${error?.message ?? "no_session"}`);
    }
    return data.session.access_token;
  }

  async function createOrganization(label, industryKey) {
    const id = randomUUID();
    const { error } = await admin.from("organizations").insert({
      id,
      slug: `${marker}-${label}`,
      name: `Synthetic ${label}`,
      industry_key: industryKey,
      status: "active",
      data_region: "uae",
      timezone: "Asia/Dubai",
    });
    if (error) throw new Error(`create_org_failed:${label}:${error.message}`);
    organizationIds.push(id);
    return id;
  }

  async function createMembership(organizationId, userId) {
    const { error } = await admin.from("memberships").insert({
      organization_id: organizationId,
      user_id: userId,
      status: "active",
      accepted_at: new Date().toISOString(),
    });
    if (error) throw new Error(`create_membership_failed:${error.message}`);
  }

  async function createLead(organizationId, userId, label) {
    const id = randomUUID();
    const { error } = await admin.from("leads").insert({
      id,
      organization_id: organizationId,
      source: "offline",
      customer_name: `${marker}-${label}`,
      email: `${marker}-${label}@invalid.test`,
      assigned_to: userId,
      created_by: userId,
      quality: "pending",
      import_fingerprint: `${marker}-shared-direct`,
    });
    if (error) throw new Error(`create_lead_failed:${label}:${error.message}`);
    leadIds.push(id);
    return id;
  }

  try {
    const [adminA, adminB, salesA, salesB] = await Promise.all([
      createUser("admin-a", "admin"),
      createUser("admin-b", "admin"),
      createUser("sales-a", "sales"),
      createUser("sales-b", "sales"),
    ]);
    const organizationA = await createOrganization("org-a", "real_estate");
    const organizationB = await createOrganization("org-b", "retail");
    await Promise.all([
      createMembership(organizationA, adminA.id),
      createMembership(organizationA, salesA.id),
      createMembership(organizationB, adminB.id),
      createMembership(organizationB, salesB.id),
    ]);
    const [leadA, leadB] = await Promise.all([
      createLead(organizationA, salesA.id, "lead-a"),
      createLead(organizationB, salesB.id, "lead-b"),
    ]);
    const [tokenA, tokenB] = await Promise.all([
      signIn(adminA.email),
      signIn(adminB.email),
    ]);

    const [listA, listB, searchA, searchB] = await Promise.all([
      parsed(await fetch(`${baseUrl}/api/leads/list`, {
        headers: headers(tokenA, organizationA),
      })),
      parsed(await fetch(`${baseUrl}/api/leads/list`, {
        headers: headers(tokenB, organizationB),
      })),
      parsed(await fetch(
        `${baseUrl}/api/leads/list?q=${encodeURIComponent(`${marker}-lead-a`)}`,
        { headers: headers(tokenA, organizationA) },
      )),
      parsed(await fetch(
        `${baseUrl}/api/leads/list?q=${encodeURIComponent(`${marker}-lead-b`)}`,
        { headers: headers(tokenB, organizationB) },
      )),
    ]);
    for (const response of [listA, listB, searchA, searchB]) {
      assert(response.response.status === 200, `list_search_http:${response.response.status}`);
    }
    const listAIds = (listA.body.leads ?? []).map((lead) => lead.id);
    const listBIds = (listB.body.leads ?? []).map((lead) => lead.id);
    assert(listAIds.includes(leadA) && !listAIds.includes(leadB), "list_a_isolation_failed");
    assert(listBIds.includes(leadB) && !listBIds.includes(leadA), "list_b_isolation_failed");
    assert(searchA.body.leads.length === 1 && searchA.body.leads[0].id === leadA, "search_a_isolation_failed");
    assert(searchB.body.leads.length === 1 && searchB.body.leads[0].id === leadB, "search_b_isolation_failed");
    results.list_search = { ownVisible: 4, crossHidden: 4 };

    const [detailA, detailACross, detailB, detailBCross] = await Promise.all([
      fetch(`${baseUrl}/api/leads/${leadA}`, { headers: headers(tokenA, organizationA) }),
      fetch(`${baseUrl}/api/leads/${leadB}`, { headers: headers(tokenA, organizationA) }),
      fetch(`${baseUrl}/api/leads/${leadB}`, { headers: headers(tokenB, organizationB) }),
      fetch(`${baseUrl}/api/leads/${leadA}`, { headers: headers(tokenB, organizationB) }),
    ]);
    assert(detailA.status === 200 && detailB.status === 200, "own_detail_failed");
    assert(detailACross.status === 404 && detailBCross.status === 404, "cross_detail_not_hidden");
    results.direct_id = { own: 2, crossHidden: 2 };

    const [exportA, exportB] = await Promise.all([
      parsed(await fetch(`${baseUrl}/api/leads/export`, {
        headers: headers(tokenA, organizationA),
      })),
      parsed(await fetch(`${baseUrl}/api/leads/export`, {
        headers: headers(tokenB, organizationB),
      })),
    ]);
    assert(exportA.response.status === 200 && exportB.response.status === 200, "export_http_failed");
    assert(exportA.text.includes(`${marker}-lead-a`) && !exportA.text.includes(`${marker}-lead-b`), "export_a_isolation_failed");
    assert(exportB.text.includes(`${marker}-lead-b`) && !exportB.text.includes(`${marker}-lead-a`), "export_b_isolation_failed");
    results.export = { ownVisible: 2, crossHidden: 2 };

    const importRow = {
      row_number: 1,
      customer_name: `${marker}-import`,
      phone: "+971500000000",
      first_contact_date: "2026-01-01",
      source: "offline",
      quality: "",
      lead_status: "",
      raw_import_data: { marker },
    };
    const [importA, importB] = await Promise.all([
      parsed(await fetch(`${baseUrl}/api/leads/import/confirm`, {
        method: "POST",
        headers: headers(tokenA, organizationA, { "content-type": "application/json" }),
        body: JSON.stringify({ rows: [importRow] }),
      })),
      parsed(await fetch(`${baseUrl}/api/leads/import/confirm`, {
        method: "POST",
        headers: headers(tokenB, organizationB, { "content-type": "application/json" }),
        body: JSON.stringify({ rows: [importRow] }),
      })),
    ]);
    assert(importA.response.status === 200 && importB.response.status === 200, "import_http_failed");
    assert(importA.body.imported === 1 && importB.body.imported === 1, "cross_org_import_deduped");
    leadIds.push(...importA.body.imported_ids, ...importB.body.imported_ids);
    results.import = { organizationScopedIdenticalRows: 2 };

    const webhookPayload = {
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1_000),
      user_data: {
        full_name: `${marker}-webhook`,
        email: `${marker}-webhook@invalid.test`,
        phone: "+971500000001",
      },
      custom_data: { platform: "facebook", campaign_name: marker },
    };
    const [webhookA, webhookB] = await Promise.all([
      parsed(await fetch(`${baseUrl}/api/leads/meta-capi`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${webhookSecret}`,
          [ORGANIZATION_HEADER]: organizationA,
          "content-type": "application/json",
        },
        body: JSON.stringify(webhookPayload),
      })),
      parsed(await fetch(`${baseUrl}/api/leads/meta-capi`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${webhookSecret}`,
          [ORGANIZATION_HEADER]: organizationB,
          "content-type": "application/json",
        },
        body: JSON.stringify(webhookPayload),
      })),
    ]);
    assert(webhookA.response.status === 200 && webhookB.response.status === 200, "webhook_http_failed");
    assert(webhookA.body.duplicate === false && webhookB.body.duplicate === false, "webhook_cross_org_deduped");
    leadIds.push(webhookA.body.lead_id, webhookB.body.lead_id);
    results.webhook = { organizationScopedCreates: 2 };

    const [cronA, cronB] = await Promise.all([
      parsed(await fetch(`${baseUrl}/api/cron/daily-funnel-snapshot`, {
        headers: {
          "x-cron-secret": cronSecret,
          [ORGANIZATION_HEADER]: organizationA,
        },
      })),
      parsed(await fetch(`${baseUrl}/api/cron/daily-funnel-snapshot`, {
        headers: {
          "x-cron-secret": cronSecret,
          [ORGANIZATION_HEADER]: organizationB,
        },
      })),
    ]);
    assert(cronA.response.status === 200 && cronB.response.status === 200, "cron_http_failed");
    assert(cronA.body.organizationCount === 1 && cronB.body.organizationCount === 1, "cron_scope_count_failed");
    const { data: snapshots, error: snapshotsError } = await admin
      .from("crm_daily_funnel_snapshot")
      .select("id,organization_id")
      .in("organization_id", [organizationA, organizationB]);
    if (snapshotsError) throw new Error(`snapshot_fetch_failed:${snapshotsError.message}`);
    snapshotIds.push(...(snapshots ?? []).map((row) => row.id));
    assert(new Set((snapshots ?? []).map((row) => row.organization_id)).size === 2, "snapshot_org_isolation_failed");
    results.cron = { organizationRuns: 2, snapshotRows: snapshotIds.length };

    const [dashboardA, dashboardB] = await Promise.all([
      parsed(await fetch(`${baseUrl}/api/dashboard/summary`, {
        headers: headers(tokenA, organizationA),
      })),
      parsed(await fetch(`${baseUrl}/api/dashboard/summary`, {
        headers: headers(tokenB, organizationB),
      })),
    ]);
    assert(dashboardA.response.status === 200 && dashboardB.response.status === 200, "dashboard_http_failed");
    const dashboardAIds = (dashboardA.body.leads ?? []).map((lead) => lead.id);
    const dashboardBIds = (dashboardB.body.leads ?? []).map((lead) => lead.id);
    const dashboardAUsers = (dashboardA.body.salesUsers ?? []).map((user) => user.id);
    const dashboardBUsers = (dashboardB.body.salesUsers ?? []).map((user) => user.id);
    assert(dashboardAIds.includes(leadA) && !dashboardAIds.includes(leadB), "dashboard_a_leak");
    assert(dashboardBIds.includes(leadB) && !dashboardBIds.includes(leadA), "dashboard_b_leak");
    assert(dashboardAUsers.includes(salesA.id) && !dashboardAUsers.includes(salesB.id), "dashboard_a_profile_leak");
    assert(dashboardBUsers.includes(salesB.id) && !dashboardBUsers.includes(salesA.id), "dashboard_b_profile_leak");
    results.dashboard = { ownVisible: 4, crossHidden: 4 };

    const [membersA, membersB, crossDeleteA, crossDeleteB] = await Promise.all([
      parsed(await fetch(`${baseUrl}/api/users`, {
        headers: headers(tokenA, organizationA),
      })),
      parsed(await fetch(`${baseUrl}/api/users`, {
        headers: headers(tokenB, organizationB),
      })),
      fetch(`${baseUrl}/api/users/${salesB.id}`, {
        method: "DELETE",
        headers: headers(tokenA, organizationA),
      }),
      fetch(`${baseUrl}/api/users/${salesA.id}`, {
        method: "DELETE",
        headers: headers(tokenB, organizationB),
      }),
    ]);
    assert(membersA.response.status === 200 && membersB.response.status === 200, "members_http_failed");
    const memberAIds = membersA.body.users.map((user) => user.id);
    const memberBIds = membersB.body.users.map((user) => user.id);
    assert(memberAIds.includes(salesA.id) && !memberAIds.includes(salesB.id), "members_a_leak");
    assert(memberBIds.includes(salesB.id) && !memberBIds.includes(salesA.id), "members_b_leak");
    assert(crossDeleteA.status === 404 && crossDeleteB.status === 404, "cross_org_member_mutation_not_denied");
    results.member_admin = { ownVisible: 4, crossHidden: 4, crossMutationDenied: 2 };
  } catch (error) {
    executionError = error;
  } finally {
    async function cleanup(label, operation) {
      try {
        const result = await operation();
        if (result?.error) throw result.error;
      } catch (error) {
        cleanupErrors.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    async function verifyZero(label, operation) {
      try {
        const result = await operation();
        if (result.error) throw result.error;
        cleanupCounts[label] = result.count;
        if (result.count !== 0) cleanupErrors.push(`${label}:count=${result.count}`);
      } catch (error) {
        cleanupErrors.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (leadIds.length > 0) {
      for (const table of [
        "activities",
        "business_events",
        "chat_messages",
        "follow_up_logs",
        "lead_documents",
        "lead_milestones",
        "tasks",
      ]) {
        await cleanup(table, () => admin.from(table).delete().in("lead_id", leadIds));
      }
    }
    if (snapshotIds.length > 0) {
      await cleanup("snapshots", () => admin
        .from("crm_daily_funnel_snapshot")
        .delete()
        .in("id", snapshotIds));
    }
    if (leadIds.length > 0) {
      await cleanup("leads", () => admin.from("leads").delete().in("id", leadIds));
    }
    if (organizationIds.length > 0) {
      await cleanup("audit_events", () => admin
        .from("audit_events")
        .delete()
        .in("organization_id", organizationIds));
      await cleanup("memberships", () => admin
        .from("memberships")
        .delete()
        .in("organization_id", organizationIds));
      await cleanup("organizations", () => admin
        .from("organizations")
        .delete()
        .in("id", organizationIds));
    }
    if (users.length > 0) {
      await cleanup("user_session_daily", () => admin
        .from("user_session_daily")
        .delete()
        .in("user_id", users));
      await cleanup("audit_logs", () => admin
        .from("audit_logs")
        .delete()
        .in("actor_id", users));
    }
    for (const userId of users) {
      await cleanup(`auth_user:${userId}`, () => admin.auth.admin.deleteUser(userId));
    }

    if (organizationIds.length > 0) {
      await verifyZero("organizations", () => admin.from("organizations")
        .select("id", { count: "exact", head: true }).in("id", organizationIds));
      await verifyZero("memberships", () => admin.from("memberships")
        .select("id", { count: "exact", head: true }).in("organization_id", organizationIds));
      await verifyZero("audit_events", () => admin.from("audit_events")
        .select("id", { count: "exact", head: true }).in("organization_id", organizationIds));
    }
    if (leadIds.length > 0) {
      await verifyZero("leads", () => admin.from("leads")
        .select("id", { count: "exact", head: true }).in("id", leadIds));
      let childCount = 0;
      for (const table of [
        "activities",
        "business_events",
        "chat_messages",
        "follow_up_logs",
        "lead_documents",
        "lead_milestones",
        "tasks",
      ]) {
        const result = await admin.from(table)
          .select("id", { count: "exact", head: true }).in("lead_id", leadIds);
        if (result.error) cleanupErrors.push(`verify_${table}:${result.error.message}`);
        childCount += result.count ?? 0;
      }
      cleanupCounts.child_records = childCount;
      if (childCount !== 0) cleanupErrors.push(`child_records:count=${childCount}`);
    }
    if (snapshotIds.length > 0) {
      await verifyZero("snapshots", () => admin.from("crm_daily_funnel_snapshot")
        .select("id", { count: "exact", head: true }).in("id", snapshotIds));
    }
    if (users.length > 0) {
      await verifyZero("user_session_daily", () => admin.from("user_session_daily")
        .select("id", { count: "exact", head: true }).in("user_id", users));
      await verifyZero("audit_logs", () => admin.from("audit_logs")
        .select("id", { count: "exact", head: true }).in("actor_id", users));
      await verifyZero("profiles", () => admin.from("profiles")
        .select("id", { count: "exact", head: true }).in("id", users));
      let authCount = 0;
      for (const userId of users) {
        const { data, error } = await admin.auth.admin.getUserById(userId);
        if (data.user) authCount += 1;
        if (error && error.status !== 404) {
          cleanupErrors.push(`auth_check:${userId}:${error.message}`);
        }
      }
      cleanupCounts.auth_fixtures = authCount;
      if (authCount !== 0) cleanupErrors.push(`auth_fixtures:count=${authCount}`);
    }
  }

  if (executionError || cleanupErrors.length > 0) {
    const execution = executionError instanceof Error
      ? executionError.message
      : executionError === null ? "none" : String(executionError);
    throw new Error(
      `execution=${execution};cleanup=${cleanupErrors.length === 0 ? "0" : cleanupErrors.join("|")}`,
    );
  }

  console.log(JSON.stringify({
    linearId: "SAM-22",
    releaseSha,
    projectRef,
    runId,
    results,
    cleanup: "verified",
    cleanupCounts,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    linearId: "SAM-22",
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
