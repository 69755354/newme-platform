import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks = {}) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "server-only") return {};
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

const IDs = {
  actor: "11111111-1111-4111-8111-111111111111",
  admin: "22222222-2222-4222-8222-222222222222",
  assignee: "33333333-3333-4333-8333-333333333333",
  unrelated: "44444444-4444-4444-8444-444444444444",
  lead: "55555555-5555-4555-8555-555555555555",
  quote: "66666666-6666-4666-8666-666666666666",
  installment: "77777777-7777-4777-8777-777777777777",
  contract: "88888888-8888-4888-8888-888888888888",
  target: "99999999-9999-4999-8999-999999999999",
  kpi: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  payment: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  approval: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

class Query {
  constructor(rows) {
    this.rows = rows.map((row) => ({ ...row }));
  }
  select() { return this; }
  eq(field, value) { this.rows = this.rows.filter((row) => row[field] === value); return this; }
  neq(field, value) { this.rows = this.rows.filter((row) => row[field] !== value); return this; }
  in(field, values) { this.rows = this.rows.filter((row) => values.includes(row[field])); return this; }
  order(field, options = {}) {
    const direction = options.ascending === false ? -1 : 1;
    this.rows.sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * direction);
    return this;
  }
  limit(value) { this.rows = this.rows.slice(0, value); return this; }
  async maybeSingle() { return { data: this.rows[0] ?? null, error: null }; }
  then(resolve, reject) { return Promise.resolve({ data: this.rows, error: null }).then(resolve, reject); }
}

class FakeDb {
  constructor(tables) { this.tables = tables; }
  from(table) { return new Query(this.tables[table] ?? []); }
}

function fixtures(overrides = {}) {
  return {
    profiles: [
      { id: IDs.actor, role: "sales", is_active: true },
      { id: IDs.admin, role: "admin", is_active: true },
      { id: IDs.assignee, role: "sales", is_active: true },
      { id: IDs.unrelated, role: "sales", is_active: true },
      { id: IDs.target, role: "sales", is_active: true },
    ],
    leads: [{
      id: IDs.lead,
      customer_name: "Database Customer",
      assigned_to: IDs.assignee,
      created_by: IDs.actor,
      stage: "new",
      stage_changed_at: "2026-08-14T10:00:00Z",
    }],
    quotations: [{
      id: IDs.quote,
      quote_no: "Q-DB-100",
      total_amount: 125000,
      created_by: IDs.actor,
      lead_id: IDs.lead,
    }],
    installment_plans: [{
      id: IDs.installment,
      amount: 5000,
      contract_id: IDs.contract,
      due_date: "2026-08-20",
      status: "pending",
    }],
    contracts: [{ id: IDs.contract, contract_no: "C-DB-1", sales_id: IDs.assignee }],
    payments: [{
      id: IDs.payment,
      amount: 5000,
      contract_id: IDs.contract,
      confirmed: true,
      confirmed_by: IDs.admin,
      created_by: IDs.actor,
      voided_at: null,
    }],
    kpi_targets: [{
      id: IDs.kpi,
      period: "2026-08",
      assigned_to: IDs.target,
      target_type: "revenue",
      target_amount: 750000,
      set_by: IDs.admin,
    }],
    ...overrides,
  };
}

const events = loadTypeScriptModule("src/lib/notification-events.ts");
const notificationConstants = loadTypeScriptModule("src/lib/notifications.ts", {
  "./supabase-admin": { supabaseAdmin: {} },
});

test("lead_created derives copy and recipients from the database, not legacy client extras", async () => {
  const drafts = await events.deriveNotificationDispatch({
    db: new FakeDb(fixtures()),
    actor: { id: IDs.actor, role: "sales", fullName: "Actual Actor" },
    input: {
      type: "lead_created",
      lead_id: IDs.lead,
      customer_name: "FORGED CUSTOMER",
      assigned_to: IDs.unrelated,
    },
  });

  assert.deepEqual(drafts.map((row) => row.userId).sort(), [IDs.admin, IDs.assignee].sort());
  assert.equal(drafts.every((row) => row.title.includes("Database Customer")), true);
  assert.equal(drafts.some((row) => JSON.stringify(row).includes("FORGED")), false);
  assert.equal(drafts.every((row) => row.eventKey === `lead_created:${IDs.lead}`), true);
});

test("presentation and direct recipient fields fail closed before database access", async () => {
  const db = { from() { throw new Error("database should not be read"); } };
  await assert.rejects(
    () => events.deriveNotificationDispatch({
      db,
      actor: { id: IDs.actor, role: "sales", fullName: "Actor" },
      input: { type: "lead_created", lead_id: IDs.lead, title: "Forged", target_user_id: IDs.unrelated },
    }),
    (error) => error.code === "client_notification_content_forbidden" && error.status === 400,
  );
});

