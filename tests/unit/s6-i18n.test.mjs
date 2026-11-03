// S6 · review 4d section 4 + #15/#20/#21/#25, 4a #12/#13, 4c #12/#16/#18, 4b #12:
// Chinese interface leaked English (Lead Health block, risk hints, workbench,
// raw keys common.available / quotes.contract_created / quotes.won, "m ago",
// dates as "Nov 2, 2026"), pages rendered English before switching, and the
// login page had no language switch. Each assertion fails on main 66b58a0.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

async function loadTranslations() {
  const scratch = mkdtempSync(path.join(tmpdir(), "s6-i18n-"));
  const file = path.join(scratch, "translations.mjs");
  writeFileSync(file, read("src/lib/i18n/translations.ts").replace(/\} as const;/, "};").replace(/^export type .*$/gm, ""));
  return (await import(file)).translations;
}
const tr = await loadTranslations();

test("first render uses the saved language: cookie read by the root layout, provider starts from it", async () => {
  const pref = await import("../../src/lib/i18n/language-preference.mjs");
  assert.equal(pref.parseLanguage("zh"), "zh");
  assert.equal(pref.parseLanguage("fr"), null);
  assert.match(pref.languageCookie("zh"), /^newme-lang=zh; Path=\/; Max-Age=\d+; SameSite=Lax$/);
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /await cookies\(\)\)\.get\(LANGUAGE_COOKIE\)/);
  assert.match(layout, /<InitialLanguage lang=\{lang\}>/);
  const ctx = read("src/lib/i18n/LanguageContext.tsx");
  assert.doesNotMatch(ctx, /useState<Language>\("en"\)/);
  assert.match(ctx, /document\.cookie = languageCookie\(l\)/);
});

test("login and forced password-change pages offer the language switch", () => {
  assert.match(read("src/app/login/page.tsx"), /<LanguageToggle \/>/);
  assert.match(read("src/app/(auth)/change-password/page.tsx"), /<LanguageToggle \/>/);
});

test("server-generated English (risk hints, task titles, next actions) is shown in Chinese", async () => {
  const { localizeServerText } = await import("../../src/lib/i18n/server-text.mjs");
  assert.equal(localizeServerText("Overdue follow-up (129d)", "zh"), "跟进已逾期（129 天）");
  assert.equal(localizeServerText("Draft quote pending", "zh"), "报价草稿待发送");
  assert.equal(localizeServerText("Follow up", "zh"), "跟进");
  assert.equal(localizeServerText("call", "zh"), "打电话");
  assert.equal(localizeServerText("Follow up on quotation", "zh"), "跟进报价");
  assert.equal(localizeServerText("Overdue follow-up (129d)", "en"), "Overdue follow-up (129d)");
  assert.equal(localizeServerText("Ahmed Villa", "zh"), "Ahmed Villa");
  assert.match(read("src/app/(dashboard)/dashboard/page.tsx"), /localizeServerText\(action\.reason, language\)/);
  assert.match(read("src/app/(dashboard)/workbench/page.tsx"), /localizeServerText\(task\.title, lang\)/);
  assert.match(read("src/app/(dashboard)/pipeline/_components/LeadCard.tsx"), /localizeServerText\(lead\.next_action, lang\)/);
});

