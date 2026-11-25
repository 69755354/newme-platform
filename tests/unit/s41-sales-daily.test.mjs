// S41 (UX recheck 2026-11-24 §2-1..§2-10, §2-23; regressions N1–N3): what a salesperson touches every day on a phone.
// Phone search across formats, honest stage copy, no false "Stale", a quote entry under the three big buttons, a
// workbench that says what to do today, open the lead right after creating it, a duplicate dialog that names the
// owner (never leaking to sales), card layouts for quotes/tasks/team on phones, a sales menu of at most 6 items, a
// bell that is role-filtered and translated with a badge equal to the list, and lead deletion hidden from sales.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { leadMatchesSearch, searchDigitCandidates } from "../../src/lib/leads-search.mjs";
import { hasRecentContact, isFreshLead, healthBadgeLevel } from "../../src/lib/lead-health.mjs";
import { mergeTasksWithOverdue, todayThreeThings } from "../../src/lib/workbench-today.mjs";
import { localizeNotification, notificationTypesForRole, SALES_HIDDEN_NOTIFICATION_TYPES } from "../../src/lib/notification-display.mjs";
import { translations } from "../../src/lib/i18n/translations.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/** Transpile one TS module to CJS and evaluate it with a tiny require() for its "@/lib/*.mjs" imports. */
function loadTsPure(file, mocks = {}) {
  const ts = require("typescript");
  const { outputText } = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  const localRequire = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`unexpected import ${id}`);
  };
  new Function("exports", "require", outputText)(exports, localRequire);
  return exports;
}

const t = (key) => {
  const value = key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), translations.zh);
  return typeof value === "string" ? value : key;
};
const tEn = (key) => {
  const value = key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), translations.en);
  return typeof value === "string" ? value : key;
};

// ── §2-1 F12/OA9: phone search across formats ──────────────────────────────────────────────────────────────────────
test("S41-1 the same number is found whatever way it is typed, on the desktop board and the mobile list alike", () => {
  const lead = { customer_name: "Sara", phone: "+971501234567", location: "Dubai", assigned_to: "u1" };
  for (const typed of ["+971 50 123 4567", "050-123-4567", "00971501234567", "0501234567", "50 123 4567", "1234567", "050 123"]) {
    assert.equal(leadMatchesSearch(lead, typed), true, `search "${typed}"`);
  }
  assert.equal(leadMatchesSearch(lead, "0509999999"), false);
  assert.equal(leadMatchesSearch(lead, "123"), false, "three digits are too short to be a phone search");
  // Name and location substring search still works, case-insensitively.
  assert.equal(leadMatchesSearch(lead, "sar"), true);
  assert.equal(leadMatchesSearch(lead, "dubai"), true);
  assert.equal(leadMatchesSearch(lead, "omar"), false);
  // A lead stored in a local format is found by an international search.
  assert.equal(leadMatchesSearch({ phone: "050 123 4567" }, "+971501234567"), true);
  assert.deepEqual(searchDigitCandidates("050 123"), ["050123", "50123"]);
  const hook = read("src/app/(dashboard)/leads/_hooks/useLeadsFiltering.ts");
  assert.ok(hook.includes("leadMatchesSearch("), "the filter hook uses the shared matcher");
  assert.equal(hook.includes('(l.phone || "").includes(s)'), false, "the raw substring phone match is gone");
  // The mobile list renders the same `filtered` array, so it needs no filter of its own.
  const page = read("src/app/(dashboard)/leads/page.tsx");
  assert.match(page, /<LeadsMobileList\s+leads=\{filtered\}/);
});