test("the public notification endpoint rejects lead_assigned before event resolution", async () => {
  let resolved = false;
  let persisted = false;
  class MockAuthError extends Error {}
  const route = loadTypeScriptModule("src/app/api/notify/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_context, response) => response,
      getRequestAuthContext: async () => ({
        user: { id: IDs.unrelated }, role: "operator",
        profile: { full_name: "Operator", email: "operator@example.com" }, refreshedCookies: [],
      }),
      RequestAuthError: MockAuthError,
      requestAuthErrorResponse: () => Response.json({ error: "unauthorized" }, { status: 401 }),
    },
    "@/lib/notification-events": {
      deriveNotificationDispatch: async () => { resolved = true; return []; },
    },
    "@/lib/notifications": {
      VALID_NOTIFICATION_TYPES: notificationConstants.VALID_NOTIFICATION_TYPES,
      createNotificationsBulk: async () => { persisted = true; return { created: 0, skipped: 0 }; },
    },
    "@/lib/supabase-admin": { supabaseAdmin: {} },
  });

  const response = await route.POST(new Request("https://app.newme.ae/api/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "lead_assigned", lead_id: IDs.lead }),
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_notification_type");
  assert.equal(resolved, false);
  assert.equal(persisted, false);
});

test("quote_created refuses a non-owner and does not emit notifications", async () => {
  await assert.rejects(
    () => events.deriveNotificationDispatch({
      db: new FakeDb(fixtures()),
      actor: { id: IDs.unrelated, role: "sales", fullName: "Other Sales" },
      input: { type: "quote_created", quote_id: IDs.quote },
    }),
    (error) => error.code === "notification_forbidden" && error.status === 403,
  );
});

test("payment_overdue requires finance authority and an actually overdue installment", async () => {
  await assert.rejects(
    () => events.deriveNotificationDispatch({
      db: new FakeDb(fixtures()),
      actor: { id: IDs.actor, role: "sales", fullName: "Sales" },
      input: { type: "payment_overdue", installment_id: IDs.installment },
      now: new Date("2026-08-14T12:00:00Z"),
    }),
    (error) => error.code === "notification_forbidden" && error.status === 403,
  );

  await assert.rejects(
    () => events.deriveNotificationDispatch({
      db: new FakeDb(fixtures()),
      actor: { id: IDs.admin, role: "admin", fullName: "Admin" },
      input: { type: "payment_overdue", installment_id: IDs.installment, amount: 999999 },
      now: new Date("2026-08-14T12:00:00Z"),
    }),
    (error) => error.code === "installment_is_not_overdue" && error.status === 409,
  );
});

test("payment_received rejects a voided row even if its legacy confirmed flag is still true", async () => {
  const tables = fixtures();
  tables.payments[0].voided_at = "2026-08-14T12:00:00Z";
  await assert.rejects(
    () => events.deriveNotificationDispatch({
      db: new FakeDb(tables),
      actor: { id: IDs.admin, role: "admin", fullName: "Admin" },
      input: { type: "payment_received", payment_id: IDs.payment },
    }),
    (error) => error.code === "payment_is_not_confirmed" && error.status === 409,
  );
});

test("kpi_target_set uses the persisted amount and persisted recipient", async () => {
  const drafts = await events.deriveNotificationDispatch({
    db: new FakeDb(fixtures()),
    actor: { id: IDs.admin, role: "admin", fullName: "Admin" },
    input: {
      type: "kpi_target_set",
      period: "2026-08",
      assigned_to: IDs.target,
      target_type: "revenue",
      target_amount: 1,
    },
  });
  assert.deepEqual(drafts.map((row) => row.userId), [IDs.target]);
  assert.equal(drafts[0].body, "revenue: AED 750,000");
  assert.equal(drafts[0].relatedId, IDs.kpi);
  assert.equal(drafts[0].eventKey, `kpi_target_set:${IDs.kpi}`);
});

test("kpi_target_set refuses the read-only operator role", async () => {
  await assert.rejects(
    () => events.deriveNotificationDispatch({
      db: new FakeDb(fixtures()),
      actor: { id: IDs.unrelated, role: "operator", fullName: "Operator" },
      input: {
        type: "kpi_target_set",
        period: "2026-08",
        assigned_to: IDs.target,
        target_type: "revenue",
      },
    }),
    (error) => error.code === "notification_forbidden" && error.status === 403,
  );
});

