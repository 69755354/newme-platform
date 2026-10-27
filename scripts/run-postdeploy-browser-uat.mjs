#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { canonicalJsonBytes, signPostdeployArtifact } from "./postdeploy-receipt.mjs";

export const INPUT_VERSION = "newme-postdeploy-browser-uat-input/v1";
export const OUTPUT_VERSION = "newme-postdeploy-browser-uat-output/v1";
export const ARTIFACT_VERSION = "newme-postdeploy-artifact/v1";
export const TRACE_VERSION = "newme-postdeploy-browser-trace/v1";
export const REDACTION_VERSION = "newme-postdeploy-browser-redaction/v2";
export const BROWSER_RUNNER = "newme-postdeploy-browser-uat/v1";
export const BROWSER_RUNNER_SOURCE_PATH = "scripts/run-postdeploy-browser-uat.mjs";
export const CANONICAL_ORIGIN = "https://app.newme.ae";
export const CANONICAL_DATA_ORIGIN = "https://vfopmpxlhwzpxqegayew.supabase.co";
export const PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948";
export const BROWSER_NAME = "chromium";
export const BROWSER_VERSION = "148.0.7778.96";
export const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
export const REQUIRED_ROLES = Object.freeze(["admin", "boss", "operator", "sales"]);
export const REQUIRED_LOCALES = Object.freeze(["en", "zh"]);
export const REQUIRED_STEPS = Object.freeze([
  "login_page_visible",
  "login_submitted",
  "landing_visible",
  "navigation_visible",
  "collection_card_visible",
  "bulk_action_verified",
  "detail_visible",
  "contract_list_visible",
  "settings_contract_verified",
  "locale_switched",
  "locale_content_verified",
  "locale_restored",
  "logout",
  "post_logout_denied",
]);
export const REQUIRED_SCREENSHOT_STEPS = Object.freeze([
  "login_page_visible",
  "collection_card_visible",
  "bulk_action_verified",
  "detail_visible",
  "contract_list_visible",
  "settings_contract_verified",
  "locale_content_verified",
]);
export const REQUIRED_HTTP_CHECKS = Object.freeze(["login", "identity", "logout", "post_logout_denied"]);

const SHA40 = /^[0-9a-f]{40}$/;
const BUILD_ID = /^[^\s]{1,128}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIXTURE_MARKER = /^postdeploy-uat-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTRACT_NO = /^UAT-C-[0-9a-f]{8}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const MAX_STDIN_BYTES = 256 * 1024;
export const STEP_TIMEOUT_MS = 30_000;
const SCREENSHOT_MEDIA_TYPE = "image/png";
const TRACE_MEDIA_TYPE = "application/json";
const ALLOWED_HTTP_ORIGINS = new Set([CANONICAL_ORIGIN, CANONICAL_DATA_ORIGIN]);

/**
 * Origins whose scripts are injected by the edge, not by this repository.
 *
 * Cloudflare Web Analytics rewrites the HTML on the way out and appends its
 * beacon tag; nothing in `src/**` references it, so it cannot be removed from
 * the application. Aborting it is what used to fail the gate: Playwright
 * surfaces Chromium's Log.entryAdded for a blocked script as a console error,
 * so the counter went non-zero on every page of every role.
 *
 * These origins are therefore fetched for real, and the cheaper answer was
 * measured before it was rejected: the tag the edge injects carries
 * `integrity="sha512-..."` and `crossorigin="anonymous"`, so fulfilling the
 * request with an empty body fails the SRI digest and Chromium reports *that*
 * as a console error instead. No synthesised body can satisfy a digest we
 * cannot preimage.
 *
 * Fetching it is also the stronger gate. The beacon is served by the same edge
 * that serves the app, so it adds no availability coupling; its own request
 * goes to same-origin `/cdn-cgi/rum`, which is neither a document nor one of
 * the critical API prefixes and so cannot manufacture an HTTP failure; and
 * letting it load is what keeps proving the CSP admits it. A stub would make
 * this gate blind to exactly the regression it exists to catch.
 *
 * `tests/security/sam15-boundaries.test.mjs` binds this set to the CSP origin
 * inventory, so adding an origin here without justifying it there fails.
 */
export const EDGE_INJECTED_SCRIPT_ORIGINS = new Set(["https://static.cloudflareinsights.com"]);

/**
 * What the container should do with one request. Pure, so it is testable.
 *
 * Returns "continue" | "abort". Anything unparsable is aborted: a URL the
 * runner cannot reason about must not reach the network. The two allow branches
 * stay separate so a reader can see which set admitted the URL.
 */
export function routeDecision(url) {
  if (typeof url !== "string") return "abort";
  if (/^(?:about|blob|data):/.test(url)) return "continue";
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return "abort";
  }
  if (ALLOWED_HTTP_ORIGINS.has(origin)) return "continue";
  if (EDGE_INJECTED_SCRIPT_ORIGINS.has(origin)) return "continue";
  return "abort";
}
const UI_COPY = Object.freeze({
  en: Object.freeze({
    leads: "Leads", contracts: "Contracts", settings: "Admin Panel", create: "Create", signIn: "Sign In", logout: "Logout",
    managementLeadsNav: "Leads", salesLeadsNav: "My Leads", managementContractsNav: "Contracts & Payments", salesContractsNav: "My Contracts",
    transferAction: "Transfer →", cancel: "Cancel", clear: "Clear", quickCreate: "Quick Create Lead", settingsSearch: "Search name/phone/area...", settingsAll: "All",
  }),
  zh: Object.freeze({
    leads: "线索", contracts: "合同管理", settings: "系统管理", create: "新建", signIn: "登录", logout: "退出",
    managementLeadsNav: "线索", salesLeadsNav: "我的线索", managementContractsNav: "合同&回款", salesContractsNav: "我的合同",
    transferAction: "转移 →", cancel: "取消", clear: "清除", quickCreate: "快速创建线索", settingsSearch: "搜索姓名/电话/区域...", settingsAll: "全部",
  }),
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!isObject(value)) fail(code);
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) fail(code);
  if (keys.some((key) => !Object.hasOwn(value, key))) fail(code);
}

function utcSecond(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function validTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && utcSecond(new Date(milliseconds)) === value;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safePathname(url) {
  const parsed = new URL(url, CANONICAL_ORIGIN);
  return parsed.pathname || "/";
}

function validateAbsoluteArtifactDirectory(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 1024 || !path.isAbsolute(value)) {
    fail("invalid_artifact_directory");
  }
  const resolved = path.resolve(value);
  if (existsSync(resolved)) fail("artifact_directory_exists");
  const parent = path.dirname(resolved);
  if (!existsSync(parent)) fail("artifact_parent_missing");
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) fail("artifact_parent_untrusted");
  if (realpathSync(parent) !== parent) fail("artifact_parent_untrusted");
  return resolved;
}