// ── §2-2 F02 / N2: honest stage copy, optional stage note ──────────────────────────────────────────────────────────
test("S41-2 the lead page no longer says 'required' or 'unlock in sequence'; Won needs no note, Lost keeps its reason", () => {
  const process = read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.equal(process.includes("Future stages unlock in sequence"), false);
  assert.equal(process.includes("后续阶段会在满足顺序后解锁"), false);
  assert.equal(process.includes('t("leadDetail.stageNoteRequired")'), false);
  assert.ok(process.includes('t("s41.stageNote.label")'));
  assert.ok(process.includes('t("s41.stageNote.hint")'));
  const wonButton = process.slice(process.indexOf("onWon(stageNote, wonAmount)"), process.indexOf('{t("stageLabels.won")}'));
  assert.equal(wonButton.includes("!stageNote.trim()"), false, "Won is not blocked by an empty note");
  const lostButton = process.slice(process.indexOf("onLost(stageNote)"), process.indexOf('{t("stageLabels.lost")}'));
  assert.ok(lostButton.includes("!stageNote.trim()"), "Lost still needs its reason");
  const route = read("src/app/api/leads/[id]/stage/route.ts");
  assert.ok(route.includes('if (!note && stage === "lost")'));
  assert.equal(route.includes('(stage === "won" || stage === "lost")'), false);
  for (const lang of ["zh", "en"]) {
    assert.equal(/必填|required/i.test(translations[lang].s41.stageNote.hint), false);
    assert.ok(translations[lang].s41.stageNote.label.length > 0);
  }
  assert.match(t("s41.stageNote.hint"), /自动推进/);
});

// ── §2-3 F11 / N1: no "Stale" on a lead that was just created or just contacted ───────────────────────────────────
test("S41-3 a contact logged today counts as recent even when followup_count is 0; a 48-hour-old lead is never Stale", () => {
  const now = new Date("2026-11-24T08:00:00Z");
  const h = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  // 记一笔 writes a follow_up_logs row and last_contact_date but not followup_count.
  assert.equal(hasRecentContact({ lead: { followup_count: 0, last_contact_date: h(2) }, followUpLogs: [], now }), true);
  assert.equal(hasRecentContact({ lead: { followup_count: 0, last_contact_date: null }, followUpLogs: [{ contact_time: h(3), created_at: h(3) }], now }), true);
  assert.equal(hasRecentContact({ lead: { followup_count: 0, last_contact_date: null }, followUpLogs: [{ contact_time: null, created_at: h(3) }], now }), true);
  assert.equal(hasRecentContact({ lead: { followup_count: 5, last_contact_date: h(24 * 9) }, followUpLogs: [{ contact_time: h(24 * 10), created_at: h(24 * 10) }], now }), false);
  assert.equal(hasRecentContact({ lead: { followup_count: 0, last_contact_date: null }, followUpLogs: [], now }), false);
  assert.equal(isFreshLead({ created_at: h(47) }, now), true);
  assert.equal(isFreshLead({ created_at: h(49) }, now), false);
  assert.equal(healthBadgeLevel("stale", { created_at: h(10) }, now), "fresh");
  assert.equal(healthBadgeLevel("stale", { created_at: h(100) }, now), "stale");
  assert.equal(healthBadgeLevel("at_risk", { created_at: h(10) }, now), "at_risk");
  const process = read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.ok(process.includes("hasRecentContact("));
  assert.ok(process.includes("healthBadgeLevel("));
  assert.equal(process.includes("(lead.followup_count ?? 0) > 0 &&"), false);
  assert.equal(t("s41.health.fresh").length > 0 && tEn("s41.health.fresh").length > 0, true);
});

// ── §2-4 F06: quote entry under the three big buttons; "mark as contacted?" after Call / WhatsApp ─────────────────
test("S41-4 the action bar offers 'record quote amount' and asks to log the contact after a call or WhatsApp tap", () => {
  const bar = read("src/app/(dashboard)/leads/[id]/LeadActionBar.tsx");
  for (const token of ['data-testid="action-quick-quote"', "onQuickQuote", 'data-testid="mark-contacted"', 'data-testid="mark-contacted-yes"', 'data-testid="mark-contacted-no"', 't("s41.actions.quickQuote")', 't("s41.actions.markContacted")']) {
    assert.ok(bar.includes(token), token);
  }
  // The prompt logs through the same contacts route with the method that was tapped.
  assert.match(bar, /onClick=\{\(\) => setPendingMethod\("phone"\)\}/);
  assert.match(bar, /onClick=\{\(\) => setPendingMethod\("whatsapp"\)\}/);
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.match(page, /onQuickQuote=\{\(\) => setShowQuickQuote\(true\)\}/);
  assert.equal(t("s41.actions.quickQuote"), "记报价金额");
});

