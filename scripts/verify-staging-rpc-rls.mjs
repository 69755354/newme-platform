#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const expectedRef = process.env.NEWME_STAGING_PROJECT_REF?.trim();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const secretKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!/^[a-z]{20}$/.test(expectedRef ?? "")) {
  throw new Error("NEWME_STAGING_PROJECT_REF must be an explicit 20-character ref");
}
if (new URL(supabaseUrl).hostname !== `${expectedRef}.supabase.co`) {
  throw new Error("Supabase URL does not match the explicit staging project ref");
}
if (!publishableKey || !secretKey?.startsWith("sb_secret_")) {
  throw new Error("staging publishable and secret keys are required");
}
if (publishableKey === secretKey) {
  throw new Error("publishable and secret keys must be different");
}

const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const userIds = [];
const leadIds = [];
const users = new Map();
const results = [];

class HttpError extends Error {
  constructor(message, status, payload) {
    super(`${message}: HTTP ${status} ${JSON.stringify(payload)}`);
    this.name = "HttpError";
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, {
  method = "GET",
  body,
  token,
  service = false,
  prefer,
} = {}) {
  const key = service ? secretKey : publishableKey;
  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new HttpError(`${method} ${path}`, response.status, payload);
  }
  return payload;
}

function restPath(table, query = "") {
  return `/rest/v1/${table}${query ? `?${query}` : ""}`;
}

async function serviceRows(table, query) {
  return request(restPath(table, query), { service: true });
}

async function createUser(role, label = role) {
  const email = `codex-uat-${runId}-${label}@example.test`;
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const created = await request("/auth/v1/admin/users", {
    method: "POST",
    service: true,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `[UAT] ${label} ${runId}` },
    },
  });
  assert.match(created.id, /^[0-9a-f-]{36}$/i);
  userIds.push(created.id);
  await request(restPath("profiles", `id=eq.${created.id}`), {
    method: "PATCH",
    service: true,
    prefer: "return=representation",
    body: {
      role,
      full_name: `[UAT] ${label} ${runId}`,
      email,
      is_active: true,
    },
  });
  const session = await request("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });
  assert.ok(session.access_token);
  const value = { id: created.id, email, token: session.access_token, role };
  users.set(role, value);
  return value;
}

async function createLead(owner, label) {
  const rows = await request(restPath("leads"), {
    method: "POST",
    service: true,
    prefer: "return=representation",
    body: {
      source: "other",
      customer_name: `[UAT ${runId}] ${label}`,
      assigned_to: owner.id,
      created_by: owner.id,
    },
  });
  assert.equal(rows.length, 1);
  leadIds.push(rows[0].id);
  return rows[0];
}

async function userRows(user, table, query) {
  return request(restPath(table, query), { token: user.token });
}

async function rpc(user, name, body) {
  return request(`/rest/v1/rpc/${name}`, {
    method: "POST",
    token: user.token,
    body,
  });
}

async function expectForbidden(label, operation, expectedText) {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof HttpError, `${label} must fail through the API`);
    if (expectedText) {
      assert.match(JSON.stringify(error.payload), new RegExp(expectedText, "i"));
    }
    results.push({ check: label, status: "pass", http_status: error.status });
    return;
  }
  assert.fail(`${label} unexpectedly succeeded`);
}

async function expectConcurrentReplay(label, count, operation) {
  const responses = await Promise.all(
    Array.from({ length: count }, () => operation()),
  );
  assert.equal(
    responses.filter((value) => value.idempotent_replay === true).length,
    count - 1,
    `${label} must produce one mutation and ${count - 1} replays`,
  );
  results.push({ check: label, status: "pass", calls: count, replays: count - 1 });
  return responses;
}

async function deleteWhere(table, column, value) {
  await request(restPath(table, `${column}=eq.${encodeURIComponent(value)}`), {
    method: "DELETE",
    service: true,
  });
}

