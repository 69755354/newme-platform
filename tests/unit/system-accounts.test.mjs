// OS fix S19: QA accounts (@qa.newme.ae) and release-acceptance accounts
// (release-uat-*) must not show up in lists real people read, while their own
// login, the assignment checks and the release gate keep working.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSystemAccountEmail,
  isSystemAccount,
  systemAccountVisibilityFilter,
  excludeSystemAccountsQuery,
  omitSystemAccounts,
} from "../../src/lib/system-accounts.mjs";
import {
  filterLeadTransferCandidateQuery,
} from "../../src/lib/lead-transfer-candidates.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const VIEWER = "7c4f1a2e-1111-4111-8111-111111111111";

test("QA and release-acceptance e-mails are system accounts, real ones are not", () => {
  for (const email of [
    "qa-admin@qa.newme.ae", "QA-Boss@QA.NEWME.AE", "qa-sales-a@qa.newme.ae",
    "release-uat-admin@newme.ae", "Release-UAT-sales@newme.ae", " release-uat-ops@newme.ae ",
  ]) assert.equal(isSystemAccountEmail(email), true, email);
  for (const email of [
    "sam@newme.ae", "tanya@newme.ae", "ayana@newme.ae", "assem@newme.ae",
    "a@qa.newme.ae.evil.com", "qa.newme.ae@gmail.com", "my-release-uat-x@newme.ae",
    "", null, undefined, 42,
  ]) assert.equal(isSystemAccountEmail(email), false, String(email));
  assert.equal(isSystemAccount({ email: "qa-admin@qa.newme.ae" }), true);
  assert.equal(isSystemAccount({ email: "sam@newme.ae" }), false);
  assert.equal(isSystemAccount(null), false);
});

test("the query filter keeps people without e-mail, real people and the viewer", () => {
  assert.equal(
    systemAccountVisibilityFilter(),
    "email.is.null,and(email.not.ilike.*@qa.newme.ae,email.not.ilike.release-uat-*)",
  );
  assert.equal(
    systemAccountVisibilityFilter({ viewerId: VIEWER }),
    `email.is.null,and(email.not.ilike.*@qa.newme.ae,email.not.ilike.release-uat-*),id.eq.${VIEWER}`,
  );
  // A viewer id that is not a UUID must never reach the filter string.
  assert.equal(
    systemAccountVisibilityFilter({ viewerId: "x),id.neq.0" }),
    systemAccountVisibilityFilter(),
  );
  const calls = [];
  const query = { or(filter) { calls.push(filter); return this; } };
  assert.equal(excludeSystemAccountsQuery(query, { viewerId: VIEWER }), query);
  assert.deepEqual(calls, [systemAccountVisibilityFilter({ viewerId: VIEWER })]);
});

test("in-memory rows: system accounts are dropped, the viewer's own row is kept", () => {
  const rows = [
    { id: "1", email: "sam@newme.ae" },
    { id: "2", email: "qa-boss@qa.newme.ae" },
    { id: VIEWER, email: "release-uat-sales@newme.ae" },
    { id: "4", email: "release-uat-admin@newme.ae" },
    { id: "5", email: null },
  ];
  assert.deepEqual(omitSystemAccounts(rows).map((r) => r.id), ["1", "5"]);
  assert.deepEqual(omitSystemAccounts(rows, { viewerId: VIEWER }).map((r) => r.id), ["1", VIEWER, "5"]);
  assert.deepEqual(omitSystemAccounts(null), []);
});

