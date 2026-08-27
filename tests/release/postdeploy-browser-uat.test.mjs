import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

import {
  BROWSER_NAME,
  BROWSER_RUNNER_SOURCE_PATH,
  BROWSER_VERSION,
  CANONICAL_NAV_BY_ROLE,
  CANONICAL_ORIGIN,
  INPUT_VERSION,
  OUTPUT_VERSION,
  PLAYWRIGHT_IMAGE,
  REQUIRED_LOCALES,
  REQUIRED_ROLES,
  REQUIRED_SCREENSHOT_STEPS,
  REQUIRED_STEPS,
  STEP_TIMEOUT_MS,
  VIEWPORT,
  EDGE_INJECTED_SCRIPT_ORIGINS,
  QUALITY_FAILURE_CODE,
  QUALITY_FAILURE_LABELS,
  auditVisibleUi,
  browserRunnerSourceSha256,
  buildSafeFailureOutput,
  buildSafeSuccessOutput,
  captureRedactedScreenshot,
  qualityCounts,
  qualityFailureCode,
  routeDecision,
  validateBrowserUatInput,
  visible,
} from "../../scripts/run-postdeploy-browser-uat.mjs";
import { CONTAINER_FAILURE_CODE } from "../../scripts/canonical-browser-uat.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE = readFileSync(path.join(ROOT, BROWSER_RUNNER_SOURCE_PATH), "utf8");
const ALLOWED_ORIGIN_STRINGS = [CANONICAL_ORIGIN, "https://vfopmpxlhwzpxqegayew.supabase.co"];
const BULK_BAR = readFileSync(path.join(ROOT, "src/app/(dashboard)/leads/_components/LeadsBulkTransferBar.tsx"), "utf8");
const LEAD_CARD = readFileSync(path.join(ROOT, "src/app/(dashboard)/leads/_components/LeadCard.tsx"), "utf8");
const TRANSLATIONS = readFileSync(path.join(ROOT, "src/lib/i18n/translations.ts"), "utf8");
const SENSITIVE_UI = [
  "src/components/dashboard/DashboardSidebar.tsx",
  "src/components/dashboard/DashboardTopBar.tsx",
  "src/app/(dashboard)/leads/_components/LeadCard.tsx",
  "src/app/(dashboard)/leads/_components/LeadsHeader.tsx",
  "src/app/(dashboard)/leads/_components/LeadsPipelineSummary.tsx",
  "src/app/(dashboard)/contracts/page.tsx",
  "src/app/(dashboard)/settings/page.tsx",
  "src/app/(dashboard)/leads/[id]/page.tsx",
  "src/app/(dashboard)/leads/[id]/LeadCustomerProfile.tsx",
  "src/components/NotificationBell.tsx",
].map((file) => readFileSync(path.join(ROOT, file), "utf8")).join("\n");

function input(directory) {
  return {
    input_version: INPUT_VERSION,
    base_url: CANONICAL_ORIGIN,
    release: {
      git_sha: "a".repeat(40),
      build_id: "browser-uat-build",
      deploy_run_id: "31415926535",
      deployed_at: "2026-08-15T00:00:00Z",
    },
    fixture: {
      marker: "postdeploy-uat-10000000-0000-4000-8000-000000000010",
      lead_id: "20000000-0000-4000-8000-000000000001",
      contract_id: "20000000-0000-4000-8000-000000000002",
      contract_no: "UAT-C-20000000",
    },
    artifact_directory: directory,
    receipt_private_key_pem: `receipt-signing-material-${"a".repeat(96)}`,
    roles: REQUIRED_ROLES.map((role, index) => ({
      role,
      actor_id: `10000000-0000-4000-8000-00000000000${index + 1}`,
      email: `${role}.browser-uat@example.invalid`,
      password: ["unique", "browser", "fixture", String(index)].join("-"),
    })),
  };
}

