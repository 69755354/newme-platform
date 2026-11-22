// S35: /dispatch, /opportunities and /visits existed (and proxy.ts admits roles to them) but no menu led there; the dispatch
// queue could not hand a lead to a salesperson; a closed WhatsApp privacy gate now shows on /api/health.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { buildQueueAssignRequest, canAssignFromQueue } from "../../src/lib/lead-dispatch.mjs";
import { intakeDegradedSnapshot, markIntakeDegraded, resetIntakeDegraded } from "../../src/lib/intake-degraded.mjs";
import { translations } from "../../src/lib/i18n/translations.ts";

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const NAV = read("src/lib/nav.ts");
const PROXY = read("src/proxy.ts");
const require = createRequire(import.meta.url);

function navItems(arrayName) {
  const start = NAV.indexOf(`export const ${arrayName}: NavItem[] = [`);
  const end = NAV.indexOf("\n];", start);
  return [...NAV.slice(start, end).matchAll(/\{\s*href:\s*"([^"]+)",\s*labelKey:\s*"([^"]+)"([^}]*)\}/g)].map((m) => ({ href: m[1], labelKey: m[2], narrowed: /roles:/.test(m[3]) }));
}
const proxyRoles = (route) => JSON.parse(new RegExp(`"${route}":\\s*(\\[[^\\]]*\\])`).exec(PROXY)[1]);
const ARRAY_FOR_ROLE = { admin: "MGMT_NAV", boss: "MGMT_NAV", operator: "MGMT_NAV", sales: "SALES_NAV", finance: "FINANCE_NAV", designer: "DESIGNER_NAV" };

test("every role that proxy.ts admits to /dispatch, /opportunities and /visits has the menu entry; roles it refuses do not", () => {
  for (const route of ["/dispatch", "/opportunities", "/visits"]) {
    const allowed = proxyRoles(route);
    for (const [role, array] of Object.entries(ARRAY_FOR_ROLE)) {
      const shown = navItems(array).some((item) => item.href === route);
      assert.equal(shown, allowed.includes(role), `${route} for ${role}`);
    }
  }
  assert.deepEqual(proxyRoles("/dispatch"), ["admin", "boss", "operator"], "admin keeps boss-level access");
});

test("the new menu entries have Chinese and English labels", () => {
  const keys = new Set([...navItems("MGMT_NAV"), ...navItems("SALES_NAV")].filter((i) => /dispatch|opportunit|visit/i.test(i.href)).map((i) => i.labelKey));
  assert.deepEqual([...keys].sort(), ["mgmtDispatch", "mgmtOpportunities", "mgmtVisits", "salesOpportunities", "salesVisits"]);
  for (const lang of ["en", "zh"]) for (const key of keys) assert.ok(translations[lang].nav[key], `${lang}.nav.${key}`);
});

const A = "d0000000-0000-4000-8000-000000000001";
const LEAD = "d0000000-0000-4000-8000-000000000002";
const KEY = "d0000000-0000-4000-8000-000000000003";
const row = (o = {}) => ({ lead_id: LEAD, status: "unassigned", lead: { id: LEAD, assigned_to: null, updated_at: "2026-11-22T07:00:00.123456+00:00" }, ...o });

test("dispatch queue: only an unowned lead in the Unassigned tab can be assigned, through the ordinary assignment API", () => {
  assert.equal(canAssignFromQueue(row()), true);
  assert.equal(canAssignFromQueue(row({ status: "duplicate_review" })), false);
  assert.equal(canAssignFromQueue(row({ status: "missing_intake_data" })), false);
  assert.equal(canAssignFromQueue(row({ lead: { id: LEAD, assigned_to: A } })), false);
  assert.equal(canAssignFromQueue(row({ lead: null })), false);
  assert.deepEqual(buildQueueAssignRequest(row(), A, KEY), {
    url: `/api/leads/${LEAD}/assignment`,
    body: { assignedTo: A, expectedUpdatedAt: "2026-11-22T07:00:00.123456+00:00", idempotencyKey: KEY, reason: "dispatch_queue_assign" },
  });
  assert.equal(buildQueueAssignRequest(row(), "", KEY), null);
  assert.equal(buildQueueAssignRequest(row(), A, "x"), null);
  assert.equal(buildQueueAssignRequest(row({ status: "delivered" }), A, KEY), null);
});

test("the queue reuses the existing assignment route (admin, boss, operator, compare-and-set) and adds no route of its own", () => {
  const route = read("src/app/api/leads/[id]/assignment/route.ts");
  assert.match(route, /\["admin", "boss", "operator"\]\.includes\(context\.role\)/);
  assert.match(route, /reassign_lead_atomic/);
  const ui = read("src/components/dispatch/DispatchWorkbench.tsx");
  assert.match(ui, /buildQueueAssignRequest\(row, pick\[row\.lead_id\]/);
  assert.match(ui, /callApi<\{ code\?: string \}>\(request\.url/);
  assert.match(ui, /action: "reevaluate"/, "the lead leaves the Unassigned tab right after");
  assert.match(read("src/lib/lead-dispatch-api.ts"), /LEAD_COLUMNS = "[^"]*updated_at/, "the queue carries the lead's current updated_at");
  assert.equal(fs.existsSync(new URL("../../src/app/api/dispatch/assign", import.meta.url)), false);
  for (const lang of ["en", "zh"]) for (const key of ["label", "pick", "button", "done"]) assert.ok(translations[lang].dispatch.assign[key], `${lang}.dispatch.assign.${key}`);
});

test("/api/health keeps status ok and adds an intake flag only while WhatsApp intake ran degraded in the last 30 minutes", async () => {
  const ts = require("typescript");
  const output = ts.transpileModule(read("src/app/api/health/route.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => (name === "next/server" ? { NextResponse: { json: (body, init) => Response.json(body, init) } }
    : name === "@/lib/intake-degraded.mjs" ? { intakeDegradedSnapshot } : require(name)), exports);
  resetIntakeDegraded();
  assert.deepEqual(await exports.GET().json(), { status: "ok" });
  markIntakeDegraded("whatsapp");
  assert.deepEqual(await exports.GET().json(), { status: "ok", intake: { whatsapp: "degraded" } });
  assert.deepEqual(intakeDegradedSnapshot(Date.now() + 31 * 60_000), {}, "clears after 30 minutes");
  resetIntakeDegraded();
});