async function cleanup() {
  const dependentUserTables = [
    ["notifications", "user_id"],
    ["business_events", "user_id"],
    ["activities", "user_id"],
    ["follow_up_logs", "user_id"],
    ["activity_logs", "user_id"],
    ["user_session_daily", "user_id"],
    ["audit_logs", "actor_id"],
    ["lead_mutation_requests", "actor_id"],
    ["lead_deletion_requests", "actor_id"],
    ["transfer_history", "from_user_id"],
    ["transfer_history", "to_user_id"],
    ["transfer_history", "transferred_by"],
  ];
  const dependentLeadTables = [
    ["notifications", "related_id"],
    ["business_events", "lead_id"],
    ["activities", "lead_id"],
    ["follow_up_logs", "lead_id"],
    ["lead_mutation_requests", "lead_id"],
    ["lead_deletion_requests", "deleted_lead_id"],
    ["transfer_history", "lead_id"],
    ["audit_logs", "target_id"],
  ];

  for (const id of leadIds) {
    for (const [table, column] of dependentLeadTables) {
      await deleteWhere(table, column, id).catch(() => {});
    }
  }
  for (const id of userIds) {
    for (const [table, column] of dependentUserTables) {
      await deleteWhere(table, column, id).catch(() => {});
    }
  }
  for (const id of leadIds) {
    await deleteWhere("leads", "id", id).catch(() => {});
  }
  for (const id of userIds.reverse()) {
    await request(`/auth/v1/admin/users/${id}`, {
      method: "DELETE",
      service: true,
    }).catch(() => {});
  }
}

async function verifyCleanup() {
  const remainingProfiles = [];
  for (const id of userIds) {
    remainingProfiles.push(...await serviceRows("profiles", `select=id&id=eq.${id}`));
  }
  const remainingLeads = [];
  for (const id of leadIds) {
    remainingLeads.push(...await serviceRows("leads", `select=id&id=eq.${id}`));
  }
  assert.deepEqual(remainingProfiles, []);
  assert.deepEqual(remainingLeads, []);
}