test("browser UAT runtime is immutable, stdin-only, desktop, dual-locale, and has no skip or storage-state path", () => {
  assert.equal(PLAYWRIGHT_IMAGE, "mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948");
  assert.equal(BROWSER_NAME, "chromium");
  assert.equal(BROWSER_VERSION, "148.0.7778.96");
  assert.deepEqual(VIEWPORT, { width: 1440, height: 900 });
  assert.deepEqual(REQUIRED_ROLES, ["admin", "boss", "operator", "sales"]);
  assert.deepEqual(REQUIRED_LOCALES, ["en", "zh"]);
  assert.deepEqual(REQUIRED_STEPS, [
    "login_page_visible", "login_submitted", "landing_visible", "navigation_visible",
    "collection_card_visible", "bulk_action_verified", "detail_visible", "contract_list_visible",
    "settings_contract_verified", "locale_switched", "locale_content_verified", "locale_restored",
    "logout", "post_logout_denied",
  ]);
  assert.equal(REQUIRED_SCREENSHOT_STEPS.length, 7);
  assert.match(browserRunnerSourceSha256(), /^[0-9a-f]{64}$/);
  assert.match(SOURCE, /for \(const credential of validated\.roles\)[\s\S]*for \(const locale of REQUIRED_LOCALES\)/);
  assert.match(SOURCE, /readClosedStdin\(process\.stdin\)|readClosedStdin\(stream = process\.stdin\)/);
  // The HTTP decision moved into the pure `routeDecision`, whose truth table is
  // tested below; this stays a source assertion because the container must not
  // grow a second, inline copy of the rule. Default-deny is asserted inside the
  // function, not at the call site.
  assert.match(SOURCE, /context\.route\("\*\*\/\*"[\s\S]*routeDecision\(route\.request\(\)\.url\(\)\)[\s\S]*route\.abort\("blockedbyclient"\)/);
  assert.match(SOURCE, /export function routeDecision\(url\)[\s\S]*ALLOWED_HTTP_ORIGINS\.has\(origin\)[\s\S]*return "abort";\n\}/);
  assert.match(SOURCE, /context\.routeWebSocket\("\*\*\/\*"[\s\S]*!ALLOWED_HTTP_ORIGINS\.has\(origin\)[\s\S]*webSocketRoute\.close\([\s\S]*webSocketRoute\.connectToServer\(\)/);
  assert.match(SOURCE, /openFixtureCollection\(\)[\s\S]*recordStep\("contract_list_visible"/);
  assert.match(LEAD_CARD, /<Card[\s\S]*draggable[\s\S]*data-lead-id=\{lead\.id\}/);
  assert.match(SOURCE, /div\[draggable="true"\]\[data-lead-id="\$\{input\.fixture\.lead_id\}"\]/);
  assert.doesNotMatch(SOURCE, /fixtureCard = \(\) =>[\s\S]*filter\(\{ hasText: input\.fixture\.marker \}\)/);
  assert.match(SOURCE, /fixture_contract_link_missing[\s\S]*fixture_contract_marker_missing/);
  assert.match(SOURCE, /"Leads"[\s\S]*"线索"[\s\S]*"合同管理"/);
  assert.match(SOURCE, /non_subject_dynamic_text_hidden: true[\s\S]*evidence_copy_visible: true[\s\S]*input_values_hidden: true/);
  assert.doesNotMatch(SOURCE, /html \* \{\s*color: transparent/);
  assert.doesNotMatch(SOURCE, /locator\('div\[draggable\]'\)\.first\(\)/);
  assert.doesNotMatch(SOURCE, /process\.env/);
  assert.doesNotMatch(SOURCE, /storageState\s*[:=(]/);
  assert.doesNotMatch(SOURCE, /context\.tracing/);
  assert.doesNotMatch(SOURCE, /\.(?:skip|fixme)\s*\(/);
  assert.doesNotMatch(SOURCE, /console\.(?:log|error|warn)\s*\(/);
});

test("closed input rejects operator weakening and duplicate identities", (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "newme-browser-uat-input-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const valid = input(path.join(parent, "valid"));
  const parsed = validateBrowserUatInput(valid);
  assert.equal(parsed.roles.length, 4);
  assert.equal(parsed.base_url, CANONICAL_ORIGIN);
  assert.deepEqual(parsed.fixture, valid.fixture);

  const unknown = structuredClone(valid);
  unknown.artifact_directory = path.join(parent, "unknown");
  unknown.allow_skip = true;
  assert.throws(() => validateBrowserUatInput(unknown), /invalid_input_shape/);

  const missingLocaleRole = structuredClone(valid);
  missingLocaleRole.artifact_directory = path.join(parent, "missing-role");
  missingLocaleRole.roles.pop();
  assert.throws(() => validateBrowserUatInput(missingLocaleRole), /invalid_role_set/);

  const duplicateActor = structuredClone(valid);
  duplicateActor.artifact_directory = path.join(parent, "duplicate-actor");
  duplicateActor.roles[1].actor_id = duplicateActor.roles[0].actor_id;
  assert.throws(() => validateBrowserUatInput(duplicateActor), /invalid_actor_set/);

  const reorderedRoles = structuredClone(valid);
  reorderedRoles.artifact_directory = path.join(parent, "reordered-roles");
  [reorderedRoles.roles[0], reorderedRoles.roles[1]] = [reorderedRoles.roles[1], reorderedRoles.roles[0]];
  assert.throws(() => validateBrowserUatInput(reorderedRoles), /invalid_role_order/);

  const alternateOrigin = structuredClone(valid);
  alternateOrigin.artifact_directory = path.join(parent, "alternate-origin");
  alternateOrigin.base_url = "https://staging.example.invalid";
  assert.throws(() => validateBrowserUatInput(alternateOrigin), /invalid_input_identity/);

  const existing = structuredClone(valid);
  existing.artifact_directory = path.join(parent, "existing");
  mkdirSync(existing.artifact_directory);
  assert.throws(() => validateBrowserUatInput(existing), /artifact_directory_exists/);

  const missingFixture = structuredClone(valid);
  missingFixture.artifact_directory = path.join(parent, "missing-fixture");
  delete missingFixture.fixture;
  assert.throws(() => validateBrowserUatInput(missingFixture), /invalid_input_shape/);

  const aliasedFixture = structuredClone(valid);
  aliasedFixture.artifact_directory = path.join(parent, "aliased-fixture");
  aliasedFixture.fixture.contract_id = aliasedFixture.fixture.lead_id;
  assert.throws(() => validateBrowserUatInput(aliasedFixture), /invalid_fixture_identity/);
});

test("stdout contracts are closed and never copy role credentials", () => {
  const failure = buildSafeFailureOutput("identity_binding_failed");
  assert.deepEqual(Object.keys(failure), ["output_version", "status", "failure_code"]);
  assert.equal(failure.output_version, OUTPUT_VERSION);

  const sessions = [{
    role: "admin",
    actor_id: "10000000-0000-4000-8000-000000000001",
    locale: "en",
    subject: {
      lead_id: "20000000-0000-4000-8000-000000000001",
      contract_id: "20000000-0000-4000-8000-000000000002",
      marker_sha256: "d".repeat(64),
    },
    status: "pass",
    completed_at: "2026-08-15T00:10:00Z",
    artifact_id: "browser_admin_en",
  }];
  const artifacts = [{
    id: "browser_admin_en",
    kind: "browser_uat",
    path: "admin/en/artifact.json",
    sha256: "b".repeat(64),
    media_type: "application/json",
  }];
  const success = buildSafeSuccessOutput({
    release: { git_sha: "a".repeat(40), build_id: "build", deploy_run_id: "1", deployed_at: "2026-08-15T00:00:00Z" },
    artifactDirectory: "/var/lib/newme/browser-uat",
    runnerSourceSha256: "c".repeat(64),
    sessions,
    artifacts,
  });
  assert.deepEqual(Object.keys(success), [
    "output_version",
    "status",
    "release",
    "artifact_directory",
    "runner_source",
    "playwright_image",
    "browser_name",
    "browser_version",
    "viewport",
    "sessions",
    "artifacts",
    "completed_at",
  ]);
  const output = JSON.stringify(success);
  assert.doesNotMatch(output, /example\.invalid|unique-browser-secret|receipt_private_key/);
});

test("browser screenshot contracts preserve bilingual evidence copy while masking account and non-subject data", () => {
  for (const key of ["bulkSelected", "selectAllCount", "clear", "transferAction", "selectUser", "transferring", "transferCount"]) {
    assert.match(BULK_BAR, new RegExp(`t\\(\\"leads\\.${key}\\"\\)`));
  }
  for (const copy of ["{n} leads selected", "已选择 {n} 条线索", "Transfer →", "转移 →", "Quick Create Lead", "快速创建线索"]) {
    assert.ok(TRANSLATIONS.includes(copy), `missing closed bilingual copy ${copy}`);
  }
  assert.ok((SENSITIVE_UI.match(/data-newme-uat-sensitive="true"/g) ?? []).length >= 10);
  assert.match(SOURCE, /data-newme-uat-runtime-mask[\s\S]*data-newme-uat-runtime-sensitive-value[\s\S]*data-newme-uat-sensitive/);
  assert.doesNotMatch(SOURCE, /removeAttribute\("data-newme-uat-sensitive"\)/);
  assert.match(SOURCE, /dynamicSurfaces[\s\S]*data-newme-uat-contract-id[\s\S]*tbody tr/);
  assert.match(SENSITIVE_UI, /data-newme-uat-contract-id=\{c\.id\}/);
  assert.match(SENSITIVE_UI, /data-newme-uat-sensitive="true" className="grid grid-cols-2 lg:grid-cols-4/);
  assert.match(SENSITIVE_UI, /data-newme-uat-sensitive="true" className="grid grid-cols-3 gap-3/);
  assert.match(SENSITIVE_UI, /data-newme-uat-sensitive="true" className="grid grid-cols-3 sm:grid-cols-5/);
  assert.doesNotMatch(SOURCE, /html \* \{\s*color: transparent/);
});

test("real Chromium PNG keeps app markers while exposing only safe copy inside dynamic surfaces", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "newme-browser-redaction-"));
  const screenshot = path.join(directory, "redacted.png");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html>
    <style>
      html, body { margin: 0; background: rgb(255, 255, 255); color: rgb(0, 0, 0); }
      .line { display: block; width: max-content; height: 46px; font: 32px/46px Arial, sans-serif; background: rgb(255, 255, 255); }
      input { display: block; width: 360px; height: 46px; padding: 0; border: 0; outline: 0; background: rgb(255, 255, 255); color: rgb(0, 0, 0); font: 32px/46px Arial, sans-serif; }
    </style>
    <div id="app-pii" class="line" data-newme-uat-sensitive="true">APP-ACCOUNT-SECRET</div>
    <div draggable="true">
      <span id="safe-marker" class="line">SAFE-UAT-MARKER</span>
      <span id="subject-pii" class="line">SUBJECT-OWNER-SECRET</span>
    </div>
    <div data-newme-uat-contract-id="foreign-contract">
      <span id="foreign-customer" class="line">FOREIGN-CUSTOMER-SECRET</span>
      <span id="foreign-amount" class="line">AED-987654321</span>
    </div>
    <input id="private-input" value="PRIVATE-INPUT-SECRET">
    <div id="static-label" class="line">STATIC-BILINGUAL-LABEL</div>`);

  const ids = ["app-pii", "safe-marker", "subject-pii", "foreign-customer", "foreign-amount", "private-input", "static-label"];
  const boxes = Object.fromEntries(await Promise.all(ids.map(async (id) => {
    const box = await page.locator(`#${id}`).boundingBox();
    assert.ok(box, `missing box for ${id}`);
    return [id, box];
  })));

  await captureRedactedScreenshot(page, screenshot, [page.locator("#safe-marker"), page.locator("#static-label")]);
  assert.equal(await page.locator("#app-pii").getAttribute("data-newme-uat-sensitive"), "true");
  assert.equal(await page.locator('[data-newme-uat-runtime-mask]').count(), 0);
  assert.equal(await page.locator('[data-newme-uat-runtime-sensitive-value]').count(), 0);

  const pngDataUrl = `data:image/png;base64,${readFileSync(screenshot).toString("base64")}`;
  const nonWhitePixels = await page.evaluate(async ({ source, regions }) => {
    const image = new Image();
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    });
    image.src = source;
    await loaded;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const graphics = canvas.getContext("2d", { willReadFrequently: true });
    graphics.drawImage(image, 0, 0);
    const output = {};
    for (const [id, box] of Object.entries(regions)) {
      const left = Math.max(0, Math.floor(box.x));
      const top = Math.max(0, Math.floor(box.y));
      const width = Math.max(1, Math.ceil(box.width));
      const height = Math.max(1, Math.ceil(box.height));
      const pixels = graphics.getImageData(left, top, width, height).data;
      let count = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] > 0 && (pixels[offset] < 245 || pixels[offset + 1] < 245 || pixels[offset + 2] < 245)) count += 1;
      }
      output[id] = count;
    }
    return output;
  }, { source: pngDataUrl, regions: boxes });

  assert.ok(nonWhitePixels["safe-marker"] > 50, JSON.stringify(nonWhitePixels));
  assert.ok(nonWhitePixels["static-label"] > 50, JSON.stringify(nonWhitePixels));
  for (const id of ["app-pii", "subject-pii", "foreign-customer", "foreign-amount", "private-input"]) {
    assert.equal(nonWhitePixels[id], 0, `${id} leaked pixels: ${JSON.stringify(nonWhitePixels)}`);
  }
});