test("assignee candidate query: plain call is the unchanged assignment rule, opt-in hides system accounts", () => {
  const make = () => {
    const calls = [];
    const query = {
      in(column, values) { calls.push(["in", column, values]); return this; },
      eq(column, value) { calls.push(["eq", column, value]); return this; },
      or(filter) { calls.push(["or", filter]); return this; },
    };
    return { calls, query };
  };
  const plain = make();
  assert.equal(filterLeadTransferCandidateQuery(plain.query), plain.query);
  assert.deepEqual(plain.calls, [
    ["in", "role", ["sales", "operator", "boss"]],
    ["eq", "is_active", true],
  ]);
  const hidden = make();
  filterLeadTransferCandidateQuery(hidden.query, { hideSystemAccounts: true, viewerId: VIEWER });
  assert.deepEqual(hidden.calls, [
    ["in", "role", ["sales", "operator", "boss"]],
    ["eq", "is_active", true],
    ["or", systemAccountVisibilityFilter({ viewerId: VIEWER })],
  ]);
});

// Every list that real people read goes through the shared rule.
const LIST_SITES = [
  ["src/app/api/users/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/settings/data/route.ts", /hideSystemAccounts: true/],
  ["src/app/api/leads/list/route.ts", /hideSystemAccounts: true/],
  ["src/app/(dashboard)/leads/[id]/useLeadDetailData.ts", /hideSystemAccounts: true/],
  ["src/app/api/dashboard/sales-load/rebalance/route.ts", /hideSystemAccounts: true/],
  ["src/app/api/pipeline/list/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/dashboard/summary/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/dashboard/team-ownership/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/dashboard/team-performance/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/dashboard/sales-load/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/dashboard/payment-tracker/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/dashboard/weekly-review/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/analytics/summary/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/command-center/route.ts", /excludeSystemAccountsQuery\(/],
  ["src/app/api/tasks/list/route.ts", /excludeSystemAccountsQuery\(/],
];

for (const [file, pattern] of LIST_SITES) {
  test(`${file} hides system accounts through the shared module`, () => {
    const source = read(file);
    assert.match(source, pattern);
    if (!/hideSystemAccounts/.test(source)) {
      assert.match(source, /from "@\/lib\/system-accounts\.mjs"|from '@\/lib\/system-accounts\.mjs'/);
    }
  });
}

test("the rule is not hard-coded outside the shared module", () => {
  for (const [file] of LIST_SITES) {
    const source = read(file);
    assert.doesNotMatch(source, /qa\.newme\.ae|release-uat/i, file);
  }
});

test("release gate paths keep working", () => {
  // The assignment checks (is this id a legal assignee) use the plain rule, so
  // synthetic checks and the regression run can still hand a lead to a QA account.
  const reassignment = read("src/lib/lead-reassignment.mjs");
  assert.doesNotMatch(reassignment, /hideSystemAccounts|system-accounts/);
  // /api/leads/list is what scripts/synthetic-journey.mjs reads its assignee
  // directory from; the signed-in account stays visible to itself there.
  assert.match(read("src/app/api/leads/list/route.ts"), /viewerId: user\.id|viewerId: userId/);
  // The user list keeps an explicit way to see everything for the admin/boss
  // callers of /api/users (same rule for both roles).
  const users = read("src/app/api/users/route.ts");
  assert.match(users, /includeSystem/);
  assert.doesNotMatch(users, /role === "admin" && .*includeSystem|includeSystem.*role === "admin"/);
  // The acceptance and synthetic scripts never read the team list or the user list.
  for (const script of ["scripts/run-postdeploy-browser-uat.mjs", "scripts/run-postdeploy-acceptance.mjs", "scripts/synthetic-journey.mjs"]) {
    assert.doesNotMatch(read(script), /\/api\/users|\/api\/team|team-ownership/, script);
  }
});

test("login, session and profile reads of the signed-in account are not filtered", () => {
  for (const file of [
    "src/proxy.ts", "src/lib/request-auth-context.ts", "src/lib/action-auth-context.ts",
    "src/lib/server-page-auth.ts", "src/app/api/auth/me/route.ts", "src/lib/lead-auth.ts",
  ]) {
    assert.doesNotMatch(read(file), /system-accounts|hideSystemAccounts/, file);
  }
});
