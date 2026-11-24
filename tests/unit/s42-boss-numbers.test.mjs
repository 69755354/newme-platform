// S42 "boss numbers and management" (recheck 2026-11-24 §2-11..18, 21, 22, 24 and N4/N7/N8).
// Pure helpers are tested directly; page-level fixes are asserted on the source (the repo has no DOM test runner).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isCreatedToday, isUncontactedOver1h, summarizeLeads } from "../../src/lib/lead-metrics.mjs";
import { humanizeTransferText, isRawTransferActivity, transferUuids } from "../../src/lib/lead-transfer-text.mjs";
import { localizeServerText } from "../../src/lib/i18n/server-text.mjs";
import { addDaysToDateKey, dubaiDateKey } from "../../src/lib/dubai-time.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const NOW = new Date("2026-11-24T08:00:00.000Z"); // 12:00 Dubai, 24 Nov 2026
const lead = (o) => ({ archived: false, stage: "new", final_status: null, created_at: "2026-10-01T08:00:00Z", ...o });

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

// ── §2-11 ③ / N4: "Zero Follow-up" is "never contacted", not "no follow-up counter" ───────────────────────────────
test("S42 zero follow-up counts only leads with no last_contact_date (quick log / quote do not bump followup_count)", () => {
  const rows = [
    lead({ id: "a", last_contact_date: "2026-11-23", followup_count: 0 }), // logged a contact through "记一笔"
    lead({ id: "b", last_contact_date: null, followup_count: 0 }),
    lead({ id: "c", last_contact_date: "2026-11-20", followup_count: 3 }),
  ];
  const s = summarizeLeads(rows, { now: NOW });
  assert.equal(s.zeroFollowup, 1);
});

// ── §2-12 F09: the three cockpit counters ─────────────────────────────────────────────────────────────────────────
test("S42 today's new / uncontacted over 1h / unassigned are counted on the Dubai calendar and on active leads only", () => {
  const rows = [
    lead({ id: "today1", created_at: "2026-11-23T21:00:00Z" }),              // 01:00 Dubai 24 Nov: today, >1h, uncontacted
    lead({ id: "today2", created_at: "2026-11-24T07:30:00Z", assigned_to: "u1" }), // 11:30 Dubai: today, 30 min old -> not over 1h
    lead({ id: "yday", created_at: "2026-11-23T19:00:00Z" }),                // 23:00 Dubai 23 Nov: yesterday
    lead({ id: "old-contacted", created_at: "2026-11-01T08:00:00Z", last_contact_date: "2026-11-02", assigned_to: "u1" }),
    lead({ id: "won", created_at: "2026-11-24T05:00:00Z", final_status: "won", assigned_to: "u1" }),
    lead({ id: "arch", created_at: "2026-11-24T05:00:00Z", archived: true }),
  ];
  const s = summarizeLeads(rows, { now: NOW });
  assert.equal(s.newToday, 3, "today1, today2 and the won lead were created today (archived never counts)");
  assert.equal(s.uncontactedOver1h, 2, "today1 and yday: active, never contacted, older than one hour");
  assert.equal(s.unassignedActive, 2, "today1 and yday have no owner");
  assert.equal(isCreatedToday(rows[0], NOW), true);
  assert.equal(isCreatedToday(rows[2], NOW), false);
  assert.equal(isUncontactedOver1h(rows[1], NOW), false);
  assert.equal(isUncontactedOver1h(rows[4], NOW), false, "a closed lead is not waiting for a first contact");
});

test("S42 cockpit shows the three counters with links to the matching lists", () => {
  const page = read("src/app/(dashboard)/dashboard/page.tsx");
  assert.match(page, /leadStats\.newToday/);
  assert.match(page, /leadStats\.uncontactedOver1h/);
  assert.match(page, /leadStats\.unassignedActive/);
  assert.match(page, /\/leads\?alert=created_today/);
  assert.match(page, /\/leads\?alert=uncontacted_1h/);
  assert.match(page, /\/dispatch\?tab=unassigned/);
  const filtering = read("src/app/(dashboard)/leads/_hooks/useLeadsFiltering.ts");
  assert.match(filtering, /alertFilter === "created_today"/);
  assert.match(filtering, /alertFilter === "uncontacted_1h"/);
  const dispatch = read("src/components/dispatch/DispatchWorkbench.tsx");
  assert.match(dispatch, /searchParams\.get\("tab"\)|get\("tab"\)/);
  // "Needs follow-up" is renamed to what it filters: every overdue follow-up.
  const i18n = read("src/lib/i18n/translations.ts");
  assert.doesNotMatch(i18n, /needsFollowup: "Needs follow-up",\n(.*\n){0,8}.*allSources/);
});