test("raw keys and mixed-language labels from the review are gone", () => {
  for (const lang of ["en", "zh"]) {
    assert.equal(typeof tr[lang].quotes.contract_created, "string");
    assert.equal(typeof tr[lang].quotes.won, "string");
    assert.match(tr[lang].team.minutesAgo, /\{n\}/); // team page showed "m ago" without the number
    assert.match(tr[lang].team.hoursAgo, /\{n\}/);
    assert.equal(typeof tr[lang].team.phone, "string");
  }
  assert.doesNotMatch(read("src/app/(dashboard)/analytics/_components/SalesLoad.tsx"), /common\.available/);
  const weekly = read("src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx");
  assert.doesNotMatch(weekly, /红 leads|黄 leads|Risk Pool 待办|, good: \{/);
  // member dialog: the phone field was labelled with team.role
  assert.match(read("src/app/(dashboard)/team/page.tsx"), /\{t\("team\.phone"\)\}\{" "\}/);
  const all = JSON.stringify(tr.zh);
  assert.doesNotMatch(all, /首长国/);
});

test("Lead Health block is fully translated and the quality tooltip never reads 'undefined: N'", () => {
  const src = read("src/app/(dashboard)/analytics/_components/LeadHealth.tsx");
  for (const english of ["Quality Distribution", "📊 Lead Health", "My Lead Health", 'label="Total Leads"', 'label="Active"', "this week`", " leads`"]) {
    assert.ok(!src.includes(english), `still hard-coded: ${english}`);
  }
  // the bar is fed every quality bucket it draws (unknown was missing => "undefined: 20")
  assert.match(src, /qualityLabels=\{getQualityLabels\(t\)\}/);
  assert.doesNotMatch(src, /qualityLabels=\{\{ good:/);
});

test("dates follow the interface language instead of a hard-coded en-US", () => {
  // the locale is passed explicitly (see s6-date-hydration.test.mjs)
  for (const f of [
    "src/app/(dashboard)/quotes/quotes-client.tsx",
    "src/app/(dashboard)/quotes/quote-detail-dialog.tsx",
    "src/app/(dashboard)/quotations/[id]/page.tsx",
    "src/app/(dashboard)/workbench/page.tsx",
    "src/app/(dashboard)/projects/projects-client.tsx",
    "src/app/(dashboard)/tasks/[id]/page.tsx",
  ]) {
    assert.doesNotMatch(read(f), /fmtDubai\([^)]*locale: "en-US"/s, f);
  }
});

test("hard-coded English scanner: detects JSX text, toasts and placeholders", async () => {
  const { findHardcodedEnglish } = await import("../../scripts/check-i18n-hardcoded.mjs");
  const hits = findHardcodedEnglish(`
    const a = () => toast.error("Note save failed");
    const b = <p>No alerts</p>;
    const c = <Input placeholder="Dubai, Palm Jumeirah..." />;
    const ok1 = <p>{t("workbench.noAlerts")}</p>;
    const ok2 = <span>WhatsApp</span>;
    const ok3 = <p>暂无提醒</p>;
    function f(): Promise<void> { return x; }
  `);
  assert.deepEqual(hits.map((h) => h.kind).sort(), ["jsx-text", "placeholder", "toast"]);
});

test("hard-coded English does not grow, and the pages fixed by S6 stay at zero", async () => {
  const { scan, compare } = await import("../../scripts/check-i18n-hardcoded.mjs");
  const current = scan();
  const baseline = JSON.parse(read("tests/i18n/hardcoded-english-baseline.json"));
  assert.deepEqual(compare(current, baseline).map((r) => `${r.file}: ${r.found} > ${r.allowed}`), []);
  for (const f of [
    "src/app/(dashboard)/analytics/_components/LeadHealth.tsx",
    "src/app/(dashboard)/workbench/page.tsx",
    "src/app/(dashboard)/ads/page.tsx",
    "src/app/(dashboard)/leads/new/page.tsx",
    "src/app/(dashboard)/leads/[id]/LeadContactQualityPanel.tsx",
    "src/app/(dashboard)/leads/[id]/LeadCustomerProfile.tsx",
    "src/app/(dashboard)/dashboard/_components/AlertPanel.tsx",
    "src/components/QuickCreateLeadDialog.tsx",
  ]) {
    assert.deepEqual(current[f] ?? [], [], f);
  }
});

test("the Show room lead source stays Show room in Chinese too (Sam decision 2026-11-04); stored value is unchanged", () => {
  assert.equal(tr.zh.sourceLabels.show_room, "Show room");
  assert.equal(tr.en.sourceLabels.show_room, "Show room");
  // the stored enum value stays "show_room" wherever it is offered
  assert.match(read("src/components/QuickCreateLeadDialog.tsx"), /value: "show_room", labelKey: "sourceLabels\.show_room"/);
  assert.match(read("src/app/(dashboard)/leads/new/page.tsx"), /<option value="show_room">\{t\("sourceLabels\.show_room"\)\}/);
});
