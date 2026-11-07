// S6 · review 4d #4/#5/#7/#10/#11/#12/#13/#14, 4a #9, 4b #11, 4c #23: mobile
// ergonomics, long-text overflow, the 1280/1366 timeline crop, confirmations
// for destructive actions, and the shared save-failure pattern.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const core = await import("../../src/lib/mutation-feedback-core.mjs");

const dict = {
  "mutation.network": "网络连接失败，内容未保存。",
  "mutation.session": "登录已失效，请重新登录。",
  "mutation.server": "服务器出错，保存失败，请重试。",
  "mutation.forbidden": "你没有执行此操作的权限。",
  "apiErrors.concurrent_lead_update": "该线索刚被他人修改，请刷新后重试。",
  "common.saveFailedRetry": "保存失败，请重试",
};
const t = (k) => dict[k] ?? k;

test("network drop is classified and shown localized, never as 'TypeError: Failed to fetch'", () => {
  const kind = core.classifyMutationFailure({ error: new TypeError("Failed to fetch") });
  assert.equal(kind, "network");
  const supabaseStyle = core.classifyMutationFailure({ error: { message: "TypeError: Failed to fetch" } });
  assert.equal(supabaseStyle, "network");
  assert.equal(core.mutationFailureMessage({ kind }, t, "common.saveFailedRetry"), dict["mutation.network"]);
});

test("a code bug (TypeError without a network message) is not disguised as a network error, and is logged", () => {
  const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
  assert.equal(core.classifyMutationFailure({ error: bug }), "unexpected");
  assert.equal(core.classifyMutationFailure({ error: new TypeError("NetworkError when attempting to fetch resource.") }), "network");
  assert.equal(core.classifyMutationFailure({ error: new TypeError("Load failed") }), "network");
  const lib = read("src/lib/mutation-feedback.ts");
  assert.match(lib, /Sentry\.captureException\(/);
  assert.match(lib, /console\.error\("\[mutation\] save failed"/);
  // the response body and form values are never sent along (may hold customer data)
  assert.doesNotMatch(lib.slice(lib.indexOf("function logFailure"), lib.indexOf("let redirecting")), /failure\.body|extra: \{[^}]*body/);
});

test("an ended session asks to sign in again; known API codes are translated; unknown text is not shown raw", () => {
  assert.equal(core.classifyMutationFailure({ status: 401, body: { error: "Unauthorized" } }), "session");
  const conflict = core.classifyMutationFailure({ status: 409, body: { error: "CONCURRENT_LEAD_UPDATE" } });
  assert.equal(conflict, "conflict");
  assert.equal(core.mutationFailureMessage({ kind: conflict, body: { error: "CONCURRENT_LEAD_UPDATE" } }, t), dict["apiErrors.concurrent_lead_update"]);
  const raw = core.mutationFailureMessage({ kind: "server", body: { error: "boom" } }, t, "common.saveFailedRetry");
  assert.equal(raw, dict["common.saveFailedRetry"]);
});

test("inline profile edit keeps the editor and the typed value when the save fails", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.match(page, /if \(saved\) setEditField\(null\);/);
  assert.doesNotMatch(page, /updateField\([^;]*\);\s*\}\s*setEditField\(null\);/);
  const hook = read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  assert.match(hook, /runMutation\(/);
  assert.doesNotMatch(hook, /err\?\.message \|\|/); // raw supabase text used to be toasted
});

test("core lead / quote forms use the shared failure pattern", () => {
  assert.match(read("src/app/(dashboard)/leads/new/page.tsx"), /runMutation\(/);
  for (const f of ["src/app/(dashboard)/quotes/quote-calculator.tsx", "src/app/(dashboard)/quotes/quote-wizard.tsx"]) {
    const src = read(f);
    assert.match(src, /reportMutationFailure\(/, f);
    assert.doesNotMatch(src, /error\?\.message \|\| "Missing database quote number"/, f);
  }
  // contact quality buttons gave no feedback on a phone
  assert.match(read("src/app/(dashboard)/leads/[id]/LeadContactQualityPanel.tsx"), /runMutation\(/);
});

test("destructive one-click actions ask for confirmation", () => {
  const team = read("src/app/(dashboard)/team/page.tsx");
  // Member deactivation: S3's hand-over dialog is the confirmation step (it
  // replaced S6's plain ConfirmDialog when the two branches were combined).
  assert.match(team, /<MemberHandoverDialog/);
  assert.doesNotMatch(team, /onClick=\{\(\) => handleDeleteUser\(/);
  assert.match(team, /onClick=\{\(\) => setHandoverMember\(/);
  const quotation = read("src/app/(dashboard)/quotations/[id]/page.tsx");
  assert.match(quotation, /<ConfirmDialog/);
  assert.doesNotMatch(quotation, /onClick=\{\(\) => handleRemoveLineItem\(index\)\}/);
});

test("phones: controls are at least 40 px and the lead header no longer pins ~22% of the screen", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height: 40px/);
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  const header = page.match(/data-sticky-region="page-title"\s+className="([^"]+)"/)[1];
  assert.ok(!/(^|\s)sticky(\s|$)/.test(header), "header must not be sticky below md");
  assert.match(header, /md:sticky/);
  assert.doesNotMatch(header, /bg-card\/95/); // see-through header let text show beneath
});

test("long text wraps and the three-column lead detail fits 1280/1366 screens", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.doesNotMatch(page, /minmax\(520px/);
  assert.match(page, /xl:grid-cols-\[minmax\(0,0\.8fr\)_minmax\(0,1\.6fr\)_minmax\(0,1fr\)\]/);
  assert.match(page, /<h1 className="[^"]*break-anywhere/);
  assert.match(read("src/app/(dashboard)/leads/[id]/LeadTimeline.tsx"), /break-anywhere">\{item\.content\}/);
  assert.match(read("src/app/globals.css"), /\.break-anywhere \{\s*overflow-wrap: anywhere;/);
});
