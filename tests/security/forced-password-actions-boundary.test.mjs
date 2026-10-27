// ============================================================================
// R1 — the third entry point: a server action refuses a forced session too
// ============================================================================
// A2 closed two of the three ways an authenticated request reaches business
// logic: src/proxy.ts at the edge and getRequestAuthContext() for route
// handlers. Server actions were the third. Each one resolved its own session
// with createServerSupabase(), read profiles.role for its own role gate, and
// never looked at force_password_change or is_active — so the only thing
// standing between a forced session and a lead reassignment, a payment
// confirmation or a service-role password reset was the proxy matcher listing
// the page the action happens to POST to.
//
// tests/security/forced-password-change-boundary.test.mjs owns the matcher
// half. This file owns the actions themselves, in three parts:
//   1. the population — which files hold server actions, and that every
//      exported action in them reaches src/lib/action-auth-context.ts;
//   2. the refusals, by executing the real choke point and the real action
//      bodies against a recording Supabase double: forced, revoked and
//      unauthenticated sessions each get turned away with nothing written;
//   3. a cleared session as the negative control, so "refused" is a statement
//      about force_password_change rather than about the double.
//
// The double records every table, operation and RPC either client is asked
// for, so "no write" is a checked claim rather than the absence of an
// assertion.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FORCED_SESSION_ERROR, isForcedPasswordChange } from "../../src/lib/forced-password-change.mjs";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const actionsDir = path.join(root, "src/app/actions");

/**
 * Every `.mjs` helper in src/lib, keyed the way an action file imports it.
 *
 * These are the real modules rather than doubles — they hold no I/O, which is why
 * they are `.mjs` and shared with the tests in the first place. The mock table below
 * is for the modules that reach the network or the framework, and it overrides these.
 * This file enumerates src/app/actions dynamically so a new action cannot escape the
 * boundary; a hand-maintained list of pure helpers would undo that, since one action
 * reaching for one more helper would turn the boundary red for an unrelated reason —
 * which is exactly what happened when the payment actions adopted the shared cash
 * predicate.
 */
const pureHelpers = Object.fromEntries(
  await Promise.all(
    fs
      .readdirSync(path.join(root, "src/lib"))
      .filter((entry) => entry.endsWith(".mjs"))
      .map(async (entry) => [
        `@/lib/${entry}`,
        await import(pathToFileURL(path.join(root, "src/lib", entry)).href),
      ]),
  ),
);

/** Compile one repository TypeScript module with `mocks` standing in for imports. */
function loadModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => Object.hasOwn(mocks, request)
    ? mocks[request]
    : previousLoad.call(Module, request, parent, isMain);
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

// --- the doubles ------------------------------------------------------------

/** Every PostgREST builder method the action bodies chain, all recorded. */
const CHAIN_METHODS = [
  "select", "insert", "update", "upsert", "delete",
  "eq", "neq", "in", "is", "not", "or", "filter", "match", "gte", "lte", "order", "limit",
];
const WRITE_OPS = new Set(["insert", "update", "upsert", "delete"]);

/** A thenable query builder: any chain resolves to `result`, every hop is logged. */
function builder(result, record) {
  const self = {
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    single: async () => result,
    maybeSingle: async () => result,
  };
  for (const method of CHAIN_METHODS) {
    self[method] = (...args) => {
      record(method, args);
      return self;
    };
  }
  return self;
}

/**
 * The caller's own RLS client. `profiles` answers with the fixture profile —
 * that read is the choke point doing its job. Every other table answers with an
 * error, so an action that gets past the gate fails on its own next step rather
 * than on a missing mock, and the failure is distinguishable from a refusal.
 */
function sessionClient(profile, log, user, boundaryState) {
  const unavailable = (table) => ({ data: null, error: { message: `${table} unavailable in this test` } });
  const identity = user !== undefined
    ? user
    : (profile ? { id: profile.id, email: profile.email } : null);
  return {
    auth: {
      getUser: async () => ({ data: { user: identity }, error: null }),
    },
    from: (table) => builder(
      table === "profiles" ? { data: profile, error: null } : unavailable(table),
      (op) => log.push({ client: "session", table, op }),
    ),
    rpc: (name) => {
      log.push({ client: "session", op: "rpc", rpc: name });
      if (name === "session_boundary_state") {
        const state = boundaryState
          ?? (!identity ? "no_session"
            : !profile ? "no_profile"
              : profile.is_active !== true ? "inactive"
                : profile.force_password_change === true ? "password_change_required"
                  : "ok");
        return builder({ data: state, error: null }, () => {});
      }
      return builder({ data: null, error: { message: `rpc ${name} unavailable in this test` } }, () => {});
    },
  };
}

