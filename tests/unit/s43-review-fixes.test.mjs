// S43 review follow-ups (PR #613): a failed leave-cover lookup must not break the assignment notification;
// the email match of the website dedupe is case-insensitive and escapes LIKE wildcards.
// The loader replaces Module._load for one load, so the runner gives this file its own process.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { findOpenLeadByContact } from "../../src/lib/lead-dedupe.mjs";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(import.meta.dirname, "../..");

function loadModule(relativePath, mocks) {
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => (Object.hasOwn(mocks, request) ? mocks[request] : previousLoad.call(Module, request, parent, isMain));
  try { loaded._compile(outputText, filename); return loaded.exports; } finally { Module._load = previousLoad; }
}

const LEAD = "55555555-5555-4555-8555-555555555555";
const OWNER = "33333333-3333-4333-8333-333333333333";
const ADMIN = "22222222-2222-4222-8222-222222222222";

function notificationDb({ coverLookupFails }) {
  return {
    from(table) {
      let columns = "";
      const q = {
        select(c) { columns = String(c); return q; }, eq() { return q; }, in() { return q; },
        maybeSingle: async () => ({ data: { id: LEAD, customer_name: "Test Customer", assigned_to: OWNER }, error: null }),
        then(res, rej) {
          const result = table === "profiles" && /cover_/.test(columns)
            ? (coverLookupFails ? { data: null, error: { code: "57014" } } : { data: [{ id: OWNER, is_active: true }], error: null })
            : { data: [{ id: OWNER }], error: null };
          return Promise.resolve(result).then(res, rej);
        },
      };
      return q;
    },
  };
}

test("lead_assigned: with the cover switch on and the cover lookup failing, the owner is still notified", async () => {
  process.env.NEWME_LEAVE_COVER_ENABLED = "true";
  try {
    const events = loadModule("src/lib/notification-events.ts", {
      "server-only": {},
      "@/lib/leave-cover.mjs": require("../../src/lib/leave-cover.mjs"),
      "@/lib/logger": { logger: { error() {}, info() {}, warn() {} } },
    });
    const drafts = await events.deriveNotificationDispatch({
      db: notificationDb({ coverLookupFails: true }),
      actor: { id: ADMIN, role: "admin", fullName: "Admin" },
      input: { type: "lead_assigned", lead_id: LEAD },
    });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].userId ?? drafts[0].user_id, OWNER);
  } finally {
    delete process.env.NEWME_LEAVE_COVER_ENABLED;
  }
});

function emailDb(calls) {
  return {
    from() {
      const q = {
        select() { return q; }, eq() { return q; }, is() { return q; }, order() { return q; }, limit() { return q; },
        ilike(column, pattern) { calls.push([column, pattern]); return q; },
        then(res, rej) { return Promise.resolve({ data: [{ id: "L1", phone: null, email: "Jo_Smith@Example.AE", archived: false, final_status: null }], error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

test("website dedupe: the email is matched case-insensitively, LIKE wildcards in the address are escaped", async () => {
  const calls = [];
  const found = await findOpenLeadByContact(emailDb(calls), { phone: null, email: "jo_smith@example.ae" });
  assert.deepEqual(calls, [["email", "jo\\_smith@example.ae"]]);
  assert.equal(found.lead?.id, "L1", "a stored address in another letter case is the same customer");
  const calls2 = [];
  await findOpenLeadByContact(emailDb(calls2), { phone: null, email: "100%@x.ae" });
  assert.deepEqual(calls2, [["email", "100\\%@x.ae"]]);
});
