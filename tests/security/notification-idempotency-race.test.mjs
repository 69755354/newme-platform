import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadNotifications(client) {
  const ts = require("typescript");
  const filename = path.join(root, "src/lib/notifications.ts");
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
    if (request === "./supabase-admin") return { supabaseAdmin: client };
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

function concurrentStore() {
  const rows = [];
  const readers = [];
  return {
    rows,
    client: {
      from(table) {
        assert.equal(table, "notifications");
        const query = {
          select() { return query; },
          in() { return query; },
          then(resolve, reject) {
            readers.push({ resolve, reject });
            if (readers.length === 2) {
              queueMicrotask(() => {
                const snapshot = rows.map((row) => ({ ...row }));
                for (const reader of readers.splice(0)) {
                  reader.resolve({ data: snapshot, error: null });
                }
              });
            }
          },
          async insert(pending) {
            rows.push(...pending.map((row) => ({ ...row })));
            return { data: null, error: null };
          },
        };
        return query;
      },
      async rpc(name, args) {
        assert.equal(name, "insert_notifications_atomic");
        const input = args.p_notifications;
        let created = 0;
        let skipped = 0;
        for (const row of input) {
          const existing = row.event_key == null
            ? null
            : rows.find((candidate) => candidate.user_id === row.user_id && candidate.event_key === row.event_key);
          if (existing) {
            skipped += 1;
          } else {
            rows.push({ ...row });
            created += 1;
          }
        }
        return { data: { created, skipped }, error: null };
      },
    },
  };
}

const draft = {
  userId: "22222222-2222-4222-8222-222222222222",
  type: "lead_created",
  title: "New lead: Database Customer",
  relatedId: "55555555-5555-4555-8555-555555555555",
  relatedType: "lead",
};

test("two concurrent deliveries of one persisted occurrence create exactly one row", async () => {
  const store = concurrentStore();
  const notifications = loadNotifications(store.client);
  const results = await Promise.all([
    notifications.createNotification({ ...draft, eventKey: `lead_created:${draft.relatedId}` }),
    notifications.createNotification({ ...draft, eventKey: `lead_created:${draft.relatedId}` }),
  ]);

  assert.equal(results.reduce((sum, result) => sum + result.created, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.skipped, 0), 1);
  assert.equal(store.rows.length, 1);
});

test("repeatable notifications without an event key remain distinct intents", async () => {
  const store = concurrentStore();
  const notifications = loadNotifications(store.client);
  const results = await Promise.all([
    notifications.createNotification({ ...draft, type: "first_payment_reminder" }),
    notifications.createNotification({ ...draft, type: "first_payment_reminder" }),
  ]);

  assert.equal(results.reduce((sum, result) => sum + result.created, 0), 2);
  assert.equal(results.reduce((sum, result) => sum + result.skipped, 0), 0);
  assert.equal(store.rows.length, 2);
});

test("an invalid empty occurrence key is not downgraded to a repeatable NULL intent", async () => {
  let persistedKey = null;
  const notifications = loadNotifications({
    async rpc(name, args) {
      assert.equal(name, "insert_notifications_atomic");
      persistedKey = args.p_notifications[0].event_key;
      return { data: null, error: { code: "22023" } };
    },
  });

  await assert.rejects(
    () => notifications.createNotification({ ...draft, eventKey: "" }),
    (error) => error.name === "NotificationPersistenceError" && error.code === "22023",
  );
  assert.equal(persistedKey, "");
});
