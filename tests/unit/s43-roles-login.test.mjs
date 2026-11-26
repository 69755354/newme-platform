// S43 (F08 / F25): finance and designer landing + role label, payment dialog wording, login messages,
// quick-create dialog theme, lead "not found" wording. Static checks plus the pure role mapping.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { landingPathForRole, roleLabelKey } from "../../src/lib/role-landing.mjs";
import { translations } from "../../src/lib/i18n/translations.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("each role lands on a page its sidebar admits, and the label names the real role", () => {
  assert.equal(landingPathForRole("finance"), "/contracts");
  assert.equal(landingPathForRole("designer"), "/projects");
  assert.equal(landingPathForRole("sales"), "/workbench");
  for (const role of ["admin", "boss", "operator"]) assert.equal(landingPathForRole(role), "/dashboard");
  assert.equal(landingPathForRole(null), "/workbench");
  assert.equal(roleLabelKey("finance"), "nav.roleFinance");
  assert.equal(roleLabelKey("designer"), "nav.roleDesigner");
  assert.equal(roleLabelKey("sales"), "nav.roleSales");
  assert.equal(roleLabelKey("boss"), "nav.roleManagement");
  for (const lang of ["en", "zh"]) {
    for (const key of ["roleFinance", "roleDesigner", "roleSales", "roleManagement"]) assert.ok(translations[lang].nav[key], `${lang} nav.${key}`);
  }
  // the landing page of each non-management role is in that role's sidebar (nav.ts)
  const nav = read("src/lib/nav.ts");
  assert.match(nav, /FINANCE_NAV[\s\S]*href: "\/contracts"/);
  assert.match(nav, /DESIGNER_NAV[\s\S]*href: "\/projects"/);
});

test("the redirect hook and the top bar use the shared mapping (no more Sales workbench for finance / designer)", () => {
  const hook = read("src/hooks/useAuthRedirect.ts");
  assert.match(hook, /router\.replace\(landingPathForRole\(role\)\)/);
  assert.doesNotMatch(hook, /router\.replace\("\/workbench"\)/);
  const bar = read("src/components/dashboard/DashboardTopBar.tsx");
  assert.match(bar, /t\(roleLabelKey\(role\)\)/);
  assert.doesNotMatch(bar, /isManagement \? t\("nav\.roleManagement"\) : t\("nav\.roleSales"\)/);
});

test("the payment dialog shows contract no · client · balance and payment methods in words, and opens on live payments", () => {
  const page = read("src/app/(dashboard)/payments/page.tsx");
  assert.match(page, /contractOptionLabel = \(c: PaymentContractOption\) =>[\s\S]*c\.contract_no\} · \$\{c\.party_a_name[\s\S]*s43\.payments\.balance/);
  // Base UI renders the raw value unless SelectValue is given a render function: both selects have one.
  assert.match(page, /<SelectValue placeholder=\{t\("payments\.selectContract"\)\}>\s*\{\(value: unknown\) => contractOptionLabelById/);
  assert.match(page, /<SelectValue>\{\(value: unknown\) => methodLabel\(String\(value \?\? ""\)\)\}<\/SelectValue>/);
  assert.doesNotMatch(page, /card: "Card"/);
  assert.doesNotMatch(page, /other: "Other"/);
  assert.match(page, /useState<PaymentStateFilter \| "active">\("active"\)/);
  assert.match(page, /<TabsTrigger value="active">/);
  assert.match(page, /<TabsTrigger value="voided">/);
  for (const lang of ["en", "zh"]) {
    const p = translations[lang].s43.payments;
    assert.ok(p.methodCard && p.methodOther && p.balance && p.active, lang);
  }
});

test("the login page offers the way back in and says 'email or password is incorrect' for a rejected credential", () => {
  const page = read("src/app/login/page.tsx");
  assert.match(page, /case "invalid_credentials":\s*\n[\s\S]*?return t\("s43\.login\.invalidCredentials"\)/);
  assert.match(page, /data-testid="forgot-password"/);
  assert.match(page, /t\("s43\.login\.forgotPassword"\)/);
  assert.match(page, /t\("s43\.login\.forgotPasswordHint"\)/);
  // the distinct answers the server already gives stay distinct on the page
  for (const code of ["inactive_account", "rate_limited", "auth_unavailable"]) assert.match(page, new RegExp(`case "${code}"`));
  assert.equal(translations.zh.s43.login.invalidCredentials, "邮箱或密码错误。");
  assert.match(translations.zh.s43.login.forgotPasswordHint, /Sam|Tanya/);
  assert.match(translations.en.s43.login.forgotPasswordHint, /Sam|Tanya/);
  // the login route answers invalid_credentials (not a generic failure) for a rejected grant
  assert.match(read("src/app/api/auth/login/route.ts"), /respond\(\{ error: "invalid_credentials" \}, \{ status: 401 \}\)/);
});

test("the quick-create dialog uses the theme tokens of the other dialogs, not a hard-coded dark palette", () => {
  const dialog = read("src/components/QuickCreateLeadDialog.tsx");
  assert.doesNotMatch(dialog, /#1E2328|#D4A373|bg-gray-9\d\d|text-white|border-gray-[78]00|text-gray-400/);
  assert.match(dialog, /<DialogContent className="sm:max-w-md bg-card border-border text-foreground">/);
});

test("a lead that is missing or hidden says so, with a way back; designers and finance are told it is sales-only", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.match(page, /data-testid="lead-not-found"/);
  assert.match(page, /salesRole === "designer" \|\| salesRole === "finance"/);
  assert.match(page, /t\("s43\.lead\.salesOnly"\)/);
  assert.match(page, /t\("s43\.lead\.notFoundOrNoAccess"\)/);
  assert.match(page, /router\.push\("\/leads"\)/);
  assert.equal(translations.zh.s43.lead.salesOnly, "该线索仅销售/管理可见。");
});

test("the Chinese UI keeps the labels Show room, FB and ins untouched in the new block", () => {
  const block = JSON.stringify(translations.zh.s43);
  for (const label of ["Show room", "FB", "ins"]) assert.equal(block.includes(label), false, label);
});
