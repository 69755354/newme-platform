import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

function block(src, name) {
  // the S24 block: "    name: {" at language level up to its closing "    },"
  return [...src.matchAll(new RegExp(`\\n    ${name}: \\{([\\s\\S]*?)\\n    \\},`, "g"))].map((m) => m[1]);
}
function paths(text) {
  const out = [];
  const stack = [];
  for (const line of text.split("\n")) {
    const open = line.match(/^\s+(\w+): \{\s*$/);
    const inline = line.match(/^\s+(\w+): \{(.*)\},?\s*$/);
    const leaf = line.match(/^\s+(\w+): "/);
    if (open) stack.push(open[1]);
    else if (/^\s+\},?\s*$/.test(line)) stack.pop();
    else if (inline) for (const k of inline[2].matchAll(/(\w+):/g)) out.push([...stack, inline[1], k[1]].join("."));
    else if (leaf) out.push([...stack, leaf[1]].join("."));
  }
  return out.sort();
}
const SCREENS = ["src/components/dispatch/DispatchWorkbench.tsx", "src/components/dispatch/shared.ts",
  "src/app/(dashboard)/dispatch/dispatch-client.tsx", "src/app/(dashboard)/leads/[id]/LeadDispatchCard.tsx"];
const STATUSES = ["missing_intake_data", "review_phone", "duplicate_review", "unassigned", "delivered", "duplicate_not_dispatched", "excluded_test"];

test("both languages carry the same dispatch keys, and every key the screens use", () => {
  const src = read("src/lib/i18n/translations.ts");
  const found = block(src, "dispatch");
  assert.equal(found.length, 2, "one block per language");
  assert.deepEqual(paths(found[0]), paths(found[1]), "same keys in both languages");
  const keys = new Set(paths(found[0]));
  for (const file of SCREENS) {
    for (const [, key] of read(file).matchAll(/t\("dispatch\.([\w.]+)"\)/g)) assert.ok(keys.has(key), `${file}: dispatch.${key}`);
  }
  for (const status of STATUSES) for (const group of ["status", "statusHelp"]) assert.ok(keys.has(`${group}.${status}`), `${group}.${status}`);
  for (const action of ["confirm_phone", "release_missing", "revoke_release", "mark_test", "unmark_test", "note", "reevaluate"]) assert.ok(keys.has(`action.${action}`), action);
  for (const decision of ["merged", "kept_separate", "invalid"]) for (const group of ["decision", "decisionHelp"]) assert.ok(keys.has(`${group}.${decision}`), `${group}.${decision}`);
  for (const flag of ["ok", "suspect", "invalid", "empty"]) assert.ok(keys.has(`phoneFlag.${flag}`), flag);
  for (const field of ["customer_name", "phone_or_email", "received_at", "source"]) assert.ok(keys.has(`field.${field}`), field);
  for (const matched of ["phone", "email", "meta_leadgen_id"]) assert.ok(keys.has(`matchedOn.${matched}`), matched);
  assert.match(found[1], /派发/);
  assert.match(found[1], /重复/);
});

test("the interface labels Show room, FB and ins are not touched by the new strings", () => {
  const added = block(read("src/lib/i18n/translations.ts"), "dispatch").join("\n");
  for (const label of ["Show room", "FB", "ins"]) assert.equal(added.includes(label), false, label);
});

test("the /dispatch page and routes are staff only; the sidebar contract is unchanged", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /"\/dispatch": \["admin", "boss", "operator"\]/);
  assert.match(proxy, /"\/dispatch\/:path\*"/);
  const page = read("src/app/(dashboard)/dispatch/page.tsx");
  assert.match(page, /roles: \["admin", "boss", "operator"\]/);
  assert.equal(page.includes('"sales"'), false);
  for (const file of ["src/components/Sidebar.tsx", "src/components/sidebar.tsx"]) {
    if (fs.existsSync(new URL(`../../${file}`, import.meta.url))) assert.equal(read(file).includes("/dispatch"), false, `${file} is not changed by this batch`);
  }
});

test("the lead page shows a dispatch label card and the card hides itself when there is no state", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.match(page, /import LeadDispatchCard from "\.\/LeadDispatchCard"/);
  assert.match(page, /<LeadDispatchCard lead=\{lead\} t=\{t\} role=\{salesRole\} \/>/);
  const card = read("src/app/(dashboard)/leads/[id]/LeadDispatchCard.tsx");
  assert.match(card, /data-testid="lead-dispatch-card"/);
  assert.match(card, /\/api\/dispatch\//);
  assert.match(card, /return null/);
});

test("the hot paths are untouched: no hook in lead creation, assignment, the WhatsApp webhook or the follow-up code", () => {
  for (const file of ["src/app/api/leads/route.ts", "src/app/api/leads/[id]/assignment/route.ts", "src/app/api/whatsapp/webhook/route.ts",
    "src/lib/whatsapp-ctwa-ingest.mjs", "src/lib/lead-duplicates.ts"]) {
    assert.doesNotMatch(read(file), /lead_dispatch|lead-dispatch|duplicate_reviews|evaluate_lead_dispatch|sweep_lead_dispatch|api\/dispatch/i, file);
  }
});

test("no new application file sends Meta feedback, a message or a notification", () => {
  const files = ["src/lib/lead-dispatch.mjs", "src/lib/lead-dispatch-api.ts", "src/components/dispatch/DispatchWorkbench.tsx", "src/components/dispatch/shared.ts",
    "src/app/api/dispatch/queue/route.ts", "src/app/api/dispatch/refresh/route.ts", "src/app/api/dispatch/[leadId]/route.ts", "src/app/api/dispatch/[leadId]/decide/route.ts",
    "src/app/api/duplicates/route.ts", "src/app/api/duplicates/[id]/route.ts", "src/app/api/duplicates/[id]/resolve/route.ts", "src/app/api/duplicates/[id]/reopen/route.ts",
    "src/app/api/cron/dispatch-sweep/route.ts"];
  for (const file of files) assert.doesNotMatch(read(file), /whatsapp|capi|meta[-_]|graph\.facebook|sendMessage|notifications/i, file);
});

test("the backfill is a gate script, dry run by default, and the application has no bulk button", () => {
  const script = read("scripts/s24-dispatch-backfill.sql");
  assert.match(script, /\\if :\{\?apply\}/);
  assert.match(script, /dry run/i);
  assert.match(script, /sweep_lead_dispatch\('1970-01-01'/);
  const client = read("src/components/dispatch/DispatchWorkbench.tsx");
  assert.equal(client.includes("1970"), false);
  assert.match(client, /\/api\/dispatch\/refresh/);
});

test("the S24 database objects are known to the schema reference check", () => {
  const tables = read("scripts/schema-tables.txt").split("\n");
  for (const name of ["lead_dispatch_state", "duplicate_reviews", "lead_dispatch_events"]) assert.ok(tables.includes(name), name);
});