export function validateBrowserUatInput(value) {
  exactKeys(value, [
    "input_version",
    "base_url",
    "release",
    "fixture",
    "artifact_directory",
    "receipt_private_key_pem",
    "roles",
  ], "invalid_input_shape");
  if (value.input_version !== INPUT_VERSION || value.base_url !== CANONICAL_ORIGIN) fail("invalid_input_identity");
  exactKeys(value.release, ["git_sha", "build_id", "deploy_run_id", "deployed_at"], "invalid_release_shape");
  if (!SHA40.test(value.release.git_sha) || !BUILD_ID.test(value.release.build_id) || !RUN_ID.test(value.release.deploy_run_id)) {
    fail("invalid_release_identity");
  }
  if (!validTimestamp(value.release.deployed_at)) fail("invalid_release_time");
  exactKeys(value.fixture, ["marker", "lead_id", "contract_id", "contract_no"], "invalid_fixture_shape");
  if (
    !FIXTURE_MARKER.test(value.fixture.marker)
    || !UUID.test(value.fixture.lead_id)
    || !UUID.test(value.fixture.contract_id)
    || value.fixture.lead_id === value.fixture.contract_id
    || !CONTRACT_NO.test(value.fixture.contract_no)
  ) fail("invalid_fixture_identity");
  const artifactDirectory = validateAbsoluteArtifactDirectory(value.artifact_directory);
  if (
    typeof value.receipt_private_key_pem !== "string"
    || value.receipt_private_key_pem.length < 64
    || value.receipt_private_key_pem.length > 16 * 1024
  ) fail("invalid_receipt_key");
  if (!Array.isArray(value.roles) || value.roles.length !== REQUIRED_ROLES.length) fail("invalid_role_set");
  const roleNames = new Set();
  const actorIds = new Set();
  const emails = new Set();
  const roles = value.roles.map((role) => {
    exactKeys(role, ["role", "actor_id", "email", "password"], "invalid_role_shape");
    if (!REQUIRED_ROLES.includes(role.role) || roleNames.has(role.role)) fail("invalid_role_set");
    if (typeof role.actor_id !== "string" || !UUID.test(role.actor_id) || actorIds.has(role.actor_id)) fail("invalid_actor_set");
    if (
      typeof role.email !== "string"
      || role.email.length < 3
      || role.email.length > 320
      || !role.email.includes("@")
      || emails.has(role.email.toLowerCase())
    ) fail("invalid_email_set");
    if (typeof role.password !== "string" || role.password.length < 1 || role.password.length > 4096) fail("invalid_password_shape");
    roleNames.add(role.role);
    actorIds.add(role.actor_id);
    emails.add(role.email.toLowerCase());
    return role;
  });
  if (REQUIRED_ROLES.some((role) => !roleNames.has(role))) fail("invalid_role_set");
  if (roles.map((role) => role.role).join(",") !== REQUIRED_ROLES.join(",")) fail("invalid_role_order");
  return {
    input_version: value.input_version,
    base_url: value.base_url,
    release: { ...value.release },
    fixture: { ...value.fixture },
    artifact_directory: artifactDirectory,
    receipt_private_key_pem: value.receipt_private_key_pem,
    roles,
  };
}

async function readClosedStdin(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) fail("stdin_too_large");
    chunks.push(chunk);
  }
  if (total === 0) fail("stdin_empty");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("stdin_invalid_json");
  }
  return validateBrowserUatInput(parsed);
}

function createArtifactDirectory(directory) {
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

function writeClosedFile(file, bytes, mode = 0o600) {
  writeFileSync(file, bytes, { flag: "wx", mode });
  if (process.platform !== "win32") chmodSync(file, mode);
}

function relativeEvidencePath(root, absolute) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) fail("artifact_path_escape");
  return relative;
}

function responseDigest(bytes) {
  return sha256(bytes);
}

async function hashedResponse(response) {
  const bytes = await response.body();
  return {
    http_status: response.status(),
    response_sha256: responseDigest(bytes),
    completed_at: utcSecond(),
  };
}

export function qualityCounts() {
  return {
    console_error_count: 0,
    page_error_count: 0,
    critical_http_failure_count: 0,
    overflow_violation_count: 0,
    overlap_violation_count: 0,
    raw_i18n_key_count: 0,
  };
}

export function isExpectedDeniedResourceConsole({ type, text, url }) {
  if (type !== "error" || typeof text !== "string" || typeof url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.origin !== CANONICAL_ORIGIN
    || parsed.pathname !== "/api/auth/me"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) return false;
  return /^Failed to load resource: the server responded with a status of (?:401|403)(?: \([^\r\n]{0,32}\))?$/.test(text);
}

export function shouldCountCriticalRequestFailure({ resourceType, pathname, errorText }) {
  const critical = resourceType === "document"
    || /^\/api\/(?:auth|leads|settings|contracts)(?:\/|$)/.test(pathname);
  if (!critical) return false;
  // Chromium reports a navigation-cancelled fetch as net::ERR_ABORTED even
  // when the server completed it successfully. That is not an HTTP failure.
  // Never apply this exception to a document navigation, and keep every other
  // transport error fail-closed.
  return !(resourceType !== "document" && errorText === "net::ERR_ABORTED");
}

export function runtimeFailureCode(error, { role, locale, step }) {
  if (typeof error?.code === "string" && /^[a-z][a-z0-9_]{1,62}$/.test(error.code)) return error.code;
  const kind = ({
    TimeoutError: "timeout",
    TargetClosedError: "target_closed",
    ProtocolError: "protocol",
    TypeError: "type",
    Error: "error",
  })[error?.name] || "unexpected";
  const code = `runtime_${kind}_${role}_${locale}_${step}`;
  return /^[a-z][a-z0-9_]{1,62}$/.test(code) ? code : `runtime_${kind}_${role}_${locale}`;
}

/**
 * Counter name -> the token that goes in the failure code.
 *
 * Frozen and exported so the test can assert its keys are exactly the counters
 * `qualityCounts()` produces. A counter added without a label here would
 * silently fall back to the opaque code this change exists to remove.
 */
export const QUALITY_FAILURE_LABELS = Object.freeze({
  console_error_count: "console_error",
  page_error_count: "page_error",
  critical_http_failure_count: "critical_http",
  overflow_violation_count: "overflow",
  overlap_violation_count: "overlap",
  raw_i18n_key_count: "raw_i18n_key",
});

/**
 * The shape a failure code must satisfy to survive its consumer.
 *
 * Deliberately the consumer's regex, not this file's looser one: a 70-character
 * code passes `buildSafeFailureOutput` and then arrives as
 * `<redacted-failure-code>` at the other end, which is worse than the opaque
 * code because it looks like a redaction decision rather than a length bug.
 */
