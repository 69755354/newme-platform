#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_PROJECT_REF = "bfsiibofuzoglziltgyd";
const CONFIRMATION = "SAM20_STAGING_ONLY";
const RELEASE_MANIFEST_PATH = "/runner/release/manifest.json";
const ORGANIZATION_HEADER = "x-newme-organization-id";
const SUPPORT_SESSION_HEADER = "x-newme-support-session-id";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonResponse(response) {
  const body = await response.json().catch(() => null);
  return { response, body };
}

function apiHeaders(token, organizationId, supportSessionId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    [ORGANIZATION_HEADER]: organizationId,
  };
  if (supportSessionId) {
    headers[SUPPORT_SESSION_HEADER] = supportSessionId;
  }
  return headers;
}

async function signIn(supabaseUrl, anonKey, email, password) {
  const client = createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) {
    throw new Error(`sign_in_failed:${email}:${error?.message ?? "no_session"}`);
  }
  return data.session.access_token;
}

function dataClient(supabaseUrl, anonKey, token, organizationId) {
  const headers = { Authorization: `Bearer ${token}` };
  if (organizationId) headers[ORGANIZATION_HEADER] = organizationId;
  return createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers },
  });
}

async function main() {
  const baseUrl = required("SAM20_UAT_BASE_URL").replace(/\/$/, "");
  const releaseSha = required("SAM20_RELEASE_SHA");
  const projectRef = required("SUPABASE_PROJECT_REF");
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  assert(
    process.env.SAM20_UAT_CONFIRM === CONFIRMATION,
    `confirmation_required:${CONFIRMATION}`,
  );
  assert(
    projectRef === EXPECTED_PROJECT_REF,
    `wrong_project_ref:${projectRef}`,
  );
  assert(
    new URL(supabaseUrl).hostname.startsWith(`${EXPECTED_PROJECT_REF}.`),
    `wrong_supabase_url:${new URL(supabaseUrl).hostname}`,
  );

  const health = await jsonResponse(await fetch(`${baseUrl}/api/health`, {
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
  const marker = `sam20-${runId}`;
  const password = `Sam20-${randomUUID()}!aA1`;
  const users = [];
  const organizationIds = [];
  const leadIds = [];
  const staffIds = [];
  let supportSessionId = null;
  const results = {};
  let executionError = null;
  const cleanupErrors = [];
  const cleanupCounts = {
    organizations: 0,
    memberships: 0,
    leads: 0,
    platform_staff: 0,
    support_sessions: 0,
    audit_events: 0,
    user_session_daily: 0,
    audit_logs: 0,
    profiles: 0,
    auth_fixtures: 0,
  };

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
    if (profileError) throw new Error(`profile_update_failed:${label}:${profileError.message}`);
    return { id: data.user.id, email };
  }

  async function createOrganization(label) {
    const id = randomUUID();
    const { error } = await admin.from("organizations").insert({
      id,
      slug: `${marker}-${label}`,
      name: `Synthetic ${label}`,
      industry_key: label === "org-a" ? "real_estate" : "retail",
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
    });
    if (error) throw new Error(`create_lead_failed:${label}:${error.message}`);
    leadIds.push(id);
    return id;
  }

  try {
    const userA = await createUser("user-a", "sales");
    const userB = await createUser("user-b", "sales");
    const supportUser = await createUser("support", "operator");
    const approverUser = await createUser("approver", "admin");
    const organizationA = await createOrganization("org-a");
    const organizationB = await createOrganization("org-b");
    await createMembership(organizationA, userA.id);
    await createMembership(organizationB, userB.id);
    const leadA = await createLead(organizationA, userA.id, "lead-a");
    const leadB = await createLead(organizationB, userB.id, "lead-b");

    const [tokenA, tokenB, supportToken] = await Promise.all([
      signIn(supabaseUrl, anonKey, userA.email, password),
      signIn(supabaseUrl, anonKey, userB.email, password),
      signIn(supabaseUrl, anonKey, supportUser.email, password),
    ]);
    const clientA = dataClient(supabaseUrl, anonKey, tokenA, organizationA);
    const clientB = dataClient(supabaseUrl, anonKey, tokenB, organizationB);
    const clientWithoutOrganization = dataClient(supabaseUrl, anonKey, tokenA, null);

    const [detailAOwn, detailACross, detailBOwn, detailBCross] = await Promise.all([
      clientA.from("leads").select("id, organization_id").eq("id", leadA).maybeSingle(),
      clientA.from("leads").select("id, organization_id").eq("id", leadB).maybeSingle(),
      clientB.from("leads").select("id, organization_id").eq("id", leadB).maybeSingle(),
      clientB.from("leads").select("id, organization_id").eq("id", leadA).maybeSingle(),
    ]);
    assert(detailAOwn.data?.id === leadA && !detailAOwn.error, "org_a_own_detail_failed");
    assert(detailBOwn.data?.id === leadB && !detailBOwn.error, "org_b_own_detail_failed");
    assert(detailACross.data === null, "org_a_read_org_b_not_denied");
    assert(detailBCross.data === null, "org_b_read_org_a_not_denied");
    results.detail = { own: 2, crossDenied: 2 };

    const [writeACross, writeBCross] = await Promise.all([
      clientA.from("leads").update({ notes: marker }).eq("id", leadB).select("id"),
      clientB.from("leads").update({ notes: marker }).eq("id", leadA).select("id"),
    ]);
    assert(!writeACross.error && writeACross.data?.length === 0, "org_a_write_org_b_not_denied");
    assert(!writeBCross.error && writeBCross.data?.length === 0, "org_b_write_org_a_not_denied");

    const missingContextWrite = await clientWithoutOrganization.from("leads").insert({
      organization_id: organizationA,
      source: "offline",
      customer_name: marker,
      assigned_to: userA.id,
      created_by: userA.id,
      quality: "pending",
    });
    assert(Boolean(missingContextWrite.error), "missing_org_write_not_denied");
    results.write = { crossDenied: 2, missingContextDenied: 1 };

    const [listA, listB] = await Promise.all([
      jsonResponse(await fetch(`${baseUrl}/api/leads/list`, {
        headers: apiHeaders(tokenA, organizationA),
      })),
      jsonResponse(await fetch(`${baseUrl}/api/leads/list`, {
        headers: apiHeaders(tokenB, organizationB),
      })),
    ]);
    assert(listA.response.status === 200, `list_a_http:${listA.response.status}`);
    assert(listB.response.status === 200, `list_b_http:${listB.response.status}`);
    const listAIds = (listA.body?.leads ?? []).map((lead) => lead.id);
    const listBIds = (listB.body?.leads ?? []).map((lead) => lead.id);
    const listAProfileIds = (listA.body?.salesUsers ?? []).map((profile) => profile.id);
    const listBProfileIds = (listB.body?.salesUsers ?? []).map((profile) => profile.id);
    assert(listAIds.includes(leadA) && !listAIds.includes(leadB), "list_a_isolation_failed");
    assert(listBIds.includes(leadB) && !listBIds.includes(leadA), "list_b_isolation_failed");
    assert(
      listAProfileIds.includes(userA.id) && !listAProfileIds.includes(userB.id),
      "list_a_profile_directory_isolation_failed",
    );
    assert(
      listBProfileIds.includes(userB.id) && !listBProfileIds.includes(userA.id),
      "list_b_profile_directory_isolation_failed",
    );
    results.list = {
      ownVisible: 2,
      crossHidden: 2,
      ownCandidateVisible: 2,
      crossCandidateHidden: 2,
    };

    const [timelineA, timelineACross, timelineB, timelineBCross] = await Promise.all([
      fetch(`${baseUrl}/api/leads/${leadA}/timeline`, {
        headers: apiHeaders(tokenA, organizationA),
      }),
      fetch(`${baseUrl}/api/leads/${leadB}/timeline`, {
        headers: apiHeaders(tokenA, organizationA),
      }),
      fetch(`${baseUrl}/api/leads/${leadB}/timeline`, {
        headers: apiHeaders(tokenB, organizationB),
      }),
      fetch(`${baseUrl}/api/leads/${leadA}/timeline`, {
        headers: apiHeaders(tokenB, organizationB),
      }),
    ]);
    assert(timelineA.status === 200 && timelineB.status === 200, "own_timeline_failed");
    assert(timelineACross.status === 404 && timelineBCross.status === 404, "cross_timeline_not_denied");
    results.timeline = { own: 2, crossDenied: 2 };

    const [supportStaffId, approverStaffId] = [randomUUID(), randomUUID()];
    staffIds.push(supportStaffId, approverStaffId);
    const { error: staffError } = await admin.from("platform_staff").insert([
      {
        id: supportStaffId,
        user_id: supportUser.id,
        status: "active",
        staff_ref: `${marker}-support`,
      },
      {
        id: approverStaffId,
        user_id: approverUser.id,
        status: "active",
        staff_ref: `${marker}-approver`,
      },
    ]);
    if (staffError) throw new Error(`platform_staff_failed:${staffError.message}`);

    supportSessionId = randomUUID();
    const now = new Date();
    const { error: sessionError } = await admin.from("support_sessions").insert({
      id: supportSessionId,
      organization_id: organizationA,
      platform_staff_id: supportStaffId,
      ticket_ref: `${marker}-ticket`,
      reason: "Synthetic SAM-20 organization-boundary verification",
      scope: ["lead:read"],
      status: "active",
      requested_at: now.toISOString(),
      approved_by_platform_staff_id: approverStaffId,
      approved_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    });
    if (sessionError) throw new Error(`support_session_failed:${sessionError.message}`);

    const supportList = await fetch(`${baseUrl}/api/leads/list`, {
      headers: apiHeaders(supportToken, organizationA, supportSessionId),
    });
    assert(supportList.status === 200, `support_list_http:${supportList.status}`);
    const { count: auditCount, error: auditCountError } = await admin
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("support_session_id", supportSessionId)
      .eq("outcome", "success");
    if (auditCountError) throw new Error(`audit_count_failed:${auditCountError.message}`);
    assert(auditCount === 1, `support_audit_count:${auditCount}`);
    results.support = { auditedAccess: 1 };
  } catch (error) {
    executionError = error;
  } finally {
    async function cleanupStep(label, operation) {
      try {
        const result = await operation();
        if (result?.error) throw result.error;
      } catch (error) {
        cleanupErrors.push(
          `${label}:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    async function verifyZero(label, operation) {
      try {
        const result = await operation();
        if (result.error) throw result.error;
        cleanupCounts[label] = result.count;
        if (result.count !== 0) {
          cleanupErrors.push(`${label}:count=${result.count}`);
        }
      } catch (error) {
        cleanupErrors.push(
          `${label}:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (supportSessionId) {
      await cleanupStep("audit_events", () =>
        admin.from("audit_events").delete().eq("support_session_id", supportSessionId));
      await cleanupStep("support_sessions", () =>
        admin.from("support_sessions").delete().eq("id", supportSessionId));
    }
    if (leadIds.length > 0) {
      for (const table of ["activities", "business_events", "follow_up_logs", "tasks"]) {
        await cleanupStep(table, () =>
          admin.from(table).delete().in("lead_id", leadIds));
      }
      await cleanupStep("leads", () =>
        admin.from("leads").delete().in("id", leadIds));
    }
    if (staffIds.length > 0) {
      await cleanupStep("platform_staff", () =>
        admin.from("platform_staff").delete().in("id", staffIds));
    }
    if (organizationIds.length > 0) {
      await cleanupStep("memberships", () =>
        admin.from("memberships").delete().in("organization_id", organizationIds));
      await cleanupStep("organizations", () =>
        admin.from("organizations").delete().in("id", organizationIds));
    }
    if (users.length > 0) {
      await cleanupStep("user_session_daily", () =>
        admin.from("user_session_daily").delete().in("user_id", users));
      await cleanupStep("audit_logs", () =>
        admin.from("audit_logs").delete().in("actor_id", users));
    }
    for (const userId of users) {
      await cleanupStep(`auth_user:${userId}`, () =>
        admin.auth.admin.deleteUser(userId));
    }

    if (organizationIds.length > 0) {
      await verifyZero("organizations", () => admin
        .from("organizations")
        .select("id", { count: "exact", head: true })
        .in("id", organizationIds));
      await verifyZero("memberships", () => admin
        .from("memberships")
        .select("id", { count: "exact", head: true })
        .in("organization_id", organizationIds));
    }
    if (leadIds.length > 0) {
      await verifyZero("leads", () => admin
          .from("leads")
          .select("id", { count: "exact", head: true })
          .in("id", leadIds));
    }
    if (staffIds.length > 0) {
      await verifyZero("platform_staff", () => admin
        .from("platform_staff")
        .select("id", { count: "exact", head: true })
        .in("id", staffIds));
    }
    if (supportSessionId) {
      await verifyZero("support_sessions", () => admin
        .from("support_sessions")
        .select("id", { count: "exact", head: true })
        .eq("id", supportSessionId));
      await verifyZero("audit_events", () => admin
        .from("audit_events")
        .select("id", { count: "exact", head: true })
        .eq("support_session_id", supportSessionId));
    }
    if (users.length > 0) {
      await verifyZero("user_session_daily", () => admin
        .from("user_session_daily")
        .select("id", { count: "exact", head: true })
        .in("user_id", users));
      await verifyZero("audit_logs", () => admin
        .from("audit_logs")
        .select("id", { count: "exact", head: true })
        .in("actor_id", users));
      await verifyZero("profiles", () => admin
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .in("id", users));
      let authFixtureCount = 0;
      for (const userId of users) {
        const { data, error } = await admin.auth.admin.getUserById(userId);
        if (data.user) authFixtureCount += 1;
        if (error && error.status !== 404) {
          cleanupErrors.push(`auth_fixture_check:${userId}:${error.message}`);
        }
      }
      cleanupCounts.auth_fixtures = authFixtureCount;
      if (authFixtureCount !== 0) {
        cleanupErrors.push(`auth_fixtures:count=${authFixtureCount}`);
      }
    }
  }

  if (executionError || cleanupErrors.length > 0) {
    const reason = executionError instanceof Error
      ? executionError.message
      : executionError === null
        ? "none"
        : String(executionError);
    throw new Error(
      `execution=${reason};cleanup=${cleanupErrors.length === 0 ? "0" : cleanupErrors.join("|")}`,
    );
  }

  console.log(JSON.stringify({
    linearId: "SAM-20",
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
    linearId: "SAM-20",
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
