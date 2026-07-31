#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_PROJECT_REF = "bfsiibofuzoglziltgyd";
const CONFIRMATION = "SAM23_STAGING_ONLY";
const RELEASE_MANIFEST_PATH = "/runner/release/manifest.json";
const ORGANIZATION_HEADER = "x-newme-organization-id";
const STAGING_BASE_URL = "http://127.0.0.1:3101";
const STAGING_SUPABASE_URL =
  `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const FIXTURE_SCOPE = "newme-staging-uat";
const FIXTURE_KIND = "sam23-organization-commercial-core";
const AUTH_PAGE_LIMIT = 20;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function trackUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

function exactAuthMarker(user, runId, email) {
  const metadata = user?.app_metadata ?? {};
  return user?.email === email
    && metadata.fixture_scope === FIXTURE_SCOPE
    && metadata.fixture_kind === FIXTURE_KIND
    && metadata.run_id === runId;
}

function createSupabase(url, key, headers = {}) {
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers },
  });
}

async function signIn(url, anonKey, email, password, organizationId) {
  const client = createSupabase(url, anonKey, {
    [ORGANIZATION_HEADER]: organizationId,
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session?.access_token) {
    throw new Error(`sign_in_failed:${email}:${error?.message ?? "no_session"}`);
  }
  return {
    token: data.session.access_token,
    client: createSupabase(url, anonKey, {
    Authorization: `Bearer ${data.session.access_token}`,
    [ORGANIZATION_HEADER]: organizationId,
    }),
  };
}

async function requireInsert(query, label) {
  const { data, error } = await query.select().single();
  if (error || !data) {
    throw new Error(`${label}_failed:${error?.message ?? "no_row"}`);
  }
  return data;
}

async function requireDelete(query, label) {
  const { error } = await query;
  if (error) throw new Error(`${label}_failed:${error.message}`);
}

async function exactCount(client, table, column, values) {
  if (values.length === 0) return 0;
  const { count, error } = await client
    .from(table)
    .select("*", { count: "exact", head: true })
    .in(column, values);
  if (error) throw new Error(`count_${table}_failed:${error.message}`);
  return count ?? 0;
}

async function exactEqCount(client, table, column, value) {
  const { count, error } = await client
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(column, value);
  if (error) throw new Error(`count_${table}_${column}_failed:${error.message}`);
  return count ?? 0;
}

async function exactLikeCount(client, table, column, value) {
  const { count, error } = await client
    .from(table)
    .select("*", { count: "exact", head: true })
    .like(column, value);
  if (error) throw new Error(`count_${table}_${column}_failed:${error.message}`);
  return count ?? 0;
}

async function listAllAuthUsers(admin) {
  const users = [];
  for (let page = 1; page <= AUTH_PAGE_LIMIT; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new Error(`list_auth_users_failed:${error.message}`);
    users.push(...(data.users ?? []));
    if ((data.users ?? []).length < 200) return users;
  }
  throw new Error("list_auth_users_page_limit_exceeded");
}

async function main() {
  const baseUrl = required("SAM23_UAT_BASE_URL").replace(/\/$/, "");
  const releaseSha = required("SAM23_RELEASE_SHA");
  const manifestPath = required("SAM23_RELEASE_MANIFEST");
  const projectRef = required("NEWME_STAGING_PROJECT_REF");
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");

  assert(
    process.env.SAM23_UAT_CONFIRM === CONFIRMATION,
    `confirmation_required:${CONFIRMATION}`,
  );
  assert(RELEASE_SHA_PATTERN.test(releaseSha), "invalid_release_sha");
  assert(baseUrl === STAGING_BASE_URL, `wrong_base_url:${baseUrl}`);
  assert(
    manifestPath === RELEASE_MANIFEST_PATH,
    `wrong_release_manifest:${manifestPath}`,
  );
  assert(projectRef === EXPECTED_PROJECT_REF, `wrong_project_ref:${projectRef}`);
  assert(
    supabaseUrl === STAGING_SUPABASE_URL,
    `wrong_supabase_url:${supabaseUrl}`,
  );

  const healthResponse = await fetch(`${baseUrl}/api/health`, {
    redirect: "manual",
  });
  const health = await healthResponse.json().catch(() => null);
  assert(healthResponse.status === 200, `health_http:${healthResponse.status}`);
  assert(health?.status === "ok", "health_status_not_ok");

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(manifest?.git_sha === releaseSha, `manifest_sha:${manifest?.git_sha}`);

  const admin = createSupabase(supabaseUrl, serviceRoleKey);
  const runId = randomUUID();
  const marker = `sam23-${releaseSha.slice(0, 8)}-${runId}`;
  const password = `Sam23-${randomUUID()}!aA1`;
  const userIds = [];
  const userEmails = [];
  const organizationIds = [];
  const membershipIds = [];
  const commercialIds = {
    leads: [],
    quotations: [],
    contracts: [],
    installment_plans: [],
    payments: [],
    contract_approvals: [],
    payment_allocations: [],
    projects: [],
    tasks: [],
    lead_documents: [],
  };
  const initializationKeys = [
    `${marker}:org-a`,
    `${marker}:org-b`,
  ];
  const cleanupCounts = {
    organizations: 0,
    memberships: 0,
    membership_roles: 0,
    provisioning_requests: 0,
    leads: 0,
    quotations: 0,
    contracts: 0,
    installment_plans: 0,
    payments: 0,
    contract_approvals: 0,
    payment_allocations: 0,
    projects: 0,
    tasks: 0,
    lead_documents: 0,
    activities: 0,
    business_events: 0,
    notifications: 0,
    follow_up_logs: 0,
    audit_events: 0,
    profiles: 0,
    auth_fixtures: 0,
  };
  const cleanupScopeCounts = {
    organizations_by_marker: 0,
    provisioning_by_idempotency: 0,
    leads_by_marker: 0,
    quotations_by_marker: 0,
    contracts_by_marker: 0,
    projects_by_marker: 0,
    tasks_by_marker: 0,
    lead_documents_by_marker: 0,
    auth_users_by_marker: 0,
  };
  const results = {};
  const cleanupErrors = [];
  let executionError = null;

  async function deleteIds(table, column, ids, label) {
    if (ids.length === 0) return;
    await requireDelete(
      admin.from(table).delete().in(column, ids),
      label,
    );
  }

  async function createUser(label, role) {
    const email = `${marker}-${label}@invalid.test`;
    trackUnique(userEmails, email);
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        fixture_scope: FIXTURE_SCOPE,
        fixture_kind: FIXTURE_KIND,
        run_id: runId,
        label,
      },
      user_metadata: { full_name: `Synthetic ${label}` },
    });
    if (error || !data.user || !exactAuthMarker(data.user, runId, email)) {
      throw new Error(`create_user_failed:${label}:${error?.message ?? "no_user"}`);
    }
    trackUnique(userIds, data.user.id);
    const { error: profileError } = await admin
      .from("profiles")
      .update({ role, is_active: true })
      .eq("id", data.user.id);
    if (profileError) {
      throw new Error(`profile_update_failed:${label}:${profileError.message}`);
    }
    return { id: data.user.id, email };
  }

  async function initializeOrganization(label, industryKey, ownerId) {
    const args = {
      p_idempotency_key: `${marker}:${label}`,
      p_slug: `${marker}-${label}`,
      p_name: `Synthetic ${label}`,
      p_industry_key: industryKey,
      p_plan_key: "starter",
      p_billable_seat_limit: 5,
      p_owner_user_id: ownerId,
    };
    const first = await admin.rpc("initialize_organization", args);
    if (first.error || !first.data?.organization_id) {
      throw new Error(
        `initialize_${label}_failed:${first.error?.message ?? "no_result"}`,
      );
    }
    trackUnique(organizationIds, first.data.organization_id);
    trackUnique(membershipIds, first.data.owner_membership_id);
    const replay = await admin.rpc("initialize_organization", args);
    if (replay.error) {
      throw new Error(`initialize_${label}_replay_failed:${replay.error.message}`);
    }
    assert(
      JSON.stringify(replay.data) === JSON.stringify(first.data),
      `initialize_${label}_not_idempotent`,
    );
    return { args, result: first.data };
  }

  async function createCommercialChain(label, organizationId, ownerId, amount) {
    const leadId = randomUUID();
    const quotationId = randomUUID();
    const contractId = randomUUID();
    const planId = randomUUID();
    const paymentId = randomUUID();
    const approvalId = randomUUID();
    const allocationId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const documentId = randomUUID();
    const suffix = label.toUpperCase();
    const values = {
      leads: leadId,
      quotations: quotationId,
      contracts: contractId,
      installment_plans: planId,
      payments: paymentId,
      contract_approvals: approvalId,
      payment_allocations: allocationId,
      projects: projectId,
      tasks: taskId,
      lead_documents: documentId,
    };
    for (const [table, id] of Object.entries(values)) {
      trackUnique(commercialIds[table], id);
    }

    await requireInsert(admin.from("leads").insert({
      id: leadId,
      organization_id: organizationId,
      source: "offline",
      customer_name: `${marker}-${label}-lead`,
      assigned_to: ownerId,
      created_by: ownerId,
      notes: marker,
    }), `lead_${label}`);
    await requireInsert(admin.from("quotations").insert({
      id: quotationId,
      lead_id: leadId,
      quote_no: `${marker}-QUOTE-${suffix}`,
      total_amount: amount,
      status: "accepted",
    }), `quotation_${label}`);
    await requireInsert(admin.from("contracts").insert({
      id: contractId,
      lead_id: leadId,
      quotation_id: quotationId,
      contract_no: `${marker}-CONTRACT-${suffix}`,
      contract_amount: amount,
      party_a_name: `Synthetic ${label}`,
      status: "active",
    }), `contract_${label}`);
    await requireDelete(
      admin.from("quotations").update({ contract_id: contractId }).eq("id", quotationId),
      `quotation_contract_${label}`,
    );
    await requireInsert(admin.from("installment_plans").insert({
      id: planId,
      contract_id: contractId,
      seq: 1,
      amount,
      due_date: new Date().toISOString().slice(0, 10),
    }), `plan_${label}`);
    await requireInsert(admin.from("payments").insert({
      id: paymentId,
      contract_id: contractId,
      installment_plan_id: planId,
      amount,
      confirmed: true,
    }), `payment_${label}`);
    await requireInsert(admin.from("contract_approvals").insert({
      id: approvalId,
      contract_id: contractId,
      step: "admin_review",
      status: "approved",
    }), `approval_${label}`);
    await requireInsert(admin.from("payment_allocations").insert({
      id: allocationId,
      payment_id: paymentId,
      plan_id: planId,
      amount_allocated: amount,
    }), `allocation_${label}`);
    await requireInsert(admin.from("projects").insert({
      id: projectId,
      name: `Synthetic project ${marker}-${label}`,
      lead_id: leadId,
      contract_id: contractId,
    }), `project_${label}`);
    await requireInsert(admin.from("tasks").insert({
      id: taskId,
      lead_id: leadId,
      title: `Synthetic task ${marker}-${label}`,
      assignee_id: ownerId,
    }), `task_${label}`);
    await requireInsert(admin.from("lead_documents").insert({
      id: documentId,
      lead_id: leadId,
      document_type: "contract",
      file_name: `${marker}-${label}.pdf`,
      file_url: `synthetic://${marker}/${label}/document`,
    }), `document_${label}`);

    return values;
  }

  async function recoverProvisioningFixtures() {
    const provisioning = await admin
      .from("organization_provisioning_requests")
      .select("idempotency_key, organization_id, owner_membership_id")
      .in("idempotency_key", initializationKeys);
    if (provisioning.error) {
      throw new Error(
        `recover_provisioning_failed:${provisioning.error.message}`,
      );
    }
    for (const row of provisioning.data ?? []) {
      trackUnique(organizationIds, row.organization_id);
      trackUnique(membershipIds, row.owner_membership_id);
    }
  }

  async function recoverAuthFixtures() {
    const expectedEmails = new Set(userEmails);
    const unexpected = [];
    for (const user of await listAllAuthUsers(admin)) {
      const metadata = user.app_metadata ?? {};
      const belongsToRun =
        metadata.fixture_scope === FIXTURE_SCOPE
        && metadata.fixture_kind === FIXTURE_KIND
        && metadata.run_id === runId;
      if (!belongsToRun) continue;
      trackUnique(userIds, user.id);
      if (
        !expectedEmails.has(user.email)
        || !exactAuthMarker(user, runId, user.email)
      ) {
        unexpected.push(user.id);
      }
    }
    assert(
      unexpected.length === 0,
      `unexpected_auth_fixtures:${unexpected.length}`,
    );
  }

  async function recoverCommercialFixtures() {
    const markerQueries = [
      ["leads", "notes", "eq", marker],
      ["quotations", "quote_no", "like", `${marker}-%`],
      ["contracts", "contract_no", "like", `${marker}-%`],
      ["projects", "name", "like", `%${marker}%`],
      ["tasks", "title", "like", `%${marker}%`],
      ["lead_documents", "file_name", "like", `${marker}-%`],
    ];
    const recoveryErrors = [];
    for (const [table, column, operation, value] of markerQueries) {
      let query = admin.from(table).select("id");
      query = operation === "eq"
        ? query.eq(column, value)
        : query.like(column, value);
      const { data, error } = await query;
      if (error) {
        recoveryErrors.push(`${table}:${error.message}`);
        continue;
      }
      for (const row of data ?? []) trackUnique(commercialIds[table], row.id);
    }
    if (recoveryErrors.length > 0) {
      throw new Error(`recover_commercial_failed:${recoveryErrors.join("|")}`);
    }
  }

  try {
    const [ownerA, ownerB, viewer] = await Promise.all([
      createUser("owner-a", "admin"),
      createUser("owner-b", "admin"),
      createUser("viewer-a", "designer"),
    ]);
    const initializedA = await initializeOrganization(
      "org-a",
      "real_estate",
      ownerA.id,
    );
    const initializedB = await initializeOrganization(
      "org-b",
      "retail",
      ownerB.id,
    );
    const organizationA = initializedA.result.organization_id;
    const organizationB = initializedB.result.organization_id;

    const mismatch = await admin.rpc("initialize_organization", {
      ...initializedA.args,
      p_name: "Synthetic changed name",
    });
    assert(
      mismatch.error?.message?.includes("organization_idempotency_payload_mismatch"),
      "initialization_payload_mismatch_not_rejected",
    );
    results.initialization = {
      organizations: 2,
      idempotentReplays: 2,
      payloadMismatchRejected: true,
    };

    const viewerMembershipId = randomUUID();
    trackUnique(membershipIds, viewerMembershipId);
    const viewerMembership = await requireInsert(admin.from("memberships").insert({
      id: viewerMembershipId,
      organization_id: organizationA,
      user_id: viewer.id,
      status: "active",
      accepted_at: new Date().toISOString(),
    }), "viewer_membership");
    trackUnique(membershipIds, viewerMembership.id);
    const viewerRole = await admin
      .from("roles")
      .select("id")
      .eq("scope", "organization")
      .eq("role_key", "viewer")
      .single();
    if (viewerRole.error || !viewerRole.data) {
      throw new Error(`viewer_role_failed:${viewerRole.error?.message ?? "missing"}`);
    }
    await requireInsert(admin.from("membership_roles").insert({
      membership_id: viewerMembership.id,
      role_id: viewerRole.data.id,
    }), "viewer_role_grant");

    const crossMembershipId = randomUUID();
    trackUnique(membershipIds, crossMembershipId);
    const crossMembership = await requireInsert(admin.from("memberships").insert({
      id: crossMembershipId,
      organization_id: organizationB,
      user_id: ownerA.id,
      status: "active",
      accepted_at: new Date().toISOString(),
    }), "cross_membership");
    trackUnique(membershipIds, crossMembership.id);
    const financeRole = await admin
      .from("roles")
      .select("id")
      .eq("scope", "organization")
      .eq("role_key", "finance")
      .single();
    if (financeRole.error || !financeRole.data) {
      throw new Error(`finance_role_failed:${financeRole.error?.message ?? "missing"}`);
    }
    await requireInsert(admin.from("membership_roles").insert({
      membership_id: crossMembership.id,
      role_id: financeRole.data.id,
    }), "cross_role_grant");

    const [seatA, seatB] = await Promise.all([
      admin.rpc("organization_billable_seat_count", {
        p_organization_id: organizationA,
      }),
      admin.rpc("organization_billable_seat_count", {
        p_organization_id: organizationB,
      }),
    ]);
    if (seatA.error || seatB.error) {
      throw new Error(
        `seat_count_failed:${seatA.error?.message ?? seatB.error?.message}`,
      );
    }
    assert(seatA.data === 1, `viewer_consumed_billable_seat:${seatA.data}`);
    assert(seatB.data === 2, `cross_org_seat_not_counted:${seatB.data}`);
    results.billableSeats = {
      organizationA: seatA.data,
      organizationB: seatB.data,
      viewerFree: true,
      sameUserCountedPerOrganization: true,
    };

    const [chainA, chainB] = await Promise.all([
      createCommercialChain("a", organizationA, ownerA.id, 1000),
      createCommercialChain("b", organizationB, ownerB.id, 2000),
    ]);

    const crossContractId = randomUUID();
    trackUnique(commercialIds.contracts, crossContractId);
    const crossContract = await admin.from("contracts").insert({
      id: crossContractId,
      lead_id: chainA.leads,
      quotation_id: chainB.quotations,
      contract_no: `${marker}-CROSS`,
      contract_amount: 1,
      party_a_name: "Forbidden",
    });
    assert(
      crossContract.error?.message?.includes("commercial_cross_organization_parent"),
      "cross_organization_contract_not_rejected",
    );
    const crossTaskId = randomUUID();
    trackUnique(commercialIds.tasks, crossTaskId);
    const crossTask = await admin.from("tasks").insert({
      id: crossTaskId,
      lead_id: chainA.leads,
      title: `Forbidden assignee ${marker}`,
      assignee_id: ownerB.id,
    });
    assert(
      crossTask.error?.message?.includes(
        "task_assignee_active_organization_membership_required",
      ),
      "cross_organization_task_assignee_not_rejected",
    );

    const [sessionA, sessionB] = await Promise.all([
      signIn(supabaseUrl, anonKey, ownerA.email, password, organizationA),
      signIn(supabaseUrl, anonKey, ownerB.email, password, organizationB),
    ]);
    const clientA = sessionA.client;
    const clientB = sessionB.client;
    for (const table of Object.keys(commercialIds)) {
      const [ownA, ownB, crossA, crossB] = await Promise.all([
        clientA.from(table).select("id").eq("id", chainA[table]).maybeSingle(),
        clientB.from(table).select("id").eq("id", chainB[table]).maybeSingle(),
        clientA.from(table).select("id").eq("id", chainB[table]).maybeSingle(),
        clientB.from(table).select("id").eq("id", chainA[table]).maybeSingle(),
      ]);
      for (const response of [ownA, ownB, crossA, crossB]) {
        if (response.error) {
          throw new Error(`rls_${table}_query_failed:${response.error.message}`);
        }
      }
      assert(ownA.data?.id === chainA[table], `rls_${table}_own_a_hidden`);
      assert(ownB.data?.id === chainB[table], `rls_${table}_own_b_hidden`);
      assert(crossA.data === null, `rls_${table}_cross_a_visible`);
      assert(crossB.data === null, `rls_${table}_cross_b_visible`);
    }

    const [summaryA, summaryB] = await Promise.all([
      clientA.from("v_sam23_organization_commercial_summary").select("*").single(),
      clientB.from("v_sam23_organization_commercial_summary").select("*").single(),
    ]);
    if (summaryA.error || summaryB.error) {
      throw new Error(
        `summary_failed:${summaryA.error?.message ?? summaryB.error?.message}`,
      );
    }
    assert(
      summaryA.data.organization_id === organizationA
        && summaryA.data.quotation_count === 1
        && summaryA.data.contract_count === 1
        && Number(summaryA.data.confirmed_payment_amount) === 1000
        && summaryA.data.project_count === 1
        && summaryA.data.task_count === 1
        && summaryA.data.document_count === 1,
      "summary_a_mismatch",
    );
    assert(
      summaryB.data.organization_id === organizationB
        && summaryB.data.quotation_count === 1
        && summaryB.data.contract_count === 1
        && Number(summaryB.data.confirmed_payment_amount) === 2000
        && summaryB.data.project_count === 1
        && summaryB.data.task_count === 1
        && summaryB.data.document_count === 1,
      "summary_b_mismatch",
    );

    const missingContext = createSupabase(supabaseUrl, anonKey, {
      Authorization: `Bearer ${sessionA.token}`,
    });
    const missingContextRows = await missingContext.from("contracts").select("id");
    assert(
      !missingContextRows.error && missingContextRows.data.length === 0,
      "missing_organization_context_exposed_contracts",
    );
    results.commercialBoundary = {
      tables: Object.keys(commercialIds).length,
      ownRowsVisible: Object.keys(commercialIds).length * 2,
      crossRowsHidden: Object.keys(commercialIds).length * 2,
      crossParentRejected: true,
      crossAssigneeRejected: true,
      missingContextHidden: true,
      reporting: "verified",
    };
  } catch (error) {
    executionError = error;
  } finally {
    const safely = async (label, operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(
          `${label}:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    await safely("recover_provisioning", recoverProvisioningFixtures);
    await safely("recover_auth", recoverAuthFixtures);
    await safely("recover_commercial", recoverCommercialFixtures);
    await safely("lead_documents", () =>
      deleteIds(
        "lead_documents", "id", commercialIds.lead_documents,
        "cleanup_lead_documents",
      ));
    await safely("tasks", () =>
      deleteIds("tasks", "id", commercialIds.tasks, "cleanup_tasks"));
    await safely("projects", () =>
      deleteIds("projects", "id", commercialIds.projects, "cleanup_projects"));
    await safely("payment_allocations", () =>
      deleteIds(
        "payment_allocations", "id", commercialIds.payment_allocations,
        "cleanup_payment_allocations",
      ));
    await safely("contract_approvals", () =>
      deleteIds(
        "contract_approvals", "id", commercialIds.contract_approvals,
        "cleanup_contract_approvals",
      ));
    await safely("payments", () =>
      deleteIds("payments", "id", commercialIds.payments, "cleanup_payments"));
    await safely("quotation_contract_links", () =>
      commercialIds.quotations.length === 0
        ? Promise.resolve()
        : requireDelete(
            admin
              .from("quotations")
              .update({ contract_id: null })
              .in("id", commercialIds.quotations),
            "cleanup_quotation_contract_links",
          ));
    await safely("installment_plans", () =>
      deleteIds(
        "installment_plans", "id", commercialIds.installment_plans,
        "cleanup_installment_plans",
      ));
    await safely("contracts", () =>
      deleteIds("contracts", "id", commercialIds.contracts, "cleanup_contracts"));
    await safely("quotations", () =>
      deleteIds(
        "quotations", "id", commercialIds.quotations, "cleanup_quotations",
      ));
    await safely("lead_children", async () => {
      if (commercialIds.leads.length === 0) return;
      for (const table of [
        "activities",
        "business_events",
        "notifications",
        "follow_up_logs",
      ]) {
        const column = table === "notifications" ? "related_id" : "lead_id";
        const response = await admin
          .from(table)
          .delete()
          .in(column, commercialIds.leads);
        if (response.error) {
          throw new Error(`cleanup_${table}_failed:${response.error.message}`);
        }
      }
    });
    await safely("leads", () =>
      deleteIds("leads", "id", commercialIds.leads, "cleanup_leads"));
    await safely("audit_events", () =>
      deleteIds(
        "audit_events", "organization_id", organizationIds,
        "cleanup_audit_events",
      ));
    await safely("provisioning_requests", () =>
      deleteIds(
        "organization_provisioning_requests",
        "idempotency_key",
        initializationKeys,
        "cleanup_provisioning_requests",
      ));
    await safely("membership_roles", () =>
      deleteIds(
        "membership_roles", "membership_id", membershipIds,
        "cleanup_membership_roles",
      ));
    await safely("memberships", () =>
      deleteIds(
        "memberships", "id", membershipIds, "cleanup_memberships",
      ));
    await safely("organizations", () =>
      deleteIds(
        "organizations", "id", organizationIds, "cleanup_organizations",
      ));
    for (const userId of userIds) {
      await safely(`auth_${userId}`, async () => {
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error) throw new Error(error.message);
      });
    }

    for (const [table, ids] of Object.entries(commercialIds)) {
      await safely(`verify_${table}`, async () => {
        cleanupCounts[table] = await exactCount(admin, table, "id", ids);
      });
    }
    for (const [table, column] of [
      ["activities", "lead_id"],
      ["business_events", "lead_id"],
      ["notifications", "related_id"],
      ["follow_up_logs", "lead_id"],
    ]) {
      await safely(`verify_${table}`, async () => {
        cleanupCounts[table] = await exactCount(
          admin,
          table,
          column,
          commercialIds.leads,
        );
      });
    }
    await safely("verify_membership_roles", async () => {
      cleanupCounts.membership_roles = await exactCount(
        admin,
        "membership_roles",
        "membership_id",
        membershipIds,
      );
    });
    await safely("verify_memberships", async () => {
      cleanupCounts.memberships = await exactCount(
        admin,
        "memberships",
        "id",
        membershipIds,
      );
    });
    await safely("verify_organizations", async () => {
      cleanupCounts.organizations = await exactCount(
        admin,
        "organizations",
        "id",
        organizationIds,
      );
    });
    await safely("verify_provisioning", async () => {
      cleanupCounts.provisioning_requests = await exactCount(
        admin,
        "organization_provisioning_requests",
        "idempotency_key",
        initializationKeys,
      );
    });
    await safely("verify_audit_events", async () => {
      cleanupCounts.audit_events = await exactCount(
        admin,
        "audit_events",
        "organization_id",
        organizationIds,
      );
    });
    await safely("verify_profiles", async () => {
      cleanupCounts.profiles = await exactCount(
        admin,
        "profiles",
        "id",
        userIds,
      );
    });
    await safely("verify_marker_organizations", async () => {
      cleanupScopeCounts.organizations_by_marker = await exactLikeCount(
        admin,
        "organizations",
        "slug",
        `${marker}-%`,
      );
    });
    await safely("verify_idempotency_requests", async () => {
      cleanupScopeCounts.provisioning_by_idempotency = await exactCount(
        admin,
        "organization_provisioning_requests",
        "idempotency_key",
        initializationKeys,
      );
    });
    for (const [key, table, column, operation, value] of [
      ["leads_by_marker", "leads", "notes", "eq", marker],
      ["quotations_by_marker", "quotations", "quote_no", "like", `${marker}-%`],
      ["contracts_by_marker", "contracts", "contract_no", "like", `${marker}-%`],
      ["projects_by_marker", "projects", "name", "like", `%${marker}%`],
      ["tasks_by_marker", "tasks", "title", "like", `%${marker}%`],
      [
        "lead_documents_by_marker",
        "lead_documents",
        "file_name",
        "like",
        `${marker}-%`,
      ],
    ]) {
      await safely(`verify_${key}`, async () => {
        cleanupScopeCounts[key] = operation === "eq"
          ? await exactEqCount(admin, table, column, value)
          : await exactLikeCount(admin, table, column, value);
      });
    }
    await safely("verify_auth_users", async () => {
      const users = await listAllAuthUsers(admin);
      const expectedIds = new Set(userIds);
      cleanupCounts.auth_fixtures = users.filter((user) =>
        expectedIds.has(user.id)
      ).length;
      cleanupScopeCounts.auth_users_by_marker = users.filter((user) => {
        const metadata = user.app_metadata ?? {};
        return metadata.fixture_scope === FIXTURE_SCOPE
          && metadata.fixture_kind === FIXTURE_KIND
          && metadata.run_id === runId;
      }).length;
    });
  }

  const residue = [
    ...Object.entries(cleanupCounts),
    ...Object.entries(cleanupScopeCounts),
  ].filter(([, count]) => count !== 0);
  if (executionError || cleanupErrors.length || residue.length) {
    throw new Error(JSON.stringify({
      execution: executionError instanceof Error
        ? executionError.message
        : executionError,
      cleanupErrors,
      residue,
    }));
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    issue: "SAM-23",
    releaseSha,
    projectRef,
    marker,
    results,
    cleanup: "verified",
    cleanupCounts,
    cleanupScopeCounts,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `SAM23_UAT_FAIL_CLOSED:${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