test("layout quality ignores fully offscreen compatibility controls but still detects visible overlaps", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html>
    <style>
      .offscreen { position: fixed; left: -1px; top: -1px; width: 1px; height: 1px; padding: 0; border: 0; }
      .visible { position: fixed; left: 20px; top: 20px; width: 80px; height: 40px; }
    </style>
    <input class="offscreen"><input class="offscreen"><input class="offscreen">
    <button class="visible">One</button><button class="visible">Two</button>
    <span style="position: absolute; top: 1200px">common.missingBelowFold</span>`);

  const withVisibleOverlap = await auditVisibleUi(page);
  assert.equal(withVisibleOverlap.overlap_violation_count, 1);
  assert.equal(withVisibleOverlap.raw_i18n_key_count, 1);

  await page.locator("button").evaluateAll((buttons) => buttons.forEach((button) => button.remove()));
  const offscreenOnly = await auditVisibleUi(page);
  assert.equal(offscreenOnly.overlap_violation_count, 0);
  assert.equal(offscreenOnly.raw_i18n_key_count, 1);
});

/**
 * A locator that only ever answers waitFor.
 *
 * count() throws: production pages render client side, so any count taken
 * before the wait measures the first paint instead of the page. If a future
 * edit reintroduces one, this stub turns that into a failing test rather than
 * an acceptance run that refuses on its first step.
 */
function waitOnlyLocator(waitFor) {
  const handle = { waitFor };
  return {
    first: () => handle,
    count: () => {
      throw new Error("count_consulted_before_waiting");
    },
  };
}

function timeoutError() {
  const error = new Error("locator.waitFor: Timeout 30000ms exceeded.");
  error.name = "TimeoutError";
  return error;
}

test("visible waits for a control that is absent at first paint", async () => {
  const calls = [];
  const locator = waitOnlyLocator(async (options) => {
    calls.push(options);
  });

  const handle = await visible(locator, "email_control_missing");

  assert.equal(handle, locator.first());
  assert.deepEqual(calls, [{ state: "visible", timeout: STEP_TIMEOUT_MS }]);
});

test("visible still refuses with its own code once the wait times out", async () => {
  const locator = waitOnlyLocator(async () => {
    throw timeoutError();
  });

  await assert.rejects(
    () => visible(locator, "email_control_missing"),
    (error) => error.code === "email_control_missing" && error.message === "email_control_missing",
  );
});

test("visible propagates a non-timeout failure instead of calling it a missing control", async () => {
  const closed = new Error("Target page, context or browser has been closed");
  const locator = waitOnlyLocator(async () => {
    throw closed;
  });

  await assert.rejects(() => visible(locator, "email_control_missing"), (error) => {
    assert.equal(error, closed);
    assert.equal(error.code, undefined);
    return true;
  });
});

test("the login step waits for the control the production page renders client side", () => {
  // Guards the call site, not just the helper: the first step must consult
  // visible() for both credentials fields, because /login answers 200 with an
  // empty bailout boundary and fills it in afterwards.
  const step = SOURCE.slice(SOURCE.indexOf('recordStep("login_page_visible"'), SOURCE.indexOf('recordStep("login_submitted"'));
  assert.match(step, /await visible\(page\.locator\("#email"\), "email_control_missing"\)/);
  assert.match(step, /await visible\(page\.locator\("#password"\), "password_control_missing"\)/);
  assert.doesNotMatch(step, /#email"\)\.count\(\)/);
});

/**
 * The runner's navigation contract must equal the sidebar it is judging.
 *
 * nav.ts is the single source of truth and this file is the only thing that can
 * hold the runner's copy of it to account: the browser image mounts the two
 * acceptance scripts and nothing else, so the runner cannot read nav.ts at the
 * time it matters. Parsing hrefs in declaration order is enough -- order is
 * asserted on the server too, because the runner compares the rendered list to
 * this one with JSON.stringify.
 */
function navHrefs(source, arrayName) {
  const start = source.indexOf(`export const ${arrayName}: NavItem[] = [`);
  assert.ok(start >= 0, `${arrayName} not found in src/lib/nav.ts`);
  const end = source.indexOf("\n];", start);
  assert.ok(end > start, `${arrayName} is not terminated in src/lib/nav.ts`);
  const body = source.slice(start, end);
  // One entry per `{ href: ... }` object, carrying its optional `roles` audience
  // so a role-narrowed item can be filtered exactly as navForRole() filters it.
  return [...body.matchAll(/\{\s*href:\s*"([^"]+)"([^}]*)\}/g)].map((match) => {
    const roles = [...match[2].matchAll(/"([a-z_]+)"/g)].map((role) => role[1]);
    const declaresRoles = /roles:\s*\[/.test(match[2]);
    return { href: match[1], roles: declaresRoles ? roles : null };
  });
}

test("the acceptance navigation contract matches src/lib/nav.ts for every role", () => {
  const nav = readFileSync(path.join(ROOT, "src/lib/nav.ts"), "utf8");

  const mgmt = navHrefs(nav, "MGMT_NAV");
  const sales = navHrefs(nav, "SALES_NAV");

  // Guard the parser itself: a regex that silently matched nothing would make
  // every comparison below trivially pass.
  assert.ok(mgmt.length >= 10, `parsed only ${mgmt.length} management hrefs`);
  assert.ok(sales.length >= 8, `parsed only ${sales.length} sales hrefs`);
  assert.ok(mgmt.some((entry) => entry.roles), "no MGMT_NAV item declares a narrowed audience");
  for (const array of [mgmt, sales]) {
    assert.ok(array.some((entry) => entry.href === "/cable-costing"));
  }

  assert.deepEqual(Object.keys(CANONICAL_NAV_BY_ROLE).sort(), [...REQUIRED_ROLES].sort());

  for (const role of REQUIRED_ROLES) {
    const source = role === "sales" ? sales : mgmt;
    const expected = source
      .filter((entry) => !entry.roles || entry.roles.includes(role))
      .map((entry) => entry.href);
    assert.deepEqual([...CANONICAL_NAV_BY_ROLE[role]], expected, `sidebar contract for ${role}`);
  }
});
test("every quality counter has a failure label", () => {
  // Recomputed from the producer, not restated: a counter added to
  // qualityCounts() without a label here would fall back to the opaque code.
  assert.deepEqual(Object.keys(QUALITY_FAILURE_LABELS).sort(), Object.keys(qualityCounts()).sort());
  for (const label of Object.values(QUALITY_FAILURE_LABELS)) {
    assert.match(label, /^[a-z][a-z0-9_]*$/);
  }
  assert.equal(new Set(Object.values(QUALITY_FAILURE_LABELS)).size, Object.keys(QUALITY_FAILURE_LABELS).length);
});

test("quality failure codes survive both regexes in the worst case", () => {
  // The runner writes any code matching /^[a-z0-9_]{3,80}$/ but its consumer
  // redacts anything over 63 characters, so the real budget belongs to the
  // consumer. Enumerate instead of reasoning about lengths.
  let longest = "";
  for (const counter of Object.keys(qualityCounts())) {
    for (const role of REQUIRED_ROLES) {
      for (const locale of REQUIRED_LOCALES) {
        for (const step of [...REQUIRED_STEPS, "final"]) {
          const quality = { ...qualityCounts(), [counter]: 1 };
          const code = qualityFailureCode(quality, { role, locale, step });
          assert.notEqual(code, "browser_quality_gate_failed", `${counter}/${role}/${locale}/${step} fell back`);
          assert.match(code, QUALITY_FAILURE_CODE);
          assert.match(code, CONTAINER_FAILURE_CODE);
          assert.equal(buildSafeFailureOutput(code).failure_code, code);
          assert.ok(code.includes(QUALITY_FAILURE_LABELS[counter]) && code.includes(role) && code.includes(step));
          if (code.length > longest.length) longest = code;
        }
      }
    }
  }
  // Guard the enumeration itself: an empty loop would pass every assertion above.
  assert.ok(longest.length >= 40, `worst case was only ${longest.length} characters`);
  assert.ok(longest.length <= 63, `worst case ${longest} exceeds the consumer budget`);
  assert.equal(qualityFailureCode(qualityCounts(), { role: "admin", locale: "en", step: "logout" }), null);
  // A step name long enough to break the budget must degrade to the opaque code,
  // never to a redaction at the far end.
  const overlong = qualityFailureCode({ ...qualityCounts(), raw_i18n_key_count: 1 }, {
    role: "operator", locale: "zh", step: "x".repeat(64),
  });
  assert.equal(overlong, "browser_quality_gate_failed");
  assert.match(overlong, CONTAINER_FAILURE_CODE);
});

test("route decisions allow canonical and edge-injected origins and nothing else", () => {
  assert.equal(routeDecision(`${CANONICAL_ORIGIN}/leads`), "continue");
  assert.equal(routeDecision("data:text/html,<p>x</p>"), "continue");
  assert.equal(routeDecision("about:blank"), "continue");
  assert.equal(routeDecision("https://app.evil.example/x.js"), "abort");
  assert.equal(routeDecision("https://us.i.posthog.com/array.js"), "abort");
  assert.equal(routeDecision("not a url"), "abort");
  assert.equal(routeDecision(undefined), "abort");
  assert.ok(EDGE_INJECTED_SCRIPT_ORIGINS.size >= 1);
  for (const origin of EDGE_INJECTED_SCRIPT_ORIGINS) {
    assert.equal(routeDecision(`${origin}/beacon.min.js`), "continue");
    // The rule covers the origin, not one path: the beacon filename carries a
    // version that changes without notice.
    assert.equal(routeDecision(`${origin}/beacon.min.js/vcd15cbe.js`), "continue");
    assert.ok(!ALLOWED_ORIGIN_STRINGS.includes(origin), "an edge-injected origin is not a canonical one");
  }
  // The gate must never synthesise a response body. The edge injects its beacon
  // tag with an `integrity` attribute, so a stub cannot satisfy the digest, and
  // Chromium counts the SRI rejection as a console error -- the very failure a
  // stub would be added to remove.
  assert.doesNotMatch(SOURCE, /route\.fulfill\(/);
});
