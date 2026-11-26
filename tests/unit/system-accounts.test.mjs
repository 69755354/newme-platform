// OS fix S19: QA accounts (@qa.newme.ae) and release-acceptance accounts
// (release-uat-*) must not show up in lists real people read, while their own
// login, the assignment checks and the release gate keep working.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isSystemAccountEmail,
  isSystemAccount,
  systemAccountVisibilityFilter,
  excludeSystemAccountsQuery,
  omitSystemAccounts,
  systemAccountIdSet,
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
  ["src/app/api/activity/daily-report/route.ts", /systemAccountIdSet\(/],
  ["src/app/api/dashboard/lead-sources/route.ts", /systemAccountIdSet\(/],
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
  // The user list has no switch that shows them (S47): hidden for admin and boss alike,
  // the signed-in account keeps its own row.
  const users = read("src/app/api/users/route.ts");
  assert.doesNotMatch(users, /includeSystem/);
  assert.match(users, /excludeSystemAccountsQuery\(userQuery, \{ viewerId: role\.userId \}\)/);
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

test("system account id set: ids of in-memory rows, the viewer's own row is never in it", () => {
  const rows = [
    { id: "1", email: "sam@newme.ae" },
    { id: "2", email: "qa-boss@qa.newme.ae" },
    { id: VIEWER, email: "release-uat-sales@newme.ae" },
    { id: "4", email: "release-uat-admin@newme.ae" },
    { id: "5", email: null },
    { email: "qa-x@qa.newme.ae" },
  ];
  assert.deepEqual([...systemAccountIdSet(rows)].sort(), ["2", "4", VIEWER].sort());
  assert.deepEqual([...systemAccountIdSet(rows, { viewerId: VIEWER })].sort(), ["2", "4"]);
  assert.deepEqual([...systemAccountIdSet(null)], []);
});

test("daily report and lead-source assignment drop system accounts before building rows", () => {
  const report = read("src/app/api/activity/daily-report/route.ts");
  assert.match(report, /\.select\("id, full_name, email"\)/);
  assert.match(report, /hiddenUserIds = systemAccountIdSet\(profiles\)/);
  assert.match(report, /!a\.user_id \|\| hiddenUserIds\.has\(a\.user_id\)/);
  assert.match(report, /!e\.user_id \|\| hiddenUserIds\.has\(e\.user_id\)/);
  const sources = read("src/app/api/dashboard/lead-sources/route.ts");
  assert.match(sources, /hiddenRepIds = systemAccountIdSet\(reps \?\? \[\], \{ viewerId: user\.id \}\)/);
  assert.match(sources, /if \(hiddenRepIds\.has\(repId\)\) return;/);
});

// ── Inventory guard (S47) ──────────────────────────────────────────────────────
// Every file under src that reads `profiles` is either filtered through the shared
// module or listed here as reviewed. A new `from("profiles")` read in a new file
// fails this test until someone decides which of the two it is.
// Files that read `profiles` and were reviewed in the S47 inventory as NOT needing the filter.
// self: the signed-in account reads its own role/profile (must keep working for system accounts).
// recipients: notification fan-out; nothing a person reads is built from it (see inventory).
// validation_or_write: id-based checks / writes; system accounts stay legal targets on purpose.
// name_by_id: the display name of an id already present in the data (not a people list).
const REVIEWED_UNFILTERED = {
  name_by_id: [
    "src/lib/lead-duplicates.ts", // owner names for duplicate hints, looked up by id
    "src/app/(dashboard)/leads/[id]/page.tsx",
    "src/app/api/contracts/[id]/remind-payment/route.ts",
    "src/app/api/contracts/[id]/route.ts",
    "src/app/api/contracts/list/route.ts",
    "src/app/api/dashboard/lead-health/route.ts",
    "src/app/api/kpi/targets/route.ts",
    "src/app/api/leads/[id]/transfer-history/route.ts",
  ],
  self: [
    "src/app/api/notifications/unread-count/route.ts", // the signed-in user's own role
    "src/app/(dashboard)/projects/projects-client.tsx",
    "src/app/api/ads/leads/route.ts",
    "src/app/api/alerts/route.ts",
    "src/app/api/auth/me/route.ts",
    "src/app/api/contracts/[id]/approve/route.ts",
    "src/app/api/contracts/[id]/confirm-upload/route.ts",
    "src/app/api/contracts/[id]/upload-url/route.ts",
    "src/app/api/contracts/route.ts",
    "src/app/api/dashboard/ads-roi/import/route.ts",
    "src/app/api/dashboard/ads-roi/route.ts",
    "src/app/api/dashboard/pipeline-funnel/route.ts",
    "src/app/api/dashboard/quality/route.ts",
    "src/app/api/dashboard/weekly-trends/route.ts",
    "src/app/api/leads/[id]/timeline/route.ts",
    "src/app/api/leads/follow-up-overdue/route.ts",
    "src/app/api/leads/import/confirm/route.ts",
    "src/app/api/leads/import/preview/route.ts",
    "src/app/api/meta/ads-status/route.ts",
    "src/app/api/meta/ads-sync/route.ts",
    "src/app/api/meta/oauth-start/route.ts",
    "src/app/api/metrics/daily/route.ts",
    "src/app/api/metrics/funnel/route.ts",
    "src/app/api/notifications/[id]/route.ts",
    "src/app/api/notifications/route.ts",
    "src/app/api/payments/[id]/allocate/route.ts",
    "src/app/api/payments/[id]/confirm/route.ts",
    "src/app/api/payments/[id]/void/route.ts",
    "src/app/api/payments/list/route.ts",
    "src/app/api/payments/route.ts",
    "src/app/api/products/import/route.ts",
    "src/app/api/quotations/export/route.ts",
    "src/app/api/team/list/route.ts",
    "src/app/api/workbench/route.ts",
    "src/app/api/workflow/route.ts",
    "src/lib/action-auth-context.ts",
    "src/lib/lead-auth.ts",
    "src/lib/request-auth-context.ts",
    "src/lib/server-page-auth.ts",
    "src/proxy.ts",
  ],
  validation_or_write: [
    "src/app/actions/team.ts",
    "src/app/api/admin/impersonate/route.ts",
    "src/app/api/auth/change-password/route.ts",
    "src/app/api/dev/setup/route.ts",
    "src/app/api/leads/archive/route.ts",
    "src/app/api/tasks/[id]/route.ts",
    "src/app/api/users/[id]/password/route.ts",
    "src/app/api/users/[id]/route.ts",
    "src/lib/notification-dispatch.ts",
  ],
  recipients: [
    "src/lib/leave-cover.mjs", // resolves the stand-in for given recipient ids; never lists people
    "src/app/api/cron/check-overdue-installments/route.ts",
    "src/app/api/cron/check-whatsapp-followups/route.ts",
    "src/app/api/cron/daily-digest/route.ts",
    "src/lib/lead-intake-notify.mjs",
    "src/lib/notification-events.ts",
    "src/lib/notifications.ts",
  ],
};

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const stat = statSync(join(ROOT, rel));
    if (stat.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.d\.(ts|mts)$/.test(name)) out.push(rel);
  }
  return out;
}

test("inventory: every profiles reader is filtered or on the reviewed list", () => {
  const readers = sourceFiles("src").filter((file) => /from\((['"])profiles\1\)/.test(read(file)));
  const reviewed = new Set(Object.values(REVIEWED_UNFILTERED).flat());
  const filtered = readers.filter((file) => /system-accounts|hideSystemAccounts|lead-transfer-candidates/.test(read(file)));
  const unclassified = readers.filter((file) => !filtered.includes(file) && !reviewed.has(file));
  assert.deepEqual(unclassified, [], "new profiles reader: filter it or add it to REVIEWED_UNFILTERED with a reason");
  const stale = [...reviewed].filter((file) => !readers.includes(file));
  assert.deepEqual(stale, [], "listed file no longer reads profiles");
  const both = [...reviewed].filter((file) => filtered.includes(file));
  assert.deepEqual(both, [], "a file is both filtered and listed as unfiltered");
});

test("inventory: the self-lookup files never use the filter (a system account must see itself)", () => {
  for (const file of REVIEWED_UNFILTERED.self) {
    assert.doesNotMatch(read(file), /system-accounts|hideSystemAccounts/, file);
  }
});