// ── §2-11 ①: the target line says "not set" once ─────────────────────────────────────────────────────────────────
test("S42 header never prints 'No target set · No target set'", () => {
  const page = read("src/app/(dashboard)/dashboard/page.tsx");
  assert.match(page, /s42\.noTargets/);
  assert.doesNotMatch(page, /t\("dashboard\.noTargetSet"\)} · \$\{collectionTarget > 0/);
});

// ── §2-11 ②: boss workbench progress is the caller's own leads ───────────────────────────────────────────────────
test("S42 workbench progress card counts the caller's leads for every role", () => {
  const route = read("src/app/api/workbench/route.ts");
  const progressBlock = route.slice(route.indexOf("// progress"), route.indexOf("// progress") + 400);
  assert.match(progressBlock, /\.eq\("assigned_to", user\.id\)/);
  assert.doesNotMatch(progressBlock, /if \(isSales\) q = q\.eq\("assigned_to", user\.id\)/);
});

// ── §2-11 ④: ads page says which window and grouping the total uses ─────────────────────────────────────────────
test("S42 ads page states the time window and the grouping under the total", () => {
  const page = read("src/app/(dashboard)/ads/page.tsx");
  assert.match(page, /s42\.ads\.scope/);
  assert.match(page, /data-testid="ads-scope"/);
});

// ── §2-13 F18: no UUID in the reassignment timeline ──────────────────────────────────────────────────────────────
test("S42 raw transfer activity text is recognised and rewritten with names", () => {
  const text = `Lead reassigned from ${UUID_A} to ${UUID_B}`;
  assert.equal(isRawTransferActivity(text), true);
  assert.equal(isRawTransferActivity("Lead reassigned from unassigned to " + UUID_B), true);
  assert.equal(isRawTransferActivity("Called the customer"), false);
  assert.deepEqual(transferUuids(text), [UUID_A, UUID_B]);
  const names = new Map([[UUID_A, "Sales A"], [UUID_B, "Sales B"]]);
  assert.equal(humanizeTransferText(text, (id) => names.get(id)), "Lead reassigned from Sales A to Sales B");
  assert.equal(humanizeTransferText(`Lead unassigned from ${UUID_A}`, (id) => names.get(id)), "Lead unassigned from Sales A");
  // Unknown id: never print the UUID
  assert.doesNotMatch(humanizeTransferText(`Lead reassigned from ${UUID_A} to ${UUID_B}`, () => null), /[0-9a-f]{8}-/);
  assert.equal(localizeServerText("Lead reassigned from Sales A to Sales B", "zh"), "线索从 Sales A 转给 Sales B");
});

test("S42 lead page hides the raw activity row (the business event already says it in words) and the timeline API resolves names", () => {
  const timeline = read("src/app/(dashboard)/leads/[id]/LeadTimeline.tsx");
  assert.match(timeline, /isRawTransferActivity/);
  const route = read("src/app/api/leads/[id]/timeline/route.ts");
  assert.match(route, /humanizeTransferText/);
});

