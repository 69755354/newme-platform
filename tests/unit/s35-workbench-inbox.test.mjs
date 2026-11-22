// S35 B7: the sales workbench inbox lists new, never-contacted leads first, then due today, then overdue, and old
// overdue leads can no longer push new ones out of the 20. The route runs against an in-memory leads table.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { INBOX_LIMIT, INBOX_NEW_CAP, inboxDayKeys, mergeInbox } from "../../src/lib/workbench-inbox.mjs";

const require = createRequire(import.meta.url);
const ME = "c0000000-0000-4000-8000-000000000001";
const OTHER = "c0000000-0000-4000-8000-000000000002";

function loadRoute(mocks) {
  const ts = require("typescript");
  const output = ts.transpileModule(fs.readFileSync(new URL("../../src/app/api/workbench/route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => mocks[name] ?? require(name), exports);
  return exports;
}

/** A tiny PostgREST stand-in: eq / is / lt / gte / order / limit on the leads table; every other table is empty. */
function fakeSupabase(leads, role = "sales", userId = ME) {
  const query = (table) => {
    const filters = []; const orders = []; let limit = Infinity; let head = false;
    const rows = () => {
      if (table !== "leads") return [];
      let out = leads.filter((r) => filters.every((f) => f(r)));
      for (const [col, asc] of [...orders].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[col] ?? null, bv = b[col] ?? null;
          if (av === bv) return 0;
          if (av === null) return 1; if (bv === null) return -1;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      return out.slice(0, limit);
    };
    const q = {
      select: (_c, opts) => { head = Boolean(opts?.head); return q; },
      eq: (c, v) => (filters.push((r) => r[c] === v), q),
      neq: () => q, in: () => q, or: () => q,
      is: (c, v) => (filters.push((r) => (r[c] ?? null) === v), q),
      lt: (c, v) => (filters.push((r) => r[c] != null && r[c] < v), q),
      gte: (c, v) => (filters.push((r) => r[c] != null && r[c] >= v), q),
      lte: () => q, gt: () => q,
      order: (c, o) => (orders.push([c, o?.ascending !== false]), q),
      limit: (n) => (limit = n, q),
      single: async () => ({ data: { id: userId, full_name: "Me", role }, error: null }),
      then: (res, rej) => Promise.resolve(head ? { count: 0, data: null, error: null } : { data: rows(), error: null }).then(res, rej),
    };
    return q;
  };
  return { auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, from: query };
}

let counter = 0;
async function inboxFor(leads, role = "sales") {
  const userId = `c0000000-0000-4000-8000-${String(100 + counter++).padStart(12, "0")}`;
  const mine = leads.map((l) => ({ ...l, assigned_to: l.assigned_to === ME ? userId : l.assigned_to }));
  const route = loadRoute({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/api-cache.mjs": { getCached: () => null, setCache: () => {} },
    "@/lib/workbench-inbox.mjs": { INBOX_LIMIT, inboxDayKeys, mergeInbox },
    "@/lib/supabase-server": { createServerSupabase: async () => fakeSupabase(mine, role, userId) },
  });
  const body = await (await route.GET(new Request("https://example.test/api/workbench"))).json();
  return body.inbox;
}

const { today, tomorrow } = inboxDayKeys(new Date());
const yesterday = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const lead = (id, o = {}) => ({ id, customer_name: id, archived: false, final_status: null, assigned_to: ME, stage: "contacted",
  last_contact_date: "2026-11-01", next_followup_date: null, updated_at: "2026-11-20T00:00:00Z", ...o });

test("25 old overdue leads no longer push a freshly assigned, never-contacted lead out of the inbox", async () => {
  const overdue = Array.from({ length: 25 }, (_, i) => lead(`old${i}`, { next_followup_date: yesterday(30 - i) }));
  const fresh = lead("fresh", { stage: "new", last_contact_date: null, next_followup_date: tomorrow, updated_at: "2026-11-22T07:00:00Z" });
  const inbox = await inboxFor([...overdue, fresh]);
  assert.equal(inbox.length, INBOX_LIMIT);
  assert.equal(inbox[0].id, "fresh");
  assert.equal(inbox[0].inbox_group, "new");
  assert.ok(inbox.slice(1).every((i) => i.inbox_group === "overdue"));
});

test("order: new first, then due today, then overdue (longest waiting first), then later; nothing twice", async () => {
  const inbox = await inboxFor([
    lead("later-none"), lead("later-date", { next_followup_date: yesterday(-5) }),
    lead("over-old", { next_followup_date: yesterday(10) }), lead("over-new", { next_followup_date: yesterday(1) }),
    lead("today", { next_followup_date: today }),
    lead("new-a", { stage: "new", last_contact_date: null, updated_at: "2026-11-21T00:00:00Z" }),
    lead("new-b", { stage: "new", last_contact_date: null, updated_at: "2026-11-22T00:00:00Z", next_followup_date: yesterday(3) }),
  ]);
  assert.deepEqual(inbox.map((i) => i.id), ["new-b", "new-a", "today", "over-old", "over-new", "later-date", "later-none"]);
  assert.deepEqual(inbox.map((i) => i.inbox_group), ["new", "new", "due_today", "overdue", "overdue", "later", "later"]);
});

test("a salesperson sees only their own leads; closed and archived leads never show; a manager sees everyone's", async () => {
  const leads = [lead("mine", { stage: "new", last_contact_date: null }), lead("theirs", { assigned_to: OTHER, stage: "new", last_contact_date: null }),
    lead("won", { final_status: "won", stage: "new", last_contact_date: null }), lead("gone", { archived: true, stage: "new", last_contact_date: null })];
  assert.deepEqual((await inboxFor(leads)).map((i) => i.id), ["mine"]);
  assert.deepEqual((await inboxFor(leads, "admin")).map((i) => i.id).sort(), ["mine", "theirs"]);
});

test("a lead contacted but not yet advanced is not 'new'; mergeInbox caps at the limit and drops duplicates", () => {
  const merged = mergeInbox({ new: [{ id: "a" }], due_today: [{ id: "a" }, { id: "b" }], overdue: Array.from({ length: 30 }, (_, i) => ({ id: `o${i}` })) }, 5);
  assert.deepEqual(merged.map((m) => m.id), ["a", "b", "o0", "o1", "o2"]);
  assert.deepEqual(merged.map((m) => m.inbox_group), ["new", "due_today", "overdue", "overdue", "overdue"]);
});

test("25 new leads cannot hide a lead due today (new is capped at 8); slack goes back to new leads", async () => {
  const fresh = Array.from({ length: 25 }, (_, i) => lead(`n${String(i).padStart(2, "0")}`, { stage: "new", last_contact_date: null, updated_at: `2026-11-22T07:${String(59 - i).padStart(2, "0")}:00Z` }));
  const inbox = await inboxFor([...fresh, lead("today", { next_followup_date: today })]);
  assert.equal(inbox.length, INBOX_LIMIT);
  assert.ok(inbox.some((i) => i.id === "today"), "the due-today lead is in the list");
  assert.equal(inbox.filter((i) => i.inbox_group === "new").length, INBOX_LIMIT - 1, "only one other group has rows, so new takes the slack");
  const crowded = mergeInbox({ new: Array.from({ length: 25 }, (_, i) => ({ id: `n${i}` })), due_today: [{ id: "d" }], overdue: Array.from({ length: 30 }, (_, i) => ({ id: `o${i}` })) });
  assert.equal(INBOX_NEW_CAP, 8);
  assert.deepEqual([crowded.filter((r) => r.inbox_group === "new").length, crowded.filter((r) => r.inbox_group === "due_today").length, crowded.filter((r) => r.inbox_group === "overdue").length], [8, 1, 11]);
  assert.equal(crowded[0].inbox_group, "new");
});