async function main() {
  try {
    const admin = await createUser("admin");
    const boss = await createUser("boss");
    const operator = await createUser("operator");
    const salesA = await createUser("sales", "sales-a");
    const salesB = await createUser("sales", "sales-b");
    const finance = await createUser("finance");
    const designer = await createUser("designer");

    const leadA = await createLead(salesA, "lead A");
    const leadB = await createLead(salesB, "lead B");

    const expectedLeadCounts = new Map([
      [admin, 2],
      [boss, 2],
      [operator, 2],
      [salesA, 1],
      [salesB, 1],
      [finance, 0],
      [designer, 0],
    ]);
    for (const [user, expected] of expectedLeadCounts) {
      const rows = await userRows(
        user,
        "leads",
        `select=id,assigned_to&id=in.(${leadA.id},${leadB.id})`,
      );
      assert.equal(rows.length, expected, `${user.role} lead visibility mismatch`);
    }
    results.push({ check: "JWT/RLS lead visibility matrix", status: "pass" });

    const expectedProfileAccess = new Map([
      [admin, 7],
      [boss, 7],
      [operator, 7],
      [salesA, 1],
      [salesB, 1],
      [finance, 1],
      [designer, 1],
    ]);
    for (const [user, minimum] of expectedProfileAccess) {
      const ids = userIds.join(",");
      const rows = await userRows(user, "profiles", `select=id&id=in.(${ids})`);
      assert.equal(rows.length, minimum, `${user.role} profile visibility mismatch`);
    }
    results.push({ check: "JWT/RLS profile visibility matrix", status: "pass" });

    const forgedTransfer = {
      lead_id: leadA.id,
      from_user_id: salesA.id,
      to_user_id: salesB.id,
      transferred_by: admin.id,
      reason: `forged-${runId}`,
    };
    for (const user of [admin, boss, operator, salesA, finance, designer]) {
      await expectForbidden(
        `${user.role} cannot forge transfer_history`,
        () => request(restPath("transfer_history"), {
          method: "POST",
          token: user.token,
          body: forgedTransfer,
        }),
      );
    }

    for (const user of [salesA, finance, designer]) {
      await expectForbidden(
        `${user.role} cannot call reassign_lead_atomic`,
        () => rpc(user, "reassign_lead_atomic", {
          p_lead_id: leadB.id,
          p_new_assignee: salesA.id,
          p_expected_updated_at: leadB.updated_at,
          p_idempotency_key: randomUUID(),
          p_reason: "uat-forbidden",
        }),
        "FORBIDDEN_REASSIGNMENT",
      );
    }

    const failureKey = randomUUID();
    const beforeFailure = {
      lead: (await serviceRows("leads", `select=id,assigned_to,updated_at&id=eq.${leadB.id}`))[0],
      requests: (await serviceRows("lead_mutation_requests", `select=id&actor_id=eq.${admin.id}&idempotency_key=eq.${failureKey}`)).length,
      transfers: (await serviceRows("transfer_history", `select=id&lead_id=eq.${leadB.id}`)).length,
    };
    await expectForbidden(
      "invalid reassignment is atomic",
      () => rpc(admin, "reassign_lead_atomic", {
        p_lead_id: leadB.id,
        p_new_assignee: randomUUID(),
        p_expected_updated_at: leadB.updated_at,
        p_idempotency_key: failureKey,
        p_reason: "uat-invalid-assignee",
      }),
      "INVALID_ASSIGNEE",
    );
    const afterFailure = {
      lead: (await serviceRows("leads", `select=id,assigned_to,updated_at&id=eq.${leadB.id}`))[0],
      requests: (await serviceRows("lead_mutation_requests", `select=id&actor_id=eq.${admin.id}&idempotency_key=eq.${failureKey}`)).length,
      transfers: (await serviceRows("transfer_history", `select=id&lead_id=eq.${leadB.id}`)).length,
    };
    assert.deepEqual(afterFailure, beforeFailure);

    const reassignKey = randomUUID();
    await expectConcurrentReplay(
      "reassign_lead_atomic concurrent idempotency",
      8,
      () => rpc(admin, "reassign_lead_atomic", {
        p_lead_id: leadA.id,
        p_new_assignee: salesB.id,
        p_expected_updated_at: leadA.updated_at,
        p_idempotency_key: reassignKey,
        p_reason: `uat-${runId}`,
      }),
    );
    assert.equal(
      (await serviceRows("lead_mutation_requests", `select=id&actor_id=eq.${admin.id}&operation=eq.lead_reassignment&idempotency_key=eq.${reassignKey}`)).length,
      1,
    );
    assert.equal(
      (await serviceRows("transfer_history", `select=id&lead_id=eq.${leadA.id}`)).length,
      1,
    );

    for (const [manager, label] of [[boss, "boss"], [operator, "operator"]]) {
      const lead = await createLead(salesA, `${label} reassign`);
      await rpc(manager, "reassign_lead_atomic", {
        p_lead_id: lead.id,
        p_new_assignee: salesB.id,
        p_expected_updated_at: lead.updated_at,
        p_idempotency_key: randomUUID(),
        p_reason: `uat-${label}`,
      });
    }
    results.push({ check: "admin/boss/operator reassignment matrix", status: "pass" });

    const noteKey = randomUUID();
    await expectConcurrentReplay(
      "record_lead_note_atomic concurrent idempotency",
      8,
      () => rpc(salesB, "record_lead_note_atomic", {
        p_lead_id: leadB.id,
        p_note: `UAT note ${runId}`,
        p_idempotency_key: noteKey,
      }),
    );
    assert.equal(
      (await serviceRows("follow_up_logs", `select=id&lead_id=eq.${leadB.id}&contact_type=eq.note`)).length,
      1,
    );
    await expectForbidden(
      "sales cannot note another owner's lead",
      () => rpc(salesA, "record_lead_note_atomic", {
        p_lead_id: leadB.id,
        p_note: `forbidden ${runId}`,
        p_idempotency_key: randomUUID(),
      }),
      "FORBIDDEN_NOTE",
    );
    for (const user of [finance, designer]) {
      await expectForbidden(
        `${user.role} cannot record lead notes`,
        () => rpc(user, "record_lead_note_atomic", {
          p_lead_id: leadB.id,
          p_note: `forbidden ${runId}`,
          p_idempotency_key: randomUUID(),
        }),
        "FORBIDDEN_NOTE",
      );
    }

    const contactKey = randomUUID();
    const contactFingerprint = `uat-${runId}-${randomUUID()}`;
    await expectConcurrentReplay(
      "record_lead_contact_atomic concurrent idempotency",
      8,
      () => rpc(salesB, "record_lead_contact_atomic", {
        p_lead_id: leadB.id,
        p_contact_method: "phone",
        p_contact_time: new Date(Date.now() - 1000).toISOString(),
        p_contact_result: "UAT reached customer",
        p_summary: `UAT contact ${runId}`,
        p_contact_fingerprint: contactFingerprint,
        p_idempotency_key: contactKey,
      }),
    );
    assert.equal(
      (await serviceRows("follow_up_logs", `select=id&contact_fingerprint=eq.${encodeURIComponent(contactFingerprint)}`)).length,
      1,
    );

    const deleteLead = await createLead(salesA, "concurrent delete");
    await expectForbidden(
      "sales cannot delete another owner's lead",
      () => rpc(salesB, "delete_lead_atomic", {
        p_lead_id: deleteLead.id,
        p_idempotency_key: randomUUID(),
      }),
      "FORBIDDEN_LEAD_DELETE",
    );
    for (const user of [operator, finance, designer]) {
      await expectForbidden(
        `${user.role} cannot delete leads`,
        () => rpc(user, "delete_lead_atomic", {
          p_lead_id: deleteLead.id,
          p_idempotency_key: randomUUID(),
        }),
        "FORBIDDEN_LEAD_DELETE",
      );
    }
    const deleteKey = randomUUID();
    await expectConcurrentReplay(
      "delete_lead_atomic concurrent idempotency",
      8,
      () => rpc(salesA, "delete_lead_atomic", {
        p_lead_id: deleteLead.id,
        p_idempotency_key: deleteKey,
      }),
    );
    assert.equal(
      (await serviceRows("leads", `select=id&id=eq.${deleteLead.id}`)).length,
      0,
    );
    assert.equal(
      (await serviceRows("lead_deletion_requests", `select=id&actor_id=eq.${salesA.id}&idempotency_key=eq.${deleteKey}`)).length,
      1,
    );

    for (const manager of [admin, boss]) {
      const lead = await createLead(salesA, `${manager.role} delete`);
      await rpc(manager, "delete_lead_atomic", {
        p_lead_id: lead.id,
        p_idempotency_key: randomUUID(),
      });
    }
    results.push({ check: "admin/boss/sales delete matrix", status: "pass" });

    const transferRows = await userRows(
      finance,
      "transfer_history",
      `select=id,lead_id&lead_id=in.(${leadIds.join(",")})`,
    );
    assert.ok(transferRows.length >= 3);
    results.push({ check: "read-only transfer audit remains visible", status: "pass" });
  } finally {
    await cleanup();
    await verifyCleanup();
  }

  console.log(JSON.stringify({
    ok: true,
    project_ref: expectedRef,
    run_id: runId,
    checks: results,
    cleanup: "verified",
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    project_ref: expectedRef,
    run_id: runId,
    error: error.message,
    checks: results,
  }, null, 2));
  process.exitCode = 1;
});