/** The service-role client. Any use at all is a finding, so all of it is logged. */
function serviceRoleClient(log) {
  const record = (op) => log.push({ client: "admin", op });
  const failure = { data: { user: null }, error: { message: "service-role client unavailable in this test" } };
  return {
    auth: {
      admin: {
        createUser: async () => { record("auth.admin.createUser"); return failure; },
        deleteUser: async () => { record("auth.admin.deleteUser"); return failure; },
        updateUserById: async () => { record("auth.admin.updateUserById"); return failure; },
        signOut: async () => { record("auth.admin.signOut"); return failure; },
      },
    },
    from: (table) => builder(failure, (op) => log.push({ client: "admin", table, op })),
    rpc: (name) => {
      log.push({ client: "admin", op: "rpc", rpc: name });
      return builder(failure, () => {});
    },
  };
}

/**
 * The real choke point and every real action module, over one shared log.
 *
 * `overrides.user` decouples the authenticated identity from the profile row, so
 * "a live session whose profile is gone" is expressible.
 */
function loadActions(profile, overrides = {}) {
  const log = [];
  const supabaseServer = {
    createServerSupabase: async () => sessionClient(profile, log, overrides.user, overrides.boundaryState),
  };
  const context = loadModule("src/lib/action-auth-context.ts", {
    "@/lib/supabase-server": supabaseServer,
    "@/lib/forced-password-change.mjs": { FORCED_SESSION_ERROR, isForcedPasswordChange },
  });
  const mocks = {
    ...pureHelpers,
    "@/lib/action-auth-context": context,
    "@/lib/notification-dispatch": {
      dispatchPersistedNotification: async (...args) => {
        log.push({ client: "notification", op: "dispatchPersistedNotification", args });
        return { attempted: 0, created: 0, failed: 0 };
      },
    },
    "@/lib/supabase-server": supabaseServer,
    "@/lib/supabase-admin": { supabaseAdmin: serviceRoleClient(log) },
    "@/lib/lead-reassignment.mjs": { resolveActiveLeadReassignmentTarget: async () => null },
    "next/cache": { revalidatePath: (pathname) => log.push({ client: "next", op: "revalidatePath", table: pathname }) },
  };
  const modules = {};
  for (const file of actionFiles()) modules[file] = loadModule(`src/app/actions/${file}`, mocks);
  return { context, log, modules };
}

// --- the population ---------------------------------------------------------

function actionFiles() {
  return fs.readdirSync(actionsDir).filter((entry) => entry.endsWith(".ts")).sort();
}

/** Every module in src that declares itself a server-action module. */
function useServerModules() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/^\s*['"]use server['"]/m.test(fs.readFileSync(full, "utf8"))) {
        found.push(path.relative(root, full).replaceAll("\\", "/"));
      }
    }
  };
  walk(path.join(root, "src"));
  return found.sort();
}

/** `export async function` declarations and their bodies, per action file. */
function exportedActions() {
  const found = [];
  for (const file of actionFiles()) {
    const source = fs.readFileSync(path.join(actionsDir, file), "utf8");
    for (const match of source.matchAll(/export\s+async\s+function\s+(\w+)/g)) {
      const next = source.indexOf("\nexport ", match.index + 1);
      found.push({ file, name: match[1], body: source.slice(match.index, next === -1 ? undefined : next) });
    }
  }
  return found;
}

/**
 * Every exported action, with arguments that are valid enough to reach the gate.
 *
 * The refused calls all pass structurally sound arguments on purpose: an action
 * that rejected its arguments first would look refused without the boundary
 * doing anything.
 */
const LEAD_A = "11111111-1111-4111-8111-111111111111";
const LEAD_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "2026-08-14T04:30:53.769140+00:00";
const TOKEN_B = "2026-08-14T04:30:53.890784+00:00";
const BATCH_KEY = "33333333-3333-4333-8333-333333333333";