test("a human first-payment reminder remains a repeatable intent", async () => {
  const drafts = await events.deriveNotificationDispatch({
    db: new FakeDb(fixtures({
      contracts: [{
        id: IDs.contract,
        contract_no: "C-DB-1",
        contract_amount: 850000,
        party_a_name: "Database Customer",
        first_payment_status: "unpaid",
        first_payment_due_date: "2026-08-13",
        sales_id: IDs.assignee,
      }],
    })),
    actor: { id: IDs.admin, role: "admin", fullName: "Admin" },
    input: { type: "first_payment_reminder", contract_id: IDs.contract },
    now: new Date("2026-08-14T12:00:00Z"),
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].eventKey, undefined);
});

test("/api/notify rejects client copy and never calls persistence", async () => {
  const writes = [];
  class MockAuthError extends Error {}
  const authContext = {
    user: { id: IDs.actor },
    role: "sales",
    profile: { full_name: "Actual Actor", email: "actor@example.com" },
    refreshedCookies: [],
  };
  const route = loadTypeScriptModule("src/app/api/notify/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_context, response) => response,
      getRequestAuthContext: async () => authContext,
      RequestAuthError: MockAuthError,
      requestAuthErrorResponse: () => Response.json({ error: "unauthorized" }, { status: 401 }),
    },
    "@/lib/notification-events": events,
    "@/lib/notifications": {
      VALID_NOTIFICATION_TYPES: notificationConstants.VALID_NOTIFICATION_TYPES,
      createNotificationsBulk: async (drafts) => { writes.push(...drafts); return { created: drafts.length, skipped: 0 }; },
    },
    "@/lib/supabase-admin": { supabaseAdmin: new FakeDb(fixtures()) },
  });

  const response = await route.POST(new Request("https://app.newme.ae/api/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "lead_created", lead_id: IDs.lead, body: "FORGED BODY" }),
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "client_notification_content_forbidden");
  assert.equal(writes.length, 0);
});

test("/api/notify persists only database-derived lead notifications", async () => {
  const writes = [];
  class MockAuthError extends Error {}
  const route = loadTypeScriptModule("src/app/api/notify/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_context, response) => response,
      getRequestAuthContext: async () => ({
        user: { id: IDs.actor }, role: "sales",
        profile: { full_name: "Actual Actor", email: "actor@example.com" }, refreshedCookies: [],
      }),
      RequestAuthError: MockAuthError,
      requestAuthErrorResponse: () => Response.json({ error: "unauthorized" }, { status: 401 }),
    },
    "@/lib/notification-events": events,
    "@/lib/notifications": {
      VALID_NOTIFICATION_TYPES: notificationConstants.VALID_NOTIFICATION_TYPES,
      createNotificationsBulk: async (drafts) => { writes.push(...drafts); return { created: drafts.length, skipped: 0 }; },
    },
    "@/lib/supabase-admin": { supabaseAdmin: new FakeDb(fixtures()) },
  });

  const response = await route.POST(new Request("https://app.newme.ae/api/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "lead_created", lead_id: IDs.lead,
      customer_name: "FORGED", assigned_to: IDs.unrelated,
    }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(writes.map((row) => row.userId).sort(), [IDs.admin, IDs.assignee].sort());
  assert.equal(writes.every((row) => row.title === "New lead: Database Customer"), true);
});

test("/api/notify rejects an oversized body before event resolution", async () => {
  let resolved = false;
  class MockAuthError extends Error {}
  class MockDispatchError extends Error {}
  const route = loadTypeScriptModule("src/app/api/notify/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_context, response) => response,
      getRequestAuthContext: async () => ({
        user: { id: IDs.actor }, role: "sales",
        profile: { full_name: "Actor", email: "actor@example.com" }, refreshedCookies: [],
      }),
      RequestAuthError: MockAuthError,
      requestAuthErrorResponse: () => Response.json({ error: "unauthorized" }, { status: 401 }),
    },
    "@/lib/notification-events": {
      NotificationDispatchError: MockDispatchError,
      deriveNotificationDispatch: async () => { resolved = true; return []; },
    },
    "@/lib/notifications": {
      VALID_NOTIFICATION_TYPES: notificationConstants.VALID_NOTIFICATION_TYPES,
      createNotificationsBulk: async () => ({ created: 0, skipped: 0 }),
    },
    "@/lib/supabase-admin": { supabaseAdmin: {} },
  });
  const response = await route.POST(new Request("https://app.newme.ae/api/notify", {
    method: "POST",
    body: JSON.stringify({ type: "lead_created", lead_id: IDs.lead, padding: "x".repeat(5_000) }),
  }));
  assert.equal(response.status, 413);
  assert.equal(resolved, false);
});