export const QUALITY_FAILURE_CODE = /^[a-z][a-z0-9_]{1,62}$/;

/**
 * Name the first non-zero counter, with the role/locale/step that produced it.
 * Returns null when nothing is broken.
 */
export function qualityFailureCode(quality, context = {}) {
  const broken = Object.keys(QUALITY_FAILURE_LABELS).filter((counter) => (quality?.[counter] ?? 0) !== 0);
  if (broken.length === 0) return null;
  const parts = ["quality", QUALITY_FAILURE_LABELS[broken[0]], context.role, context.locale, context.step];
  const code = parts.filter((part) => typeof part === "string" && part.length > 0).join("_");
  // Never widen the contract to fit a long code: fall back instead, so a future
  // step name cannot turn a diagnostic into a redaction.
  return QUALITY_FAILURE_CODE.test(code) ? code : "browser_quality_gate_failed";
}

function assertZeroQuality(quality, context = {}) {
  const code = qualityFailureCode(quality, context);
  if (code !== null) fail(code);
}

export async function auditVisibleUi(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0
        && rectangle.width > 0 && rectangle.height > 0;
    };
    const visibleRectangle = (element) => {
      if (!visible(element)) return null;
      const rectangle = element.getBoundingClientRect();
      let left = Math.max(0, rectangle.left);
      let right = Math.min(window.innerWidth, rectangle.right);
      let top = Math.max(0, rectangle.top);
      let bottom = Math.min(window.innerHeight, rectangle.bottom);
      for (let ancestor = element.parentElement; ancestor && right > left && bottom > top; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const clipX = ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
        const clipY = ["auto", "scroll", "hidden", "clip"].includes(style.overflowY);
        if (!clipX && !clipY) continue;
        const bounds = ancestor.getBoundingClientRect();
        if (clipX) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        if (clipY) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }
      return right > left && bottom > top
        ? { left, right, top, bottom, width: right - left, height: bottom - top }
        : null;
    };
    const rootOverflow = document.documentElement.scrollWidth > window.innerWidth + 1
      || document.body.scrollWidth > window.innerWidth + 1;
    const rawKeyPattern = /\b(?:common|nav|login|dashboard|leads|settings|contracts|quotes|payments)\.[A-Za-z0-9_.-]+\b/;
    const rawI18nKeys = [...document.querySelectorAll("body *")]
      .filter((element) => visible(element) && element.children.length === 0)
      .filter((element) => rawKeyPattern.test(element.textContent ?? ""));
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(visible);
    const scope = dialog ?? document.body;
    const interactives = [...scope.querySelectorAll('a,button,input,select,textarea,[role="button"]')]
      .filter((element) => element.closest('a,button,[role="button"]') === element || !element.closest('a,button,[role="button"]'))
      .map((element) => ({ element, rectangle: visibleRectangle(element) }))
      .filter((entry) => entry.rectangle !== null);
    let overlaps = 0;
    for (let left = 0; left < interactives.length; left += 1) {
      for (let right = left + 1; right < interactives.length; right += 1) {
        const a = interactives[left];
        const b = interactives[right];
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const width = Math.max(0, Math.min(a.rectangle.right, b.rectangle.right) - Math.max(a.rectangle.left, b.rectangle.left));
        const height = Math.max(0, Math.min(a.rectangle.bottom, b.rectangle.bottom) - Math.max(a.rectangle.top, b.rectangle.top));
        const intersection = width * height;
        const minimumArea = Math.min(a.rectangle.width * a.rectangle.height, b.rectangle.width * b.rectangle.height);
        if (minimumArea > 0 && intersection / minimumArea > 0.8) overlaps += 1;
      }
    }
    return {
      overflow_violation_count: rootOverflow ? 1 : 0,
      overlap_violation_count: overlaps,
      raw_i18n_key_count: rawI18nKeys.length,
    };
  });
}