const ACTIONS = [
  { file: "auth.ts", name: "getCurrentUser", args: [], forced: "opt-out" },
  { file: "contracts.ts", name: "approveContract", args: ["c1", "approve"], forced: "throws" },
  { file: "lead.ts", name: "addLeadNote", args: ["l1", "a note"], forced: "false" },
  { file: "payments.ts", name: "confirmPayment", args: ["p1"], forced: "throws" },
  { file: "payments.ts", name: "allocatePayment", args: ["p1", [{ plan_id: "pl1", amount: 100 }]], forced: "throws" },
  { file: "pipeline.ts", name: "writeBusinessEvent", args: ["l1", "stage_change", "moved"], forced: "throws" },
  { file: "pipeline.ts", name: "updateLeadStage", args: ["l1", { stage: "quotation" }], forced: "throws" },
  { file: "pipeline.ts", name: "updateRelatedQuotations", args: ["l1", false], forced: "throws" },
  { file: "pipeline.ts", name: "logStageChangeActivity", args: ["l1", "new", "quotation"], forced: "throws" },
  // R6 · the assignment actions now carry a compare-and-set token per lead and a
  // batch key per gesture, so the arguments here are shaped the way the settings
  // page sends them. They are still only "sound enough to reach the gate": the
  // refusal has to come from force_password_change, not from argument validation,
  // and the batch-key check deliberately sits after the role check for that
  // reason.
  {
    file: "settings.ts",
    name: "assignLead",
    args: [LEAD_A, "u2", TOKEN_A, BATCH_KEY],
    forced: "throws",
  },
  {
    file: "settings.ts",
    name: "bulkAssignLeads",
    args: [[{ id: LEAD_A, expectedUpdatedAt: TOKEN_A }, { id: LEAD_B, expectedUpdatedAt: TOKEN_B }], "u2", BATCH_KEY],
    forced: "throws",
  },
  {
    file: "settings.ts",
    name: "bulkUnassignLeads",
    args: [[{ id: LEAD_A, expectedUpdatedAt: TOKEN_A }, { id: LEAD_B, expectedUpdatedAt: TOKEN_B }]],
    forced: "throws",
  },
  { file: "settings.ts", name: "transferAllLeads", args: ["u1", "u2", BATCH_KEY], forced: "throws" },
  {
    file: "team.ts",
    name: "addTeamMember",
    args: [{ full_name: "New Hire", email: "new@newme.ae", password: "correct horse", role: "sales" }],
    forced: "throws",
  },
  { file: "team.ts", name: "removeTeamMember", args: ["u2"], forced: "throws" },
  { file: "team.ts", name: "resetUserPassword", args: ["u2", "correct horse"], forced: "throws" },
];

const IDENTITY = {
  id: "u1",
  role: "admin",
  is_active: true,
  full_name: "An Administrator",
  email: "admin@newme.ae",
  password_changed_at: null,
};
const FORCED = { ...IDENTITY, force_password_change: true };
const REVOKED = { ...IDENTITY, force_password_change: false, is_active: false };
// The negative control is deliberately a non-privileged role: every action that
// gates on a role then refuses for that reason instead, which proves the gate
// was passed without any action reaching a real service-role call.
const CLEARED = { ...IDENTITY, force_password_change: false, role: "sales" };