test("server-side business dispatch re-reads the actor and committed contract", async () => {
  const writes = [];
  const db = new FakeDb(fixtures({
    contracts: [{
      id: IDs.contract,
      contract_no: "C-DB-1",
      contract_amount: 850000,
      created_by: IDs.actor,
      sales_id: IDs.actor,
      status: "pending_admin",
    }],
    contract_approvals: [{
      id: IDs.approval,
      contract_id: IDs.contract,
      status: "pending",
      created_at: "2026-08-14T10:00:00Z",
    }],
  }));
  const dispatcher = loadTypeScriptModule("src/lib/notification-dispatch.ts", {
    "@/lib/supabase-admin": { supabaseAdmin: db },
    "@/lib/notification-events": events,
    "@/lib/notifications": {
      createNotificationsBulk: async (drafts) => {
        writes.push(...drafts);
        return { created: drafts.length, skipped: 0 };
      },
    },
  });

  const result = await dispatcher.dispatchPersistedNotification({
    actorId: IDs.actor,
    input: {
      type: "contract_pending_approval",
      contract_id: IDs.contract,
      amount: 1,
      contract_no: "FORGED",
    },
    db,
  });
  assert.deepEqual(result, { created: 1, skipped: 0 });
  assert.deepEqual(writes.map((row) => row.userId), [IDs.admin]);
  assert.equal(writes[0].title, "Contract pending approval: C-DB-1");
  assert.equal(writes[0].body.includes("850,000"), true);
  assert.equal(writes[0].eventKey, `contract_pending_approval:${IDs.approval}`);
  assert.equal(JSON.stringify(writes).includes("FORGED"), false);
});

function notificationStore({ existing = [], insertError = null } = {}) {
  const inserted = existing.map((row) => ({ ...row }));
  return {
    inserted,
    client: {
      async rpc(name, args) {
        assert.equal(name, "insert_notifications_atomic");
        if (insertError) return { data: null, error: insertError };
        let created = 0;
        let skipped = 0;
        for (const row of args.p_notifications) {
          const replay = row.event_key == null
            ? null
            : inserted.find((candidate) => candidate.user_id === row.user_id && candidate.event_key === row.event_key);
          if (replay) {
            skipped += 1;
          } else {
            inserted.push({ ...row });
            created += 1;
          }
        }
        return { data: { created, skipped }, error: null };
      },
    },
  };
}

test("notification persistence helpers reject instead of resolving after database failures", async () => {
  const store = notificationStore({ insertError: { code: "XX000", message: "write failed" } });
  const notifications = loadTypeScriptModule("src/lib/notifications.ts", {
    "./supabase-admin": { supabaseAdmin: store.client },
  });
  await assert.rejects(
    () => notifications.createNotification({
      userId: IDs.admin,
      type: "lead_created",
      title: "Database Customer",
      relatedId: IDs.lead,
      relatedType: "lead",
    }),
    /notification_insert_failed/,
  );
});

test("notification persistence suppresses a replay of the same occurrence key", async () => {
  const eventKey = `lead_created:${IDs.lead}`;
  const existing = [{ user_id: IDs.admin, type: "lead_created", related_id: IDs.lead, title: "New lead: Database Customer", body: null, event_key: eventKey }];
  const store = notificationStore({ existing });
  const notifications = loadTypeScriptModule("src/lib/notifications.ts", {
    "./supabase-admin": { supabaseAdmin: store.client },
  });
  const result = await notifications.createNotification({
    userId: IDs.admin,
    type: "lead_created",
    title: "New lead: Database Customer",
    relatedId: IDs.lead,
    relatedType: "lead",
    eventKey,
  });
  assert.deepEqual(result, { created: 0, skipped: 1 });
  assert.equal(store.inserted.length, 1);
});

test("notification persistence does not suppress a new fact with a changed body", async () => {
  const existing = [{
    user_id: IDs.target,
    type: "kpi_target_set",
    related_id: IDs.kpi,
    title: "KPI target set for 2026-08",
    body: "revenue: AED 100",
  }];
  const store = notificationStore({ existing });
  const notifications = loadTypeScriptModule("src/lib/notifications.ts", {
    "./supabase-admin": { supabaseAdmin: store.client },
  });
  const result = await notifications.createNotification({
    userId: IDs.target,
    type: "kpi_target_set",
    title: "KPI target set for 2026-08",
    body: "revenue: AED 200",
    relatedId: IDs.kpi,
    relatedType: "kpi",
  });
  assert.deepEqual(result, { created: 1, skipped: 0 });
  assert.equal(store.inserted.length, 2);
  assert.equal(store.inserted[1].body, "revenue: AED 200");
});

test("client notify rejects HTTP and network failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const notifyModule = loadTypeScriptModule("src/lib/notify.ts");
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "notification_unavailable" }),
    });
    await assert.rejects(() => notifyModule.notify({ type: "lead_created", lead_id: IDs.lead }), /503/);
    globalThis.fetch = async () => { throw new Error("network down"); };
    await assert.rejects(() => notifyModule.notify({ type: "lead_created", lead_id: IDs.lead }), /network down/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