// ── §2-5 F04: workbench says what to do today, Tasks absorbs Overdue, New Lead floats ─────────────────────────────
test("S41-5 overdue tasks merge into Tasks (red, first); today's 3 things are counted from the same data", () => {
  const now = new Date("2026-11-24T06:00:00Z"); // 10:00 Dubai
  const tasks = [
    { id: "t1", title: "later", due_at: "2026-11-26T05:00:00Z" },
    { id: "t2", title: "today pm", due_at: "2026-11-24T12:00:00Z" },
    { id: "t3", title: "today early (already past)", due_at: "2026-11-24T04:00:00Z" },
  ];
  const overdue = [
    { id: "o1", title: "two days", due_at: "2026-11-22T05:00:00Z", lead_id: "L1" },
    { id: "t3", title: "today early (already past)", due_at: "2026-11-24T04:00:00Z" },
  ];
  const merged = mergeTasksWithOverdue(tasks, overdue, now);
  assert.deepEqual(merged.map((x) => x.id), ["o1", "t3", "t2", "t1"], "overdue first, oldest first, no duplicates");
  assert.deepEqual(merged.map((x) => x.overdue), [true, true, false, false]);

  const inbox = [
    { id: "L2", customer_name: "New A", phone: "+971501234567", inbox_group: "new" },
    { id: "L3", customer_name: "New B", phone: "+971501234568", inbox_group: "new" },
    { id: "L1", customer_name: "Old", phone: "+971501234569", inbox_group: "overdue", next_followup_date: "2026-11-20" },
    { id: "L4", customer_name: "Later", inbox_group: "later" },
  ];
  const three = todayThreeThings({ inbox, tasks, overdue }, now);
  assert.equal(three.uncontactedNew.count, 2);
  assert.deepEqual(three.uncontactedNew.items.map((x) => x.id), ["L2", "L3"]);
  assert.equal(three.dueToday.count, 2, "two tasks fall on Dubai 24 Nov (one already past)");
  assert.equal(three.longestOverdue?.id, "o1");
  assert.equal(three.longestOverdue?.lead_id, "L1");
  assert.equal(three.longestOverdue?.phone, "+971501234569", "the phone comes from the inbox row of the same lead");
  assert.equal(three.longestOverdue?.customer_name, "Old");
  const empty = todayThreeThings({ inbox: [], tasks: [], overdue: [] }, now);
  assert.equal(empty.longestOverdue, null);
  assert.equal(empty.dueToday.count, 0);

  const page = read("src/app/(dashboard)/workbench/page.tsx");
  for (const token of ['data-testid="today-three"', "mergeTasksWithOverdue(", "todayThreeThings(", 'data-testid="workbench-new-lead-fab"', 't("s41.workbench.today")', "whatsappHref(", "telHref("]) {
    assert.ok(page.includes(token), token);
  }
  assert.equal(page.includes('t("workbench.overdue") || "Overdue"'), false, "the separate Overdue card is gone");
  // N4 (from S42): the Progress card and the inbox badge translate milestone keys instead of printing "Basic_info".
  assert.ok(page.includes("{milestoneLabel(g.current_milestone)}"));
  assert.ok(page.includes("{milestoneLabel(item.current_milestone)}"));
  assert.match(page, /translatedOrRaw\(t, `leadDetail\.milestone_\$\{key\}`, translatedOrRaw\(t, `stages\.\$\{key\}`, key\)\)/);
  assert.equal(/\{g\.current_milestone\}\s*<\/span>/.test(page), false, "no raw milestone key rendered as text");
  const fabAt = page.indexOf('data-testid="workbench-new-lead-fab"');
  const fab = page.slice(page.lastIndexOf("<Link", fabAt), page.indexOf("</Link>", fabAt));
  assert.match(fab, /fixed/);
  assert.match(fab, /bottom-/);
  assert.match(fab, /right-/);
  assert.match(fab, /href="\/leads\/new"/);
});