export async function captureRedactedScreenshot(page, file, safeLocators) {
  if (!Array.isArray(safeLocators) || safeLocators.length === 0) fail("screenshot_safe_surface_missing");
  await page.evaluate(() => {
    window.__newmeUatScrollSnapshot = {
      windowX: window.scrollX,
      windowY: window.scrollY,
      elements: [...document.querySelectorAll("*")]
        .filter((element) => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight)
        .map((element) => ({ element, left: element.scrollLeft, top: element.scrollTop })),
    };
  });
  try {
  const safeElements = [];
  for (const locator of safeLocators) {
    if (await locator.count() < 1) fail("screenshot_safe_surface_missing");
    const element = locator.first();
    await element.scrollIntoViewIfNeeded();
    safeElements.push(element);
    await element.evaluate((root) => {
      root.setAttribute("data-newme-uat-safe-copy", "true");
      for (const element of [root, ...root.querySelectorAll("*")]) {
        element.style.setProperty("--newme-uat-original-color", getComputedStyle(element).color);
      }
    });
  }
  const viewport = page.viewportSize();
  if (!viewport) fail("screenshot_viewport_missing");
  for (const element of safeElements) {
    const box = await element.boundingBox();
    if (
      !box
      || box.width <= 0
      || box.height <= 0
      || box.x >= viewport.width
      || box.y >= viewport.height
      || box.x + box.width <= 0
      || box.y + box.height <= 0
    ) fail("screenshot_evidence_out_of_viewport");
  }
  await page.evaluate(() => {
    const dynamicSurfaces = [
      ...document.querySelectorAll('div[draggable="true"]'),
      ...document.querySelectorAll('[data-newme-uat-contract-id]'),
      ...document.querySelectorAll('tbody tr'),
    ];
    for (const element of dynamicSurfaces) {
      element.setAttribute("data-newme-uat-runtime-mask", "true");
    }
    for (const element of document.querySelectorAll("input, textarea, select, [contenteditable='true']")) {
      element.setAttribute("data-newme-uat-runtime-sensitive-value", "true");
    }
  });
  const styleHandle = await page.addStyleTag({ content: `
    html [data-newme-uat-runtime-mask="true"],
    html [data-newme-uat-runtime-mask="true"] * {
      color: transparent !important;
      text-shadow: none !important;
      caret-color: transparent !important;
      background-image: none !important;
    }
    html [data-newme-uat-runtime-mask="true"] [data-newme-uat-safe-copy="true"],
    html [data-newme-uat-runtime-mask="true"] [data-newme-uat-safe-copy="true"] * {
      color: var(--newme-uat-original-color) !important;
    }
    html [data-newme-uat-sensitive="true"],
    html [data-newme-uat-sensitive="true"] * {
      color: transparent !important;
      text-shadow: none !important;
      caret-color: transparent !important;
      background-image: none !important;
    }
    html img, html svg, html canvas, html video, html iframe {
      visibility: hidden !important;
    }
    html [data-newme-uat-runtime-sensitive-value="true"] {
      color: transparent !important;
      text-shadow: none !important;
      background-image: none !important;
    }
    html input::placeholder, html textarea::placeholder {
      color: transparent !important;
    }
  ` });
  try {
    await page.screenshot({ path: file, fullPage: false, animations: "disabled", caret: "hide" });
  } finally {
    await styleHandle.evaluate((element) => element.remove());
    await page.evaluate(() => {
      for (const root of document.querySelectorAll('[data-newme-uat-safe-copy="true"]')) {
        root.removeAttribute("data-newme-uat-safe-copy");
      }
      for (const element of document.querySelectorAll('[style*="--newme-uat-original-color"]')) {
        element.style.removeProperty("--newme-uat-original-color");
      }
      for (const element of document.querySelectorAll('[data-newme-uat-runtime-mask="true"]')) {
        element.removeAttribute("data-newme-uat-runtime-mask");
      }
      for (const element of document.querySelectorAll('[data-newme-uat-runtime-sensitive-value="true"]')) {
        element.removeAttribute("data-newme-uat-runtime-sensitive-value");
      }
    });
  }
  if (process.platform !== "win32") chmodSync(file, 0o600);
  } finally {
    await page.evaluate(() => {
      const snapshot = window.__newmeUatScrollSnapshot;
      if (snapshot) {
        for (const entry of snapshot.elements) {
          const inlineBehavior = entry.element.style.getPropertyValue("scroll-behavior");
          const inlinePriority = entry.element.style.getPropertyPriority("scroll-behavior");
          entry.element.style.setProperty("scroll-behavior", "auto", "important");
          entry.element.scrollTo({ left: entry.left, top: entry.top, behavior: "auto" });
          if (inlineBehavior) entry.element.style.setProperty("scroll-behavior", inlineBehavior, inlinePriority);
          else entry.element.style.removeProperty("scroll-behavior");
        }
        const roots = [document.documentElement, document.body];
        const rootBehaviors = roots.map((element) => ({
          element,
          value: element.style.getPropertyValue("scroll-behavior"),
          priority: element.style.getPropertyPriority("scroll-behavior"),
        }));
        for (const { element } of rootBehaviors) element.style.setProperty("scroll-behavior", "auto", "important");
        window.scrollTo({ left: snapshot.windowX, top: snapshot.windowY, behavior: "auto" });
        for (const { element, value, priority } of rootBehaviors) {
          if (value) element.style.setProperty("scroll-behavior", value, priority);
          else element.style.removeProperty("scroll-behavior");
        }
      }
      delete window.__newmeUatScrollSnapshot;
      for (const root of document.querySelectorAll('[data-newme-uat-safe-copy="true"]')) {
        root.removeAttribute("data-newme-uat-safe-copy");
      }
      for (const element of document.querySelectorAll('[style*="--newme-uat-original-color"]')) {
        element.style.removeProperty("--newme-uat-original-color");
      }
      for (const element of document.querySelectorAll('[data-newme-uat-runtime-mask="true"]')) {
        element.removeAttribute("data-newme-uat-runtime-mask");
      }
      for (const element of document.querySelectorAll('[data-newme-uat-runtime-sensitive-value="true"]')) {
        element.removeAttribute("data-newme-uat-runtime-sensitive-value");
      }
    });
  }
  const bytes = readFileSync(file);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail("invalid_screenshot_bytes");
  }
  return sha256(bytes);
}

function safeStepEvidence(step) {
  return {
    sequence: step.sequence,
    id: step.id,
    status: step.status,
    started_at: step.started_at,
    completed_at: step.completed_at,
    path: step.path,
    semantic_assertions: step.semantic_assertions,
  };
}

function semanticAssertion(id, value) {
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(id) || typeof value !== "string" || value.length < 1 || value.length > 128) {
    fail("semantic_assertion_invalid");
  }
  return { id, value };
}

/**
 * The sidebar the signed-in role must see, in order.
 *
 * This duplicates src/lib/nav.ts, and the duplication is forced: only this file
 * and canonical-browser-uat.mjs are mounted into the digest-pinned browser
 * image, so there is nothing to import at runtime, and nav.ts is TypeScript in
 * any case. What is NOT forced is the drift -- /cable-costing was added to both
 * arrays in nav.ts and this list did not follow, so every session refused on
 * navigation_visible. tests/release/postdeploy-browser-uat.test.mjs parses the
 * hrefs out of nav.ts and compares them to these arrays, in order, so the next
 * sidebar entry breaks CI rather than a production acceptance run.
 */
export const CANONICAL_NAV_BY_ROLE = Object.freeze({
  admin: Object.freeze([
    "/dashboard", "/leads", "/quotes", "/cable-costing", "/contracts",
    "/pipeline", "/analytics", "/ads", "/products", "/team", "/projects", "/settings",
  ]),
  boss: Object.freeze([
    "/dashboard", "/leads", "/quotes", "/cable-costing", "/contracts",
    "/pipeline", "/analytics", "/ads", "/products", "/team", "/projects", "/settings",
  ]),
  // No /team: src/app/actions/team.ts refuses operator, so the sidebar does not
  // offer the link. Keyed per role rather than "sales vs everyone else" because
  // that assumption is what let /team stay in operator's sidebar unnoticed.
  operator: Object.freeze([
    "/dashboard", "/leads", "/quotes", "/cable-costing", "/contracts",
    "/pipeline", "/analytics", "/ads", "/products", "/projects", "/settings",
  ]),
  sales: Object.freeze([
    "/workbench", "/leads", "/quotes", "/cable-costing", "/contracts",
    "/payments", "/pipeline", "/analytics", "/products",
  ]),
});

function canonicalNavigation(role) {
  const expected = CANONICAL_NAV_BY_ROLE[role];
  if (!expected) fail("navigation_contract_role_unknown");
  return [...expected];
}

/**
 * Wait for a control, and refuse with `code` only once waiting has failed.
 *
 * Several production pages render client side: /login answers 200 with nothing
 * but `Loading...` inside a bailout boundary, and its inputs appear tens of
 * milliseconds later. Counting matches before waiting therefore measured the
 * first paint rather than the page, and every acceptance run refused on the
 * first step. waitFor retries on its own, which is exactly what this needs.
 *
 * A non-timeout rejection is a different defect -- a closed page, a navigation
 * error -- so it propagates unlabelled rather than being reported as a missing
 * control.
 */
export async function visible(locator, code) {
  const first = locator.first();
  try {
    await first.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  } catch (error) {
    if (error?.name !== "TimeoutError") throw error;
    fail(code);
  }
  return first;
}

