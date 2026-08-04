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

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
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
  let supportApprovalId = null;
  const results = {};
  let executionError = null;
  const cleanupErrors = [];
  const cleanupCounts = {
    organizations: 0,
    memberships: 0,
    membership_roles: 0,
    leads: 0,
    platform_staff: 0,
    support_sessions: 0,
    platform_action_approvals: 0,
    platform_action_approval_events: 0,
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

  async function createMembership(organizationId, userId, roleKey) {
    const { data: membership, error } = await admin.from("memberships").insert({
      organization_id: organizationId,
      user_id: userId,
      status: "active",
      accepted_at: new Date().toISOString(),
    }).select("id").single();
    if (error) throw new Error(`create_membership_failed:${error.message}`);

    const { data: role, error: roleError } = await admin
      .from("roles")
      .select("id")
      .eq("scope", "organization")
      .eq("role_key", roleKey)
      .single();
    if (roleError || !role?.id) {
      throw new Error(`resolve_membership_role_failed:${roleKey}:${roleError?.message ?? "missing_role"}`);
    }

    const { data: membershipRole, error: membershipRoleError } = await admin
      .from("membership_roles")
      .insert({
        organization_id: organizationId,
        membership_id: membership.id,
        role_id: role.id,
      })
      .select("organization_id, membership_id, role_id")
      .single();
    if (membershipRoleError) {
      throw new Error(`create_membership_role_failed:${roleKey}:${membershipRoleError.message}`);
    }
    assert(
      membershipRole.organization_id === organizationId
        && membershipRole.membership_id === membership.id
        && membershipRole.role_id === role.id,
      `membership_role_verification_failed:${roleKey}`,
    );
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
    const companyAdminUser = await createUser("company-admin", "admin");
    const organizationA = await createOrganization("org-a");
    const organizationB = await createOrganization("org-b");
    await createMembership(organizationA, userA.id, "sales_agent");
    await createMembership(organizationB, userB.id, "sales_agent");
    await createMembership(organizationA, companyAdminUser.id, "org_admin");
    const leadA = await createLead(organizationA, userA.id, "lead-a");
    const leadB = await createLead(organizationB, userB.id, "lead-b");

    const [tokenA, tokenB, supportToken, approverToken, companyAdminToken] = await Promise.all([
      signIn(supabaseUrl, anonKey, userA.email, password),
      signIn(supabaseUrl, anonKey, userB.email, password),
      signIn(supabaseUrl, anonKey, supportUser.email, password),
      signIn(supabaseUrl, anonKey, approverUser.email, password),
      signIn(supabaseUrl, anonKey, companyAdminUser.email, password),
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
        role_key: "platform_ops",
      },
      {
        id: approverStaffId,
        user_id: approverUser.id,
        status: "active",
        staff_ref: `${marker}-approver`,
        role_key: "platform_owner",
      },
    ]);
    if (staffError) throw new Error(`platform_staff_failed:${staffError.message}`);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    const supportRequest = {
      support_user_id: supportUser.id,
      organization_id: organizationA,
      ticket_ref: `${marker}-ticket`,
      reason: "Synthetic SAM-20 cross-organization support verification",
      scope: ["lead:read"],
      expires_at: expiresAt,
      idempotency_key: `${marker}-support-request`,
    };

    const companyAdminStart = await jsonResponse(
      await fetch(`${baseUrl}/api/platform/support-sessions`, {
        method: "POST",
        headers: {
          ...apiHeaders(companyAdminToken, organizationA),
          "content-type": "application/json",
        },
        body: JSON.stringify(supportRequest),
      }),
    );
    assert(
      companyAdminStart.response.status === 403
        && companyAdminStart.body?.error === "support_approval_request_unavailable",
      `company_admin_platform_role_not_denied:${companyAdminStart.response.status}`,
    );

    const platformRoleEmail = `${marker}-platform-role@invalid.test`;
    const companyAdminRoleGrant = await jsonResponse(
      await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: {
          ...apiHeaders(companyAdminToken, organizationA),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: platformRoleEmail,
          password,
          full_name: "Synthetic forbidden platform role",
          role: "platform_staff",
        }),
      }),
    );
    assert(
      companyAdminRoleGrant.response.status === 400
        && companyAdminRoleGrant.body?.error === "invalid_role",
      `company_admin_platform_role_grant_not_denied:${companyAdminRoleGrant.response.status}`,
    );
    const { count: forbiddenPlatformProfileCount, error: forbiddenProfileError } =
      await admin
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("email", platformRoleEmail);
    if (forbiddenProfileError) {
      throw new Error(`forbidden_platform_profile_check_failed:${forbiddenProfileError.message}`);
    }
    assert(forbiddenPlatformProfileCount === 0, "company_admin_platform_profile_created");

    const blankReason = await fetch(`${baseUrl}/api/platform/support-sessions`, {
      method: "POST",
      headers: {
        ...apiHeaders(supportToken, organizationA),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...supportRequest, reason: "   " }),
    });
    assert(blankReason.status === 400, `blank_support_reason_http:${blankReason.status}`);

    const longExpiry = await jsonResponse(
      await fetch(`${baseUrl}/api/platform/support-sessions`, {
        method: "POST",
        headers: {
          ...apiHeaders(supportToken, organizationA),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...supportRequest,
          expires_at: new Date(now.getTime() + 4 * 60 * 60 * 1000 + 60_000).toISOString(),
        }),
      }),
    );
    assert(
      longExpiry.response.status === 400
        && longExpiry.body?.error === "support_approval_request_unavailable",
      `long_support_expiry_not_denied:${longExpiry.response.status}`,
    );

    const supportStart = await jsonResponse(
      await fetch(`${baseUrl}/api/platform/support-sessions`, {
        method: "POST",
        headers: {
          ...apiHeaders(supportToken, organizationA),
          "content-type": "application/json",
        },
        body: JSON.stringify(supportRequest),
      }),
    );
    assert(
      supportStart.response.status === 202
        && supportStart.response.headers.get("cache-control") === "no-store"
        && supportStart.body?.status === "pending"
        && supportStart.body?.action_key === "support.session.start"
        && supportStart.body?.target_key === organizationA
        && /^[0-9a-f]{64}$/.test(supportStart.body?.payload_hash ?? "")
        && supportStart.body?.idempotent === false,
      `support_request_http:${supportStart.response.status}`,
    );
    supportApprovalId = supportStart.body?.approval_request_id;
    assert(
      typeof supportApprovalId === "string" && supportApprovalId.length > 0,
      "support_approval_id_missing",
    );

    const selfApproval = await jsonResponse(
      await fetch(`${baseUrl}/api/platform/approvals`, {
        method: "PATCH",
        headers: {
          ...apiHeaders(supportToken, organizationA),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          approval_request_id: supportApprovalId,
          consumption_key: `${marker}-support-consume`,
        }),
      }),
    );
    assert(
      selfApproval.response.status === 403
        && selfApproval.body?.error === "platform_action_approval_failed",
      `support_self_approval_not_denied:${selfApproval.response.status}`,
    );

    const supportApproval = await jsonResponse(
      await fetch(`${baseUrl}/api/platform/approvals`, {
        method: "PATCH",
        headers: {
          ...apiHeaders(approverToken, organizationA),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          approval_request_id: supportApprovalId,
          consumption_key: `${marker}-support-consume`,
        }),
      }),
    );
    assert(
      supportApproval.response.status === 200
        && supportApproval.response.headers.get("cache-control") === "no-store"
        && supportApproval.body?.status === "active"
        && supportApproval.body?.approval_status === "consumed",
      `support_approval_http:${supportApproval.response.status}`,
    );
    supportSessionId = supportApproval.body?.support_session_id;
    assert(
      typeof supportSessionId === "string" && supportSessionId.length > 0,
      "support_session_id_missing",
    );

    const supportList = await jsonResponse(await fetch(`${baseUrl}/api/leads/list`, {
      headers: apiHeaders(supportToken, organizationA, supportSessionId),
    }));
    const supportLeadIds = (supportList.body?.leads ?? []).map((lead) => lead.id);
    assert(
      supportList.response.status === 200
        && supportLeadIds.includes(leadA)
        && !supportLeadIds.includes(leadB)
        && Array.isArray(supportList.body?.salesUsers)
        && supportList.body.salesUsers.length === 0,
      `support_list_http:${supportList.response.status}`,
    );

    const supportEnd = await jsonResponse(
      await fetch(`${baseUrl}/api/platform/support-sessions`, {
        method: "DELETE",
        headers: {
          ...apiHeaders(supportToken, organizationA),
          "content-type": "application/json",
        },
        body: JSON.stringify({ support_session_id: supportSessionId }),
      }),
    );
    assert(
      supportEnd.response.status === 200
        && supportEnd.body?.status === "revoked",
      `support_end_http:${supportEnd.response.status}`,
    );

    const endedSessionAccess = await jsonResponse(
      await fetch(`${baseUrl}/api/leads/list`, {
        headers: apiHeaders(supportToken, organizationA, supportSessionId),
      }),
    );
    assert(
      endedSessionAccess.response.status === 403
        && endedSessionAccess.body?.error === "support_session_not_authorized",
      `ended_support_session_not_denied:${endedSessionAccess.response.status}`,
    );

    const { data: supportAudits, error: auditCountError } = await admin
      .from("audit_events")
      .select("action, outcome")
      .eq("support_session_id", supportSessionId)
      .order("occurred_at", { ascending: true });
    if (auditCountError) throw new Error(`audit_count_failed:${auditCountError.message}`);
    const auditOutcomes = (supportAudits ?? [])
      .map((row) => `${row.action}:${row.outcome}`);
    for (const expected of [
      "support.session.start:success",
      "support.lead:read:success",
      "support.session.end:success",
      "support.lead:read:denied",
    ]) {
      assert(auditOutcomes.includes(expected), `support_audit_missing:${expected}`);
    }
    const { data: approvalEvents, error: approvalEventsError } = await admin
      .from("platform_action_approval_events")
      .select("action")
      .eq("approval_request_id", supportApprovalId);
    if (approvalEventsError) {
      throw new Error(`approval_events_failed:${approvalEventsError.message}`);
    }
    const approvalActions = new Set((approvalEvents ?? []).map((row) => row.action));
    assert(approvalEvents?.length === 3, `support_approval_event_count:${approvalEvents?.length}`);
    for (const action of ["requested", "approved", "consumed"]) {
      assert(approvalActions.has(action), `support_approval_event_missing:${action}`);
    }
    results.support = {
      boundedReasonAndExpiry: 1,
      companyAdminDeniedPlatformRole: 2,
      startAudit: 1,
      objectAudit: 1,
      endAudit: 1,
      endedSessionDenied: 1,
      independentApproval: 1,
      approvalEvents: 3,
      selfApprovalDenied: 1,
    };
  } catch (error) {
    executionError = error;
  } finally {
    async function cleanupStep(label, operation) {
      try {
        const result = await operation();
        if (result?.error) throw result.error;
      } catch (error) {
        cleanupErrors.push(`${label}:${errorMessage(error)}`);
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
        cleanupErrors.push(`${label}:${errorMessage(error)}`);
      }
    }

    if (!supportApprovalId) {
      const approvalLookup = await admin
        .from("platform_action_approvals")
        .select("id, execution_result")
        .eq("request_id", `${marker}-support-request`)
        .maybeSingle();
      if (approvalLookup.error) {
        cleanupErrors.push(`support_approval_lookup:${approvalLookup.error.message}`);
      } else if (approvalLookup.data?.id) {
        supportApprovalId = approvalLookup.data.id;
        const recoveredSessionId = approvalLookup.data.execution_result?.support_session_id;
        if (!supportSessionId && typeof recoveredSessionId === "string") {
          supportSessionId = recoveredSessionId;
        }
      }
    } else if (!supportSessionId) {
      const approvalLookup = await admin
        .from("platform_action_approvals")
        .select("execution_result")
        .eq("id", supportApprovalId)
        .maybeSingle();
      if (approvalLookup.error) {
        cleanupErrors.push(`support_session_lookup:${approvalLookup.error.message}`);
      } else if (typeof approvalLookup.data?.execution_result?.support_session_id === "string") {
        supportSessionId = approvalLookup.data.execution_result.support_session_id;
      }
    }

    if (supportSessionId) {
      await cleanupStep("audit_events", () =>
        admin.from("audit_events").delete().eq("support_session_id", supportSessionId));
    }
    if (supportApprovalId) {
      await cleanupStep("platform_action_approval_events", () => admin
        .from("platform_action_approval_events")
        .delete()
        .eq("approval_request_id", supportApprovalId));
      await cleanupStep("platform_action_approvals", () => admin
        .from("platform_action_approvals")
        .delete()
        .eq("id", supportApprovalId));
    }
    if (supportSessionId) {
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
    if (organizationIds.length > 0) {
      await cleanupStep("membership_roles", () =>
        admin.from("membership_roles").delete().in("organization_id", organizationIds));
      await cleanupStep("memberships", () =>
        admin.from("memberships").delete().in("organization_id", organizationIds));
    }
    if (users.length > 0) {
      await cleanupStep("user_session_daily", () =>
        admin.from("user_session_daily").delete().in("user_id", users));
      await cleanupStep("audit_logs", () =>
        admin.from("audit_logs").delete().in("actor_id", users));
    }
    if (staffIds.length > 0) {
      await cleanupStep("platform_staff", () =>
        admin.from("platform_staff").delete().in("id", staffIds));
    }
    if (organizationIds.length > 0) {
      await cleanupStep("organizations", () =>
        admin.from("organizations").delete().in("id", organizationIds));
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
      await verifyZero("membership_roles", () => admin
        .from("membership_roles")
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
    if (supportApprovalId) {
      await verifyZero("platform_action_approvals", () => admin
        .from("platform_action_approvals")
        .select("id", { count: "exact", head: true })
        .eq("id", supportApprovalId));
      await verifyZero("platform_action_approval_events", () => admin
        .from("platform_action_approval_events")
        .select("id", { count: "exact", head: true })
        .eq("approval_request_id", supportApprovalId));
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
    const reason = executionError === null ? "none" : errorMessage(executionError);
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