// ── §2-6 F17: open the lead after quick-create ───────────────────────────────────────────────────────────────────
test("S41-6 quick-create hands the new id back and the leads page opens that lead", () => {
  const dialog = read("src/components/QuickCreateLeadDialog.tsx");
  assert.match(dialog, /onCreated: \(id: string\) => void/);
  assert.match(dialog, /onCreated\(result\.id\)/);
  const page = read("src/app/(dashboard)/leads/page.tsx");
  assert.match(page, /onCreated=\{\(id\) => \{[^}]*router\.push\(`\/leads\/\$\{id\}`\)/s);
});

// ── §2-7 F13: duplicate dialog names owner · stage · last contact, two clear buttons, nothing leaks to sales ──────
test("S41-7 presentDuplicates adds owner name, stage and last contact for leads the viewer may see, nothing for the rest", () => {
  const { presentDuplicates } = loadTsPure("src/lib/lead-duplicates.ts", { "@/lib/lead-contact.mjs": {} });
  const rows = [
    { id: "a", customer_name: "Ahmed", phone: "+971501234567", email: null, assigned_to: "u-other", archived: false, stage: "quotation_submitted", last_contact_date: "2026-11-20T10:00:00Z", matched_on: "phone" },
    { id: "b", customer_name: "Mine", phone: "+971501234567", email: null, assigned_to: "u-me", archived: false, stage: "new", last_contact_date: null, matched_on: "phone" },
  ];
  const names = { "u-other": "Omar", "u-me": "Me" };
  const sales = presentDuplicates(rows, { id: "u-me", role: "sales" }, names);
  assert.deepEqual(sales[0], { id: null, customer_name: null, archived: false, matched_on: null, visible: false });
  const text = JSON.stringify(sales[0]);
  for (const secret of ["Omar", "u-other", "quotation", "2026-11-20", "Ahmed"]) assert.equal(text.includes(secret), false, secret);
  assert.equal(sales[1].visible, true);
  assert.equal(sales[1].assigned_to_name, "Me");
  assert.equal(sales[1].stage, "new");
  assert.equal(sales[1].last_contact_date, null);
  const boss = presentDuplicates(rows, { id: "boss", role: "boss" }, names);
  assert.equal(boss[0].assigned_to_name, "Omar");
  assert.equal(boss[0].stage, "quotation_submitted");
  assert.equal(boss[0].last_contact_date, "2026-11-20T10:00:00Z");
  // Without a name map the field is null, never an id.
  assert.equal(presentDuplicates(rows, { id: "boss", role: "boss" })[0].assigned_to_name, null);
  const lib = read("src/lib/lead-duplicates.ts");
  assert.match(lib, /stage, last_contact_date/);
  const route = read("src/app/api/leads/route.ts");
  assert.match(route, /duplicateOwnerNames\(/);
  const notice = read("src/components/leads/LeadDuplicateNotice.tsx");
  for (const key of ["s41.duplicate.openExisting", "s41.duplicate.createAnyway", "s41.duplicate.colleagueFollowing", "s41.duplicate.owner", "s41.duplicate.lastContact"]) {
    assert.ok(notice.includes(`"${key}"`), key);
  }
  assert.equal(notice.includes('target="_blank"'), false, "open the existing lead in the same tab");
  assert.ok(notice.includes("stageLabels."), "the stage is translated");
});

// ── §2-8 F15/V8: phone cards for quotes, tasks (names, not ids) and team ─────────────────────────────────────────
test("S41-8 quotes, tasks and team render cards under the sm/md breakpoint; tasks never show an assignee id", () => {
  const quotes = read("src/app/(dashboard)/quotes/quotes-client.tsx");
  assert.match(quotes, /data-testid="quotes-mobile-cards"[^>]*className="[^"]*sm:hidden/);
  assert.match(quotes, /hidden sm:grid grid-cols-12/);
  const tasks = read("src/app/(dashboard)/tasks/page.tsx");
  assert.equal(tasks.includes("task.assignee_id.slice(0, 8)"), false);
  assert.match(tasks, /data-testid="tasks-mobile-cards"[^>]*className="[^"]*md:hidden/);
  assert.match(tasks, /hidden md:block/);
  assert.match(tasks, /assignees/);
  const tasksApi = read("src/app/api/tasks/list/route.ts");
  assert.match(tasksApi, /assignees/);
  assert.match(tasksApi, /supabaseAdmin/);
  const team = read("src/app/(dashboard)/team/page.tsx");
  assert.match(team, /data-testid="team-mobile-cards"[^>]*className="[^"]*md:hidden/);
  assert.match(team, /hidden md:block/);
  assert.match(team, /flex flex-wrap items-start justify-between gap-3/);
});