// ── §2-14 F19: no native prompt(), the lead page's quick-log sheet instead ───────────────────────────────────────
test("S42 dashboard Log button and analytics overdue list use the quick-log sheet, not prompt()", () => {
  const dash = read("src/app/(dashboard)/dashboard/page.tsx");
  const health = read("src/app/(dashboard)/analytics/_components/LeadHealth.tsx");
  for (const [name, src] of [["dashboard", dash], ["LeadHealth", health]]) {
    assert.doesNotMatch(src, /\bprompt\(/, `${name} still calls prompt()`);
    assert.doesNotMatch(src, /\balert\(/, `${name} still calls alert()`);
    assert.match(src, /QuickLogSheet/, `${name} does not use the shared sheet`);
  }
  const sheet = read("src/components/leads/QuickLogSheet.tsx");
  assert.match(sheet, /\/api\/leads\/\$\{[^}]+\}\/contacts/);
  assert.match(sheet, /quickLogBody\(/);
  assert.match(sheet, /side="bottom"/);
});

// ── §2-15 F21: add-user copy ─────────────────────────────────────────────────────────────────────────────────────
test("S42 add-user dialog no longer promises an activation e-mail", () => {
  const i18n = read("src/lib/i18n/translations.ts");
  assert.doesNotMatch(i18n, /activation email/i);
  assert.doesNotMatch(i18n, /激活邮件/);
  assert.match(i18n, /addNewUserDesc: "[^"]*initial password[^"]*"/i);
  assert.match(i18n, /addNewUserDesc: "[^"]*初始密码[^"]*"/);
});

// ── §2-16 F23: analytics panels reserve their height while loading ──────────────────────────────────────────────
test("S42 analytics loading, error and empty states reserve the panel height (CLS)", () => {
  const dir = "src/app/(dashboard)/analytics/_components";
  for (const name of ["LeadHealth", "PipelineFunnel", "PaymentTracker", "AdsROI", "WeeklyTrends", "SalesLoad", "LeadSources", "TeamPerformance"]) {
    const src = read(`${dir}/${name}.tsx`);
    const loading = src.slice(src.indexOf("if (loading)"), src.indexOf("if (loading)") + 400);
    assert.match(loading, /min-h-\[/, `${name} loading state has no minimum height`);
  }
  const page = read("src/app/(dashboard)/analytics/page.tsx");
  assert.match(page, /min-h-\[/);
});

// ── §2-17 F22: import requires a source ─────────────────────────────────────────────────────────────────────────
test("S42 import preview refuses rows without a source and confirm never writes a lead with no source", () => {
  const preview = read("src/app/api/leads/import/preview/route.ts");
  assert.match(preview, /Source is required/);
  const confirm = read("src/app/api/leads/import/confirm/route.ts");
  assert.match(confirm, /Source is required/);
  const dialog = read("src/components/leads/ExcelImportDialog.tsx");
  assert.match(dialog, /s42\.import\.sourceRequired/);
});

// ── §2-18 F27: lead not found / no access ───────────────────────────────────────────────────────────────────────
test("S42 lead page explains not-found-or-no-access and offers the way back", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  const block = page.slice(page.indexOf("if (notFound || !lead)"), page.indexOf("if (notFound || !lead)") + 700);
  assert.match(block, /s42\.leadNotFound/);
  assert.match(block, /s42\.backToLeads/);
  assert.match(block, /router\.push\("\/leads"\)/);
});

// ── §2-21 F26: funnel stage names are translated ───────────────────────────────────────────────────────────────
test("S42 analytics funnel shows stage names through translations, not the API's English labels", () => {
  const src = read("src/app/(dashboard)/analytics/_components/PipelineFunnel.tsx");
  assert.match(src, /translatedOrRaw\(t, `stages\.\$\{/);
  assert.doesNotMatch(src, /\{stage\.label\}/);
});

// ── §2-22 F28: accessible names ─────────────────────────────────────────────────────────────────────────────────
test("S42 kanban checkbox and filter selects carry accessible names; the checkbox is 24px", () => {
  const card = read("src/app/(dashboard)/leads/_components/LeadCard.tsx");
  assert.match(card, /<input type="checkbox"[^>]*aria-label=\{/s);
  assert.match(card, /className="h-6 w-6 rounded/);
  const filters = read("src/app/(dashboard)/leads/_components/LeadsFilters.tsx");
  // From "<select" to its className: the opening tag's attributes (the "=>" inside onChange would end a naive ">" match).
  const openTags = (src) => src.match(/<select[\s\S]*?className=/g) ?? [];
  const selects = openTags(filters);
  assert.ok(selects.length >= 5);
  for (const s of selects) assert.match(s, /aria-label=/, s);
  const mobile = read("src/app/(dashboard)/leads/_components/LeadsMobileList.tsx");
  for (const s of openTags(mobile)) assert.match(s, /aria-label=/, s);
});

// ── §2-24 V6: dates in the display format ──────────────────────────────────────────────────────────────────────
test("S42 instalment and payment dates render through display-format (22 Nov), never raw ISO", () => {
  const tracker = read("src/app/(dashboard)/analytics/_components/PaymentTracker.tsx");
  assert.doesNotMatch(tracker, /\{inst\.due_date\}/);
  assert.match(tracker, /formatShortDate\(inst\.due_date/);
  const payments = read("src/app/(dashboard)/payments/page.tsx");
  assert.doesNotMatch(payments, /payment_date\?\.slice\(0, 10\)\}/);
  assert.doesNotMatch(payments, /due_date\?\.slice\(0, 10\)\}/);
  assert.match(payments, /formatShortDate\(/);
});

// ── N7: no UTC date keys left where a Dubai calendar day is meant ──────────────────────────────────────────────
test("S42 every remaining UTC date key is a Dubai date key", () => {
  const files = [
    "src/app/(dashboard)/contracts/new/page.tsx",
    "src/app/(dashboard)/quotes/quote-detail-dialog.tsx",
    "src/app/(dashboard)/team/page.tsx",
    "src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts",
    "src/components/lead-workflow.tsx",
    "src/app/api/leads/route.ts",
    "src/lib/meta-lead-ads.mjs",
    "src/app/api/leads/meta-capi/route.ts",
    "src/app/api/quotations/generate/route.ts",
    "src/lib/quotation-engine.ts",
    "src/app/api/cron/daily-funnel-snapshot/route.ts",
  ];
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(src, /toISOString\(\)\.slice\(0, 10\)(?! ===)/, `${file} still slices a UTC date`);
    assert.doesNotMatch(src, /toISOString\(\)\.split\(['"]T['"]\)\[0\]/, `${file} still splits a UTC date`);
    assert.match(src, /dubai-time\.mjs/, `${file} does not import dubai-time`);
  }
  // 01:30 Dubai on 25 Nov is still 24 Nov in UTC: the key must say 25 Nov.
  assert.equal(dubaiDateKey(new Date("2026-11-24T21:30:00Z")), "2026-11-25");
  assert.equal(addDaysToDateKey(dubaiDateKey(new Date("2026-11-24T21:30:00Z")), 1), "2026-11-26");
});

// ── N8: quoted but no first contact ───────────────────────────────────────────────────────────────────────────
test("S42 a quoted lead with no logged contact reads 'Quoted · first contact not logged' in both languages", () => {
  const route = read("src/app/api/dashboard/summary/route.ts");
  assert.match(route, /Quoted · first contact not logged/);
  assert.equal(localizeServerText("Quoted · first contact not logged", "zh"), "已报价，未记录首次联系");
  assert.equal(localizeServerText("New lead · awaiting first contact", "zh"), "新线索 · 等待首次联系");
});

// ── i18n parity for every s42 key used anywhere ───────────────────────────────────────────────────────────────
test("S42 every s42.* key used in the interface exists in both languages", () => {
  const i18n = read("src/lib/i18n/translations.ts");
  const enBlock = i18n.slice(i18n.indexOf("  en: {"), i18n.indexOf("  zh: {"));
  const zhBlock = i18n.slice(i18n.indexOf("  zh: {"));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []);
  const keys = new Set();
  for (const file of walk(path.join(root, "src"))) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/t\("(s42\.[A-Za-z0-9_.]+)"\)/g)) keys.add(m[1]);
  }
  assert.ok(keys.size >= 8, `only ${keys.size} s42 keys found`);
  for (const key of keys) {
    const leaf = key.split(".").pop();
    assert.ok(new RegExp(`\\b${leaf}:`).test(enBlock), `en ${key}`);
    assert.ok(new RegExp(`\\b${leaf}:`).test(zhBlock), `zh ${key}`);
  }
});
