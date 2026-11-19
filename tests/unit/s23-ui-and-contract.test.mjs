import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

function block(src, name) {
  // the S23 blocks: "    name: {" at language level up to its closing "    },"
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

test("both languages carry the same keys for opportunities and visits, and every key the screens use", () => {
  const src = read("src/lib/i18n/translations.ts");
  for (const name of ["opportunities", "visits"]) {
    const found = block(src, name);
    assert.equal(found.length, 2, `${name}: one block per language`);
    assert.deepEqual(paths(found[0]), paths(found[1]), `${name}: same keys in both languages`);
    const keys = new Set(paths(found[0]));
    const files = ["src/components/opportunity-visit/OpportunityPanel.tsx", "src/components/opportunity-visit/VisitPanel.tsx", "src/components/opportunity-visit/shared.ts",
      "src/app/(dashboard)/leads/[id]/LeadOpportunitiesCard.tsx", "src/app/(dashboard)/leads/[id]/LeadVisitsCard.tsx",
      "src/app/(dashboard)/opportunities/opportunities-client.tsx", "src/app/(dashboard)/visits/visits-client.tsx"];
    for (const file of files) {
      for (const [, key] of read(file).matchAll(new RegExp(`t\\("${name}\\.([\\w.]+)"\\)`, "g"))) assert.ok(keys.has(key), `${file}: ${name}.${key}`);
    }
  }
  const visits = block(src, "visits");
  for (const status of ["planned", "approved", "completed", "reviewed", "overdue"]) assert.match(visits[0], new RegExp(`${status}:`));
  assert.match(block(src, "opportunities")[1], /商机/);
  assert.match(visits[1], /拜访/);
  // dynamic keys used by the panels
  const keys = new Set(paths(visits[0]));
  for (const status of ["planned", "approved", "completed", "reviewed", "overdue"]) assert.ok(keys.has(`status.${status}`));
  for (const a of ["pending", "approved", "rejected"]) assert.ok(keys.has(`planApproval.${a}`));
  for (const r of ["pending", "accepted", "needs_fix"]) assert.ok(keys.has(`reviewStatus.${r}`));
  const shared = read("src/components/opportunity-visit/shared.ts");
  for (const value of [...new Set([...shared.matchAll(/: "(\w+)"/g)].map((m) => m[1]))].filter((v) => /^[a-z][a-zA-Z]+$/.test(v))) {
    // every error key named in the maps exists in both namespaces' error blocks or is unused by one of them
    const used = ["opportunities", "visits"].some((ns) => new Set(paths(block(src, ns)[0])).has(`error.${value}`));
    if (/^(required|invalid|tooLong|outOfRange|quoteRequired|unknownStage|inactiveStage|beforeStart|duplicate|forbidden|locked|notApproved|incomplete|noteRequired)$/.test(value)) assert.ok(used, `error.${value}`);
  }
});

test("the interface labels Show room, FB and ins are not touched by the new strings", () => {
  const src = read("src/lib/i18n/translations.ts");
  const added = [...block(src, "opportunities"), ...block(src, "visits")].join("\n");
  for (const label of ["Show room", "FB", "ins"]) assert.equal(added.includes(label), false, label);
  for (const file of ["src/components/opportunity-visit/OpportunityPanel.tsx", "src/components/opportunity-visit/VisitPanel.tsx"]) {
    const code = read(file).split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(code, /Show room|"FB"|"ins"/);
  }
});

test("the lead page shows both cards for the roles that may use them and passes the resolved role", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.match(page, /<LeadOpportunitiesCard lead=\{lead\} t=\{t\} lang=\{lang\} role=\{salesRole\} \/>/);
  assert.match(page, /<LeadVisitsCard lead=\{lead\} t=\{t\} role=\{salesRole\} \/>/);
  for (const card of ["LeadOpportunitiesCard", "LeadVisitsCard"]) {
    const src = read(`src/app/(dashboard)/leads/[id]/${card}.tsx`);
    assert.match(src, /\["admin", "boss", "operator", "sales"\]\.includes\(role\)/);
  }
});

test("the list pages are guarded for the four roles and listed in the edge matcher; the sidebars are unchanged", () => {
  for (const page of ["opportunities", "visits"]) {
    const src = read(`src/app/(dashboard)/${page}/page.tsx`);
    assert.match(src, /authorizeServerPage\(\{ roles: \["admin", "boss", "operator", "sales"\] \}\)/);
  }
  const proxy = read("src/proxy.ts");
  for (const route of ["opportunities", "visits"]) {
    assert.match(proxy, new RegExp(`"/${route}": \\["admin", "boss", "operator", "sales"\\]`));
    assert.match(proxy, new RegExp(`"/${route}/:path\\*"`));
  }
  // The sidebar contract is checked by the post-deploy browser acceptance (CANONICAL_NAV_BY_ROLE); adding the two
  // links belongs to the change that updates that contract, after the database batch is provisioned.
  const nav = read("src/lib/nav.ts");
  assert.equal(nav.includes("/opportunities"), false);
  assert.equal(nav.includes("/visits"), false);
});