// ── §2-9 F16 / N3: sales menu ≤ 6 primary items, the rest under "More" ───────────────────────────────────────────
test("S41-9 the sales sidebar shows at most 6 primary items; opportunities, visits, cable costing, analytics, products live under More", () => {
  const nav = read("src/lib/nav.ts");
  const start = nav.indexOf("export const SALES_NAV: NavItem[] = [");
  const end = nav.indexOf("\n];", start);
  const items = [...nav.slice(start, end).matchAll(/\{\s*href:\s*"([^"]+)"([^}]*)\}/g)].map((m) => ({ href: m[1], more: /group:\s*"more"/.test(m[2]) }));
  const primary = items.filter((i) => !i.more).map((i) => i.href);
  const more = items.filter((i) => i.more).map((i) => i.href);
  assert.ok(primary.length <= 6, `primary sales items: ${primary.join(", ")}`);
  assert.deepEqual(primary, ["/workbench", "/leads", "/quotes", "/contracts", "/payments", "/pipeline"]);
  assert.deepEqual(more.sort(), ["/analytics", "/cable-costing", "/opportunities", "/products", "/visits"]);
  assert.match(nav, /export function primaryNavItems/);
  assert.match(nav, /export function moreNavItems/);
  const sidebar = read("src/components/dashboard/DashboardSidebar.tsx");
  assert.ok(sidebar.includes('t("nav.more")'));
  assert.ok(sidebar.includes("moreNavItems("));
  assert.ok(sidebar.includes('data-testid="nav-more"'));
  assert.equal(translations.zh.nav.more, "更多");
  assert.equal(translations.en.nav.more, "More");
  // Management keeps its flat list: no item of MGMT_NAV is grouped.
  const mStart = nav.indexOf("export const MGMT_NAV: NavItem[] = [");
  assert.equal(/group:/.test(nav.slice(mStart, nav.indexOf("\n];", mStart))), false);
});

// ── §2-10 F14/B14/V7: bell filtered by role, status codes translated, badge = list ──────────────────────────────
test("S41-10 sales do not see approval traffic; status codes in bodies are translated; one query feeds badge and list", () => {
  assert.equal(notificationTypesForRole("admin"), null);
  assert.equal(notificationTypesForRole("boss"), null);
  assert.equal(notificationTypesForRole("operator"), null);
  const sales = notificationTypesForRole("sales");
  assert.ok(Array.isArray(sales));
  for (const hidden of ["contract_pending_approval", "contract_created", "contract_signed", "team_member_added", "quote_created", "lead_stage_change", "lead_stage_changed"]) {
    assert.equal(sales.includes(hidden), false, hidden);
    assert.ok(SALES_HIDDEN_NOTIFICATION_TYPES.includes(hidden), hidden);
  }
  for (const kept of ["lead_assigned", "lead_created", "follow_up_reminder", "follow_up_overdue", "contract_approved", "contract_rejected", "payment_received", "first_payment_reminder", "reminder", "warning"]) {
    assert.ok(sales.includes(kept), kept);
  }
  assert.deepEqual(notificationTypesForRole("finance"), sales, "any non-management role gets the personal list");
  // Body "C-1 · AED 1,000 · pending_ceo" → the code is translated through s37.codes / s41.codes.
  const zh = localizeNotification({ title: "Contract pending approval: C-1", body: "C-1 · AED 1,000 · pending_ceo" }, t);
  assert.equal(zh.body, "C-1 · AED 1,000 · 待老板审批");
  const en = localizeNotification({ title: "x", body: "C-1 · AED 1,000 · admin_review" }, tEn);
  assert.equal(en.body, "C-1 · AED 1,000 · Admin review");
  assert.equal(localizeNotification({ title: "x", body: "C-1 · AED 1,000 · signed" }, t).body, "C-1 · AED 1,000 · 已签署");
  assert.equal(localizeNotification({ title: "x", body: "C-1 · AED 1,000 · unknown_code_zz" }, t).body, "C-1 · AED 1,000 · unknown_code_zz");
  assert.equal(localizeNotification({ title: "x", body: "plain text" }, t).body, "plain text");
  for (const code of ["pending_ceo", "pending_admin", "ceo_review", "admin_review"]) assert.ok(translations.zh.s37.codes[code] && translations.en.s37.codes[code], code);
  for (const code of ["signed", "active", "pending", "cancelled", "void", "completed"]) assert.ok(translations.zh.s41.codes[code] && translations.en.s41.codes[code], code);

  const list = read("src/app/api/notifications/route.ts");
  const count = read("src/app/api/notifications/unread-count/route.ts");
  for (const src of [list, count]) {
    assert.match(src, /notificationTypesForRole\(/);
    assert.match(src, /\.eq\("user_id", user\.id\)/);
    assert.match(src, /\.in\("type", /);
  }
  assert.equal(list.includes("// Admin/boss sees all"), false, "the bell is personal: the list and the badge count the same rows");
  const bell = read("src/components/NotificationBell.tsx");
  assert.equal(bell.includes("filter((n: Notification) => !n.is_read).length"), false, "the badge is not recomputed from the 20 rows shown");
  assert.match(bell, /await fetchUnreadCount\(\)/);
});

// ── §2-23 F29②: delete hidden from sales, second confirmation ───────────────────────────────────────────────────
test("S41-11 only admin/boss see the delete icon and it opens a confirm dialog instead of window.confirm", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  const trash = page.indexOf("<Trash2");
  const gate = page.lastIndexOf("{(", trash);
  assert.match(page.slice(gate, trash), /\["admin", "boss"\]\.includes\(salesRole \?\? ""\)/);
  assert.equal(/\(salesRole === "sales" && lead\.assigned_to === currentUserId\)\) && \(\s*<>\s*<Button[^]*?<Trash2/.test(page), false, "sales no longer see the trash icon");
  assert.ok(page.includes("<ConfirmDialog"));
  assert.ok(page.includes('t("s41.delete.title")'));
  const mutations = read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  assert.equal(/\bconfirm\(t\("leadDetail\.confirmDelete"\)/.test(mutations), false);
  assert.match(mutations, /confirmDelete/);
  assert.match(mutations, /deleteDialogOpen/);
  assert.match(mutations, /const canDelete = \["admin", "boss"\]\.includes\(salesRole \?\? ""\)/);
});

// ── i18n: every new string exists in both languages (parity is also enforced by tests/i18n) ─────────────────────
test("S41-12 the s41 block exists in zh and en with the same keys", () => {
  const flat = (node, prefix = "") => Object.entries(node).flatMap(([k, v]) => (typeof v === "object" ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  assert.deepEqual(flat(translations.zh.s41).sort(), flat(translations.en.s41).sort());
  assert.ok(flat(translations.zh.s41).length >= 25);
});