async function runSession({ browser, input, credential, locale, runnerSourceSha256 }) {
  const sessionRoot = path.join(input.artifact_directory, credential.role, locale);
  const screenshotsRoot = path.join(sessionRoot, "screenshots");
  const roleRoot = path.join(input.artifact_directory, credential.role);
  if (!existsSync(roleRoot)) mkdirSync(roleRoot, { mode: 0o700 });
  mkdirSync(sessionRoot, { mode: 0o700 });
  mkdirSync(screenshotsRoot, { mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(roleRoot, 0o700);
    chmodSync(sessionRoot, 0o700);
    chmodSync(screenshotsRoot, 0o700);
  }

  const context = await browser.newContext({
    baseURL: input.base_url,
    viewport: VIEWPORT,
    locale: locale === "zh" ? "zh-CN" : "en-US",
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    if (routeDecision(route.request().url()) === "continue") {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", async (webSocketRoute) => {
    let origin;
    try {
      const url = new URL(webSocketRoute.url());
      const protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : "";
      origin = protocol ? `${protocol}//${url.host}` : "";
    } catch {
      origin = "";
    }
    if (!ALLOWED_HTTP_ORIGINS.has(origin)) {
      await webSocketRoute.close({ code: 1008, reason: "blocked_origin" });
      return;
    }
    webSocketRoute.connectToServer();
  });
  await context.addInitScript((initialLocale) => localStorage.setItem("newme-lang", initialLocale), locale);
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(STEP_TIMEOUT_MS);

  const runtimeQuality = qualityCounts();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (isExpectedDeniedResourceConsole({
      type: message.type(),
      text: message.text(),
      url: message.location().url,
    })) return;
    runtimeQuality.console_error_count += 1;
  });
  page.on("pageerror", () => { runtimeQuality.page_error_count += 1; });
  page.on("response", (response) => {
    const request = response.request();
    const pathname = safePathname(response.url());
    const critical = request.resourceType() === "document"
      || pathname.startsWith("/api/auth/")
      || pathname.startsWith("/api/leads")
      || pathname.startsWith("/api/settings")
      || pathname.startsWith("/api/contracts");
    const expectedDeniedMe = pathname === "/api/auth/me" && [401, 403].includes(response.status());
    if (critical && response.status() >= 400 && !expectedDeniedMe) runtimeQuality.critical_http_failure_count += 1;
  });
  page.on("requestfailed", (request) => {
    const pathname = safePathname(request.url());
    if (shouldCountCriticalRequestFailure({
      resourceType: request.resourceType(),
      pathname,
      errorText: request.failure()?.errorText,
    })) {
      runtimeQuality.critical_http_failure_count += 1;
    }
  });

  const startedAt = utcSecond();
  const subject = {
    lead_id: input.fixture.lead_id,
    contract_id: input.fixture.contract_id,
    marker_sha256: sha256(input.fixture.marker),
  };
  const steps = [];
  const httpChecks = [];
  const recordStep = async (id, action) => {
    try {
    if (REQUIRED_STEPS[steps.length] !== id) fail("noncanonical_step_order");
    const stepStartedAt = utcSecond();
    const evidence = await action() ?? {};
    const semanticAssertions = evidence.semanticAssertions ?? [];
    if (
      !Array.isArray(semanticAssertions)
      || new Set(semanticAssertions.map((entry) => entry.id)).size !== semanticAssertions.length
      || semanticAssertions.some((entry) => Object.keys(entry).sort().join(",") !== "id,value")
    ) fail("semantic_assertion_invalid");
    const layoutQuality = await auditVisibleUi(page);
    runtimeQuality.overflow_violation_count += layoutQuality.overflow_violation_count;
    runtimeQuality.overlap_violation_count += layoutQuality.overlap_violation_count;
    runtimeQuality.raw_i18n_key_count += layoutQuality.raw_i18n_key_count;
    assertZeroQuality(runtimeQuality, { role: credential.role, locale, step: id });
    const stepCompletedAt = utcSecond();
    const provisional = {
      sequence: steps.length + 1,
      id,
      status: "pass",
      started_at: stepStartedAt,
      completed_at: stepCompletedAt,
      path: safePathname(page.url()),
      semantic_assertions: semanticAssertions,
    };
    const evidenceSha256 = sha256(canonicalJsonBytes(safeStepEvidence(provisional)));
    let screenshot = null;
    if (REQUIRED_SCREENSHOT_STEPS.includes(id)) {
      const screenshotFile = path.join(screenshotsRoot, `${String(provisional.sequence).padStart(2, "0")}-${id}.png`);
      try {
        const screenshotSha256 = await captureRedactedScreenshot(page, screenshotFile, evidence.safeLocators);
        screenshot = {
          path: relativeEvidencePath(input.artifact_directory, screenshotFile),
          sha256: screenshotSha256,
          media_type: SCREENSHOT_MEDIA_TYPE,
          redaction_version: REDACTION_VERSION,
        };
      } finally {
        await evidence.afterScreenshot?.();
      }
    } else {
      await evidence.afterScreenshot?.();
    }
    steps.push({ ...provisional, evidence_sha256: evidenceSha256, screenshot });
    } catch (error) {
      fail(runtimeFailureCode(error, { role: credential.role, locale, step: id }));
    }
  };
  const copy = UI_COPY[locale];
  const alternateLocale = locale === "en" ? "zh" : "en";
  const alternateCopy = UI_COPY[alternateLocale];
  const leadsHeading = () => page.getByRole("heading", { name: copy.leads, exact: true });
  const fixtureCard = () => page.locator(`div[draggable="true"][data-lead-id="${input.fixture.lead_id}"]`);
  const openFixtureCollection = async () => {
    if (safePathname(page.url()) !== "/leads") {
      await page.goto("/leads", { waitUntil: "domcontentloaded" });
      await page.waitForURL((url) => url.pathname === "/leads", { timeout: STEP_TIMEOUT_MS });
    }
    const heading = await visible(leadsHeading(), "leads_heading_copy_missing");
    const search = await visible(page.locator('[data-sticky-region="filter-bar"] input').first(), "lead_search_missing");
    await search.fill(input.fixture.marker);
    const card = await visible(fixtureCard(), "fixture_lead_card_missing");
    if (await fixtureCard().count() !== 1 || !(await card.innerText()).includes(input.fixture.marker)) {
      fail("fixture_lead_card_ambiguous");
    }
    return { heading, card };
  };

  try {
    await recordStep("login_page_visible", async () => {
      const response = await page.goto("/login", { waitUntil: "domcontentloaded" });
      if (!response || response.status() !== 200) fail("login_page_unavailable");
      await visible(page.locator("#email"), "email_control_missing");
      await visible(page.locator("#password"), "password_control_missing");
      const signIn = await visible(page.getByRole("button", { name: copy.signIn, exact: true }), "login_control_missing");
      return {
        safeLocators: [page.locator("form"), signIn],
        semanticAssertions: [semanticAssertion("login_copy", copy.signIn)],
      };
    });

    await recordStep("login_submitted", async () => {
      await page.locator("#email").fill(credential.email);
      await page.locator("#password").fill(credential.password);
      const [loginResponse] = await Promise.all([
        page.waitForResponse((response) => safePathname(response.url()) === "/api/auth/login" && response.request().method() === "POST"),
        page.getByRole("button", { name: copy.signIn, exact: true }).click(),
      ]);
      const check = await hashedResponse(loginResponse);
      if (check.http_status !== 200) fail("login_failed");
      httpChecks.push({ id: "login", method: "POST", path: "/api/auth/login", ...check });
      await page.waitForURL((url) => url.pathname !== "/login", { timeout: STEP_TIMEOUT_MS });
    });

    await recordStep("landing_visible", async () => {
      await visible(page.locator("aside"), "sidebar_missing");
      const identityResponse = await context.request.get(`${input.base_url}/api/auth/me`, { failOnStatusCode: false });
      const identityBytes = await identityResponse.body();
      const check = {
        id: "identity",
        method: "GET",
        path: "/api/auth/me",
        http_status: identityResponse.status(),
        response_sha256: responseDigest(identityBytes),
        completed_at: utcSecond(),
      };
      if (check.http_status !== 200) fail("identity_read_failed");
      let identity;
      try { identity = JSON.parse(identityBytes.toString("utf8")); } catch { fail("identity_response_invalid"); }
      if (identity.userId !== credential.actor_id || identity.role !== credential.role || identity.isActive !== true) {
        fail("identity_binding_failed");
      }
      httpChecks.push(check);
      return { semanticAssertions: [semanticAssertion("authenticated_role", credential.role)] };
    });

    await recordStep("navigation_visible", async () => {
      const expected = canonicalNavigation(credential.role);
      for (const href of expected) await visible(page.locator(`aside a[href="${href}"]`), "navigation_control_missing");
      const visibleHrefs = await page.locator("aside nav a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
      if (JSON.stringify(visibleHrefs) !== JSON.stringify(expected)) fail("navigation_contract_mismatch");
      const expectedLeadsNav = credential.role === "sales" ? copy.salesLeadsNav : copy.managementLeadsNav;
      const expectedContractsNav = credential.role === "sales" ? copy.salesContractsNav : copy.managementContractsNav;
      await visible(page.locator('aside a[href="/leads"]', { hasText: expectedLeadsNav }), "navigation_copy_mismatch");
      await visible(page.locator('aside a[href="/contracts"]', { hasText: expectedContractsNav }), "navigation_copy_mismatch");
      return {
        semanticAssertions: [
          semanticAssertion("leads_navigation_copy", expectedLeadsNav),
          semanticAssertion("contracts_navigation_copy", expectedContractsNav),
        ],
      };
    });

    await recordStep("collection_card_visible", async () => {
      const { heading, card } = await openFixtureCollection();
      const marker = await visible(card.getByText(input.fixture.marker, { exact: true }), "fixture_marker_copy_missing");
      return {
        // The Kanban lane can be horizontally distant from the page heading.
        // Screenshot evidence must be a bounded, simultaneously visible proof
        // surface; heading copy is already covered by the signed semantic
        // assertion below.
        safeLocators: [marker],
        semanticAssertions: [
          semanticAssertion("leads_heading_copy", copy.leads),
          semanticAssertion("fixture_lead_id", input.fixture.lead_id),
          semanticAssertion("fixture_marker_sha256", sha256(input.fixture.marker)),
        ],
      };
    });

    await recordStep("bulk_action_verified", async () => {
      const { heading, card } = await openFixtureCollection();
      const marker = await visible(card.getByText(input.fixture.marker, { exact: true }), "fixture_marker_copy_missing");
      const checkbox = card.locator('input[type="checkbox"]');
      if (credential.role === "admin" || credential.role === "boss") {
        if (await checkbox.count() !== 1) fail("bulk_control_missing");
        await checkbox.click();
        const bulk = await visible(page.locator('[data-sticky-region="bulk-transfer-bar"]'), "bulk_control_missing");
        const transfer = await visible(bulk.getByRole("button", { name: copy.transferAction, exact: true }), "bulk_copy_mismatch");
        await transfer.click();
        await visible(bulk.locator("select"), "bulk_dialog_missing");
        const cancel = await visible(bulk.getByRole("button", { name: copy.cancel, exact: true }), "bulk_copy_mismatch");
        const clear = await visible(bulk.getByRole("button", { name: copy.clear, exact: true }), "bulk_copy_mismatch");
        return {
          safeLocators: [cancel, clear],
          semanticAssertions: [
            semanticAssertion("bulk_access", "allowed"),
            semanticAssertion("bulk_fixture_lead_id", input.fixture.lead_id),
            semanticAssertion("bulk_transfer_copy", copy.transferAction),
            semanticAssertion("bulk_cancel_copy", copy.cancel),
          ],
          afterScreenshot: async () => {
            await cancel.click();
            await clear.click();
          },
        };
      }
      if (await checkbox.count() !== 0 || await page.locator('[data-sticky-region="bulk-transfer-bar"]').count() !== 0) {
        fail("bulk_control_exposed");
      }
      const create = await visible(page.getByRole("button", { name: copy.create, exact: true }), "allowed_control_copy_mismatch");
      await create.click();
      const dialog = await visible(page.locator('[role="dialog"]'), "allowed_dialog_missing");
      const dialogTitle = await visible(dialog.getByText(copy.quickCreate, { exact: true }), "allowed_dialog_copy_mismatch");
      const cancel = await visible(dialog.getByRole("button", { name: copy.cancel, exact: true }), "allowed_dialog_copy_mismatch");
      return {
        safeLocators: [dialogTitle],
        semanticAssertions: [
          semanticAssertion("bulk_access", "denied"),
          semanticAssertion("bulk_fixture_lead_id", input.fixture.lead_id),
          semanticAssertion("permitted_create_copy", copy.create),
          semanticAssertion("create_dialog_copy", copy.quickCreate),
        ],
        afterScreenshot: async () => {
          await cancel.click();
          await dialog.waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS });
        },
      };
    });

    await recordStep("detail_visible", async () => {
      const { card } = await openFixtureCollection();
      await card.click();
      await page.waitForURL((url) => url.pathname === `/leads/${input.fixture.lead_id}`, { timeout: STEP_TIMEOUT_MS });
      const heading = await visible(page.getByRole("heading", { name: input.fixture.marker, exact: true }), "fixture_detail_heading_missing");
      return {
        safeLocators: [heading],
        semanticAssertions: [
          semanticAssertion("fixture_detail_id", input.fixture.lead_id),
          semanticAssertion("fixture_detail_copy_sha256", sha256(input.fixture.marker)),
        ],
      };
    });

    await recordStep("contract_list_visible", async () => {
      await page.goto("/contracts", { waitUntil: "domcontentloaded" });
      await page.waitForURL((url) => url.pathname === "/contracts", { timeout: STEP_TIMEOUT_MS });
      const heading = await visible(page.getByRole("heading", { name: copy.contracts, exact: true }), "contracts_heading_copy_missing");
      const link = await visible(page.locator(`a[href="/contracts/${input.fixture.contract_id}"]`, { hasText: input.fixture.contract_no }), "fixture_contract_link_missing");
      if (await page.locator(`a[href="/contracts/${input.fixture.contract_id}"]`).count() !== 1) fail("fixture_contract_link_ambiguous");
      const contractCard = await visible(link.locator('xpath=ancestor::*[@data-slot="card"][1]'), "fixture_contract_card_missing");
      const marker = await visible(contractCard.getByText(input.fixture.marker, { exact: true }), "fixture_contract_marker_missing");
      return {
        safeLocators: [link, marker],
        semanticAssertions: [
          semanticAssertion("contracts_heading_copy", copy.contracts),
          semanticAssertion("fixture_contract_id", input.fixture.contract_id),
          semanticAssertion("fixture_contract_number", input.fixture.contract_no),
        ],
      };
    });

    await recordStep("settings_contract_verified", async () => {
      if (credential.role === "sales") {
        if (await page.locator('aside a[href="/settings"]').count() !== 0) fail("sales_settings_exposed");
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await page.waitForURL((url) => url.pathname !== "/settings", { timeout: STEP_TIMEOUT_MS });
        if (!new Set(["/dashboard", "/workbench"]).has(safePathname(page.url()))) fail("sales_settings_denial_failed");
        const { heading, card } = await openFixtureCollection();
        const marker = await visible(card.getByText(input.fixture.marker, { exact: true }), "fixture_marker_copy_missing");
        return {
          safeLocators: [marker],
          semanticAssertions: [semanticAssertion("settings_access", "denied")],
        };
      } else {
        await page.locator('aside a[href="/settings"]').click();
        await page.waitForURL((url) => url.pathname === "/settings", { timeout: STEP_TIMEOUT_MS });
        const heading = await visible(page.getByRole("heading", { name: copy.settings, exact: true }), "settings_heading_copy_missing");
        const all = await visible(page.getByRole("button", { name: copy.settingsAll, exact: true }), "settings_all_filter_copy_missing");
        await all.click();
        const search = await visible(page.getByPlaceholder(copy.settingsSearch, { exact: true }), "settings_search_copy_missing");
        await search.fill(input.fixture.marker);
        const fixtureRow = page.locator(`tbody tr[data-lead-id="${input.fixture.lead_id}"]`, { hasText: input.fixture.marker });
        const row = await visible(fixtureRow, "settings_fixture_row_missing");
        if (await fixtureRow.count() !== 1) fail("settings_fixture_row_ambiguous");
        const marker = await visible(row.getByText(input.fixture.marker, { exact: true }), "settings_fixture_marker_missing");
        return {
          safeLocators: [marker],
          semanticAssertions: [
            semanticAssertion("settings_access", "allowed"),
            semanticAssertion("settings_heading_copy", copy.settings),
            semanticAssertion("settings_assignment_filter", "all"),
            semanticAssertion("settings_fixture_lead_id", input.fixture.lead_id),
          ],
        };
      }
    });

    await recordStep("locale_switched", async () => {
      await openFixtureCollection();
      const switchLabel = locale === "en" ? "中文" : "EN";
      await page.getByRole("button", { name: switchLabel, exact: true }).click();
      await page.waitForFunction((expected) => localStorage.getItem("newme-lang") === expected, alternateLocale);
      await visible(page.getByRole("button", { name: locale === "en" ? "EN" : "中文", exact: true }), "locale_switch_failed");
      return { semanticAssertions: [semanticAssertion("locale_target", alternateLocale)] };
    });

    await recordStep("locale_content_verified", async () => {
      const heading = await visible(page.getByRole("heading", { name: alternateCopy.leads, exact: true }), "locale_heading_copy_mismatch");
      const card = await visible(fixtureCard(), "fixture_lead_card_missing");
      const marker = await visible(card.getByText(input.fixture.marker, { exact: true }), "fixture_marker_copy_missing");
      const create = await visible(page.getByRole("button", { name: alternateCopy.create, exact: true }), "locale_action_copy_mismatch");
      const expectedLang = await page.locator("html").getAttribute("lang");
      if (expectedLang !== alternateLocale) fail("html_locale_mismatch");
      return {
        // Keep locale-specific visual evidence in this step. The signed
        // assertion binds the same record marker, while the bounded Create
        // control proves the copy actually switched in the captured viewport.
        safeLocators: [create],
        semanticAssertions: [
          semanticAssertion("alternate_leads_heading_copy", alternateCopy.leads),
          semanticAssertion("alternate_create_copy", alternateCopy.create),
          semanticAssertion("alternate_html_locale", alternateLocale),
          semanticAssertion("alternate_fixture_marker_sha256", sha256(input.fixture.marker)),
        ],
      };
    });

    await recordStep("locale_restored", async () => {
      const restoreLabel = locale === "en" ? "EN" : "中文";
      await page.getByRole("button", { name: restoreLabel, exact: true }).click();
      await page.waitForFunction((expected) => localStorage.getItem("newme-lang") === expected, locale);
      await visible(page.getByRole("button", { name: locale === "en" ? "中文" : "EN", exact: true }), "locale_restore_failed");
      await visible(page.getByRole("heading", { name: copy.leads, exact: true }), "locale_restore_copy_mismatch");
      if (await page.locator("html").getAttribute("lang") !== locale) fail("html_locale_restore_failed");
      return { semanticAssertions: [semanticAssertion("locale_restored", locale)] };
    });

    await recordStep("logout", async () => {
      const [logoutResponse] = await Promise.all([
        page.waitForResponse((response) => safePathname(response.url()) === "/api/auth/logout" && response.request().method() === "POST"),
        page.locator("aside").getByRole("button", { name: copy.logout, exact: true }).click(),
      ]);
      const check = await hashedResponse(logoutResponse);
      if (check.http_status !== 200) fail("logout_failed");
      httpChecks.push({ id: "logout", method: "POST", path: "/api/auth/logout", ...check });
      await page.waitForURL((url) => url.pathname === "/login", { timeout: STEP_TIMEOUT_MS });
      return { semanticAssertions: [semanticAssertion("logout_copy", copy.logout)] };
    });

    await recordStep("post_logout_denied", async () => {
      const denied = await context.request.get(`${input.base_url}/api/auth/me`, { failOnStatusCode: false });
      const check = await hashedResponse(denied);
      if (![401, 403].includes(check.http_status)) fail("post_logout_session_alive");
      httpChecks.push({ id: "post_logout_denied", method: "GET", path: "/api/auth/me", ...check });
      await page.goto("/leads", { waitUntil: "domcontentloaded" });
      await page.waitForURL((url) => url.pathname === "/login", { timeout: STEP_TIMEOUT_MS });
    });

    if (steps.length !== REQUIRED_STEPS.length || httpChecks.map((check) => check.id).join(",") !== REQUIRED_HTTP_CHECKS.join(",")) {
      fail("browser_evidence_incomplete");
    }
    assertZeroQuality(runtimeQuality, { role: credential.role, locale, step: "final" });
    const completedAt = steps.at(-1).completed_at;
    const trace = {
      trace_version: TRACE_VERSION,
      release: { ...input.release },
      runner: BROWSER_RUNNER,
      runner_source_sha256: runnerSourceSha256,
      role: credential.role,
      actor_id: credential.actor_id,
      locale,
      subject,
      viewport: { ...VIEWPORT },
      ordered_steps: steps,
      http_checks: httpChecks,
      quality: runtimeQuality,
    };
    const traceBytes = Buffer.from(`${JSON.stringify(trace, null, 2)}\n`, "utf8");
    const traceFile = path.join(sessionRoot, "redacted-trace.json");
    writeClosedFile(traceFile, traceBytes);
    const traceMetadata = {
      trace_version: TRACE_VERSION,
      path: relativeEvidencePath(input.artifact_directory, traceFile),
      sha256: sha256(traceBytes),
      media_type: TRACE_MEDIA_TYPE,
    };
    const payload = {
      runner: BROWSER_RUNNER,
      runner_run_id: `browser:${credential.role}:${locale}:${randomUUID()}`,
      runner_source_path: BROWSER_RUNNER_SOURCE_PATH,
      runner_source_sha256: runnerSourceSha256,
      playwright_image: PLAYWRIGHT_IMAGE,
      browser_name: BROWSER_NAME,
      browser_version: browser.version(),
      role: credential.role,
      actor_id: credential.actor_id,
      locale,
      subject,
      viewport: { ...VIEWPORT },
      status: "pass",
      started_at: startedAt,
      completed_at: completedAt,
      ordered_steps: steps,
      http_checks: httpChecks,
      quality: runtimeQuality,
      redaction: {
        redaction_version: REDACTION_VERSION,
        non_subject_dynamic_text_hidden: true,
        evidence_copy_visible: true,
        input_values_hidden: true,
        screenshot_images_hidden: true,
        trace_closed_fields_only: true,
        storage_state_written: false,
      },
      trace: traceMetadata,
    };
    if (payload.browser_version !== BROWSER_VERSION) fail("browser_version_mismatch");
    const unsignedArtifact = {
      artifact_version: ARTIFACT_VERSION,
      kind: "browser_uat",
      release: {
        git_sha: input.release.git_sha,
        build_id: input.release.build_id,
        deploy_run_id: input.release.deploy_run_id,
      },
      observed_at: completedAt,
      payload,
    };
    const document = signPostdeployArtifact({
      artifact: unsignedArtifact,
      producer: BROWSER_RUNNER,
      signedAt: completedAt,
      privateKeyBytes: input.receipt_private_key_pem,
    });
    const artifactBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    const artifactFile = path.join(sessionRoot, "artifact.json");
    writeClosedFile(artifactFile, artifactBytes);
    const artifactId = `browser_${credential.role}_${locale}`;
    return {
      summary: {
        role: credential.role,
        actor_id: credential.actor_id,
        locale,
        subject: { ...subject },
        status: "pass",
        completed_at: completedAt,
        artifact_id: artifactId,
      },
      artifact: {
        id: artifactId,
        kind: "browser_uat",
        path: relativeEvidencePath(input.artifact_directory, artifactFile),
        sha256: sha256(artifactBytes),
        media_type: "application/json",
      },
    };
  } finally {
    try {
      await context.close();
    } catch (error) {
      fail(runtimeFailureCode(error, { role: credential.role, locale, step: "context_close" }));
    }
  }
}