test("approving and reviewing buttons are for staff only in the screen, and the API checks again", () => {
  const panel = read("src/components/opportunity-visit/VisitPanel.tsx");
  assert.match(panel, /canReviewVisits\(role\)/);
  assert.match(panel, /staff && !v\.submitted_at && v\.plan_approval !== "approved"/);
  for (const route of ["approve", "review"]) {
    const src = read(`src/app/api/visits/[id]/${route}/route.ts`);
    assert.match(src, /^\/\/ RBAC: admin, boss, operator\./);
    assert.ok(src.indexOf("canReviewVisits(context.role)") < src.indexOf("supabaseAdmin.rpc"));
  }
});

test("every S23 API route states its RBAC first, never caches and checks the role before a service-role query", () => {
  const files = ["opportunities/route.ts", "opportunities/[id]/route.ts", "visits/route.ts", "visits/[id]/route.ts",
    "visits/[id]/approve/route.ts", "visits/[id]/submit/route.ts", "visits/[id]/review/route.ts"];
  for (const file of files) {
    const src = read(`src/app/api/${file}`);
    assert.match(src, /^\/\/ RBAC: /, file);
    assert.match(src, /export const dynamic = "force-dynamic"/, file);
  }
  const helper = read("src/lib/opportunity-visit-api.ts");
  assert.match(helper, /private, no-store/);
  assert.match(helper, /import "server-only"/);
});

test("migration contract: rollback declaration, definer entry guard, pinned search_path, no client writes, no destructive statement", () => {
  const sql = read("supabase/migrations/20261119200000_opportunities_and_visit_reports.sql");
  assert.match(sql, /^-- NO_ROLLBACK: \S/);
  const definers = sql.match(/security definer\nset search_path = pg_catalog, public, pg_temp/g) ?? [];
  assert.equal(definers.length, 4);
  assert.equal((sql.match(/perform public\.assert_current_session_at_entry\(\);/g) ?? []).length, 4);
  assert.match(sql, /revoke all on table public\.opportunity_stages, public\.opportunities, public\.visit_reports from public, anon, authenticated, service_role;/);
  assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]*\bto[^;]*authenticated/i);
  assert.doesNotMatch(sql, /grant (insert|update|delete)\s+on\s+public\.(opportunities|visit_reports)/i);
  assert.doesNotMatch(sql, /grant execute on function public\.(visit_report_(set_plan_approval|submit|review)|flag_overdue_visit_reports)[^;]*(authenticated|anon)/i);
  assert.doesNotMatch(sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n"), /\bdrop (table|column|schema)\b|\bdelete from\b|\btruncate\b/i);
  for (const table of ["opportunity_stages", "opportunities", "visit_reports"]) assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`));
  // sessions are checked the repository's way: wrapped in a select, never bare
  assert.doesNotMatch(sql, /using \(public\.session_token_is_current\(\)|and public\.session_token_is_current\(\)/);
  assert.equal((sql.match(/\(select public\.session_token_is_current\(\)\)/g) ?? []).length, 5);
});

test("the release manifest, the schema list and the CI step carry the S23 batch", () => {
  const manifest = JSON.parse(read("infra/release/release-manifest.json"));
  const entry = manifest.deferred_contract.find((m) => m.version === "20261119200000");
  assert.equal(entry.file, "20261119200000_opportunities_and_visit_reports.sql");
  assert.equal(manifest.posture.deferred_contract.predicates.some((p) => p.name === "s23-opportunities-visit-reports-present"), true);
  const tables = read("scripts/schema-tables.txt").split("\n");
  for (const table of ["opportunities", "opportunity_stages", "visit_reports"]) assert.ok(tables.includes(table), table);
  assert.match(read(".github/workflows/ci.yml"), /tests\/database\/s23-opportunities-visits\.sql/);
  const schedule = JSON.parse(read("infra/cron/schedule.json"));
  const cron = schedule.endpoints.find((e) => e.name === "check-visit-overdue");
  assert.equal(cron.install, "after-flag");
  assert.match(read("src/app/api/cron/check-visit-overdue/route.ts"), /VISIT_OVERDUE_ALERTS_ENABLED/);
});