/** Run one action and return either its value or the error it threw. */
async function invoke(modules, action) {
  const fn = modules[action.file][action.name];
  assert.equal(typeof fn, "function", `${action.file}:${action.name} is not exported`);
  return fn(...action.args).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

/** The refusal happened at the profile read, and nothing else was touched. */
function assertNothingTouched(log, where) {
  const beyondTheProfileRead = log.filter(
    (entry) => entry.client !== "session"
      || (entry.table !== "profiles" && entry.rpc !== "session_boundary_state")
      || WRITE_OPS.has(entry.op),
  );
  assert.deepEqual(beyondTheProfileRead, [], `${where} reached past the auth gate`);
}

// --- 1 · the population -----------------------------------------------------

test("every server action in the tree resolves auth through the one choke point", () => {
  const files = actionFiles();
  assert.deepEqual(files, [
    "auth.ts", "contracts.ts", "lead.ts", "payments.ts", "pipeline.ts", "settings.ts", "team.ts",
  ]);

  // The population is the directory. An inline `'use server'` in a component
  // would be a server action this file never enumerated, so it must not exist —
  // and if the project ever wants one, this assertion is where it declares it.
  assert.deepEqual(useServerModules(), files.map((file) => `src/app/actions/${file}`));

  for (const file of files) {
    const source = fs.readFileSync(path.join(actionsDir, file), "utf8");
    assert.match(source, /^\s*['"]use server['"]/, `${file} is not a server-action module`);
    assert.match(
      source,
      /import\s*\{[^}]*getActionAuthContext[^}]*\}\s*from\s*['"]@\/lib\/action-auth-context['"]/,
      `${file} does not import the choke point`,
    );
    // No action may resolve its own session. pipeline.ts still imports
    // createServerSupabase for the client *type*; a call is what this forbids.
    assert.doesNotMatch(source, /createServerSupabase\(/, `${file} resolves its own session`);
    // …and none may touch profiles a second time for the caller's own role. The
    // choke point has already read it, and a second read can disagree with the
    // first. team.ts is the exception by nature: it creates, deactivates and
    // resets *other* identities, so it writes rows that are not the caller's.
    if (file === "team.ts") continue;
    assert.doesNotMatch(source, /from\(['"]profiles['"]\)/, `${file} reads profiles after the choke point`);
  }

  // Every exported action is in the behaviour table below, and every entry in
  // the table is a real export. A new action cannot be added without being
  // exercised here.
  const onDisk = exportedActions();
  assert.deepEqual(
    onDisk.map((action) => `${action.file}:${action.name}`).sort(),
    ACTIONS.map((action) => `${action.file}:${action.name}`).sort(),
  );

  // And each one reaches the choke point in its own body, not merely in the file.
  for (const action of onDisk) {
    assert.match(
      action.body,
      /await getActionAuthContext\(/,
      `${action.file}:${action.name} does not call getActionAuthContext`,
    );
  }
});

test("getCurrentUser is the only action allowed to opt out of the refusal", () => {
  const optOuts = exportedActions().filter((action) => /allowForcedPasswordChange/.test(action.body));
  assert.deepEqual(
    optOuts.map((action) => `${action.file}:${action.name}`),
    ["auth.ts:getCurrentUser"],
    "an action other than the who-am-I read opted out of the A2 boundary",
  );

  // The escape hatch for actions is narrower than for routes: a forced session
  // changes its password through POST /api/auth/change-password, which is a
  // route. So no action may be on the *route* exception list's business either —
  // getCurrentUser exists because /change-password has to render.
  const source = fs.readFileSync(path.join(actionsDir, "auth.ts"), "utf8");
  assert.match(source, /allowForcedPasswordChange: true/);
});

// --- 2 · the refusals -------------------------------------------------------

test("a forced session is refused by every server action, and writes nothing", async () => {
  for (const action of ACTIONS) {
    const { context, log, modules } = loadActions(FORCED);
    const outcome = await invoke(modules, action);
    const where = `${action.file}:${action.name}`;

    if (action.forced === "opt-out") {
      // The one allowed action: it answers, because the change-password page
      // needs an answer.
      assert.equal(outcome.error, undefined, `${where} threw for the opt-out`);
      assert.deepEqual(outcome.value, { id: "u1", role: "admin", email: "admin@newme.ae" });
      continue;
    }

    if (action.forced === "false") {
      // addLeadNote catches its own failures and reports false. The refusal
      // still has to be the reason nothing was written.
      assert.equal(outcome.value, false, `${where} did not report failure`);
    } else {
      assert.ok(outcome.error, `${where} resolved for a forced session`);
      assert.ok(outcome.error instanceof context.ActionAuthError, `${where} threw ${outcome.error?.name}`);
      assert.equal(outcome.error.code, FORCED_SESSION_ERROR, where);
      assert.equal(outcome.error.message, "password_change_required", where);
    }
    assertNothingTouched(log, where);
  }
});

test("a revoked identity is refused by every server action, including the opt-out", async () => {
  // is_active was checked at the edge and nowhere else. The database half
  // (20260813000000's restrictive policies) refuses a revoked identity too, but
  // that is the last line rather than the first: an action that reaches a write
  // and is refused by RLS has already spent a service-role call in team.ts.
  for (const action of ACTIONS) {
    const { context, log, modules } = loadActions(REVOKED);
    const outcome = await invoke(modules, action);
    const where = `${action.file}:${action.name}`;

    if (action.forced === "opt-out") {
      assert.equal(outcome.value, null, `${where} answered a revoked identity`);
    } else if (action.forced === "false") {
      assert.equal(outcome.value, false, where);
    } else {
      assert.ok(outcome.error instanceof context.ActionAuthError, `${where} threw ${outcome.error?.name}`);
      assert.equal(outcome.error.code, "inactive_account", where);
    }
    assertNothingTouched(log, where);
  }
});

test("a stale access token is refused by every server action, including the opt-out", async () => {
  for (const action of ACTIONS) {
    const { context, log, modules } = loadActions(CLEARED, { boundaryState: "token_stale" });
    const outcome = await invoke(modules, action);
    const where = `${action.file}:${action.name}`;

    if (action.forced === "opt-out") {
      assert.equal(outcome.value, null, `${where} answered a stale token`);
    } else if (action.forced === "false") {
      assert.equal(outcome.value, false, where);
    } else {
      assert.ok(outcome.error instanceof context.ActionAuthError, `${where} threw ${outcome.error?.name}`);
      assert.equal(outcome.error.code, "Unauthorized", where);
    }
    assertNothingTouched(log, where);
  }
});

test("no session at all is refused by every server action before any query runs", async () => {
  for (const action of ACTIONS) {
    const { context, log, modules } = loadActions(null);
    const outcome = await invoke(modules, action);
    const where = `${action.file}:${action.name}`;

    if (action.forced === "opt-out") {
      assert.equal(outcome.value, null, where);
    } else if (action.forced === "false") {
      assert.equal(outcome.value, false, where);
    } else {
      assert.ok(outcome.error instanceof context.ActionAuthError, `${where} threw ${outcome.error?.name}`);
      assert.equal(outcome.error.code, "Unauthorized", where);
    }
    // Not even the profile read: there is no id to read it by.
    assert.deepEqual(log, [], `${where} queried without a user`);
  }
});

test("a session whose profile row is gone is refused, not treated as unprivileged", async () => {
  // The pre-R1 actions read profiles.role and compared it against a list, so a
  // missing row failed the role check and produced 'Forbidden' — the right answer
  // by accident. writeBusinessEvent, logStageChangeActivity and addLeadNote had
  // no role list to fail, so for them a missing profile meant the write went
  // ahead on the JWT alone. The refusal is now the choke point's, for all of them.
  const { context, log, modules } = loadActions(null, { user: { id: "u1" } });
  const outcome = await invoke(modules, ACTIONS.find((action) => action.name === "writeBusinessEvent"));
  assert.ok(outcome.error instanceof context.ActionAuthError, `threw ${outcome.error?.name}`);
  assert.equal(outcome.error.code, "Profile not found");
  // The authoritative caller-scoped verdict is the only thing that happened;
  // it refuses before a relaxed profiles self-read can turn absence into a role.
  assert.deepEqual(
    log.map((entry) => `${entry.client}:${entry.rpc}:${entry.op}`),
    ["session:session_boundary_state:rpc"],
  );
});

// --- 3 · the negative control ----------------------------------------------

test("a cleared session gets past the gate, so the refusal is about the flag", async () => {
  // Without this, every assertion above would also pass if getActionAuthContext
  // threw unconditionally, or if the double never answered.
  for (const action of ACTIONS) {
    const { context, log, modules } = loadActions(CLEARED);
    const outcome = await invoke(modules, action);
    const where = `${action.file}:${action.name}`;

    assert.ok(
      !(outcome.error instanceof context.ActionAuthError),
      `${where} refused a cleared, active session: ${outcome.error?.code}`,
    );

    if (action.name === "getCurrentUser") {
      assert.deepEqual(outcome.value, { id: "u1", role: "sales", email: "admin@newme.ae" });
      continue;
    }
    if (action.name === "addLeadNote") {
      // It got as far as the insert, which is the point.
      assert.equal(outcome.value, true, where);
      assert.ok(
        log.some((entry) => entry.table === "activities" && entry.op === "insert"),
        `${where} did not reach its write`,
      );
      continue;
    }

    // Everything else stops at its own next check — a role gate it does not pass,
    // or a row the double will not produce — and that is a different failure from
    // the boundary's.
    assert.ok(outcome.error, `${where} unexpectedly succeeded against the double`);
    assert.ok(
      /Forbidden|unavailable in this test|Failed to determine approval step/.test(outcome.error.message),
      `${where} failed for an unexpected reason: ${outcome.error.message}`,
    );
  }
});

test("the profile the choke point reads carries the columns the gate needs", () => {
  // A select that omits force_password_change or is_active makes both refusals
  // unreachable without changing a line of the logic that enforces them — the
  // exact shape of the original A2 defect.
  const source = fs.readFileSync(path.join(root, "src/lib/action-auth-context.ts"), "utf8");
  const select = source.match(/\.select\(\s*"([^"]+)"\s*\)/);
  assert.ok(select, "the choke point no longer selects an explicit column list");
  const columns = select[1].split(",").map((column) => column.trim()).sort();
  assert.deepEqual(columns, ["email", "force_password_change", "full_name", "id", "is_active", "role"]);
});