export function browserRunnerSourceSha256() {
  return sha256(readFileSync(fileURLToPath(import.meta.url)));
}

export function buildSafeFailureOutput(code) {
  return {
    output_version: OUTPUT_VERSION,
    status: "fail",
    failure_code: typeof code === "string" && /^[a-z0-9_]{3,80}$/.test(code) ? code : "browser_uat_failed",
  };
}

export function buildSafeSuccessOutput({ release, artifactDirectory, runnerSourceSha256, sessions, artifacts }) {
  return {
    output_version: OUTPUT_VERSION,
    status: "pass",
    release: { ...release },
    artifact_directory: artifactDirectory,
    runner_source: { path: BROWSER_RUNNER_SOURCE_PATH, sha256: runnerSourceSha256 },
    playwright_image: PLAYWRIGHT_IMAGE,
    browser_name: BROWSER_NAME,
    browser_version: BROWSER_VERSION,
    viewport: { ...VIEWPORT },
    sessions: structuredClone(sessions),
    artifacts: structuredClone(artifacts),
    completed_at: sessions.at(-1).completed_at,
  };
}

export async function runBrowserUat(input, { browserType = chromium } = {}) {
  const validated = validateBrowserUatInput(input);
  createArtifactDirectory(validated.artifact_directory);
  const sourceSha256 = browserRunnerSourceSha256();
  let browser;
  try {
    browser = await browserType.launch({ headless: true });
  } catch (error) {
    fail(runtimeFailureCode(error, { role: "all", locale: "all", step: "browser_launch" }));
  }
  try {
    if (browser.version() !== BROWSER_VERSION) fail("browser_version_mismatch");
    const sessions = [];
    const artifacts = [];
    for (const credential of validated.roles) {
      for (const locale of REQUIRED_LOCALES) {
        let result;
        try {
          result = await runSession({ browser, input: validated, credential, locale, runnerSourceSha256: sourceSha256 });
        } catch (error) {
          fail(runtimeFailureCode(error, { role: credential.role, locale, step: "session" }));
        }
        sessions.push(result.summary);
        artifacts.push(result.artifact);
      }
    }
    return buildSafeSuccessOutput({
      release: validated.release,
      artifactDirectory: validated.artifact_directory,
      runnerSourceSha256: sourceSha256,
      sessions,
      artifacts,
    });
  } finally {
    try {
      await browser.close();
    } catch (error) {
      fail(runtimeFailureCode(error, { role: "all", locale: "all", step: "browser_close" }));
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) {
    process.stdout.write(`${JSON.stringify(buildSafeFailureOutput("arguments_forbidden"))}\n`);
    return 64;
  }
  try {
    const input = await readClosedStdin();
    const output = await runBrowserUat(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(buildSafeFailureOutput(error?.code))}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
