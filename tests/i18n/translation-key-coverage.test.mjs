/**
 * Every translation key a page asks for must exist in BOTH languages.
 *
 * t() falls back to the key path, never to the English word -- see
 * src/lib/i18n/LanguageContext.tsx, `return path`. So a missing key is not a
 * silent degradation, it is visible garbage in the UI: measured 2026-08-20, the
 * sales workbench titled itself "workbench.title" over a card reading
 * "workbench.empty.inbox", and the quotation detail page printed
 * "quotations.subtotal" next to the money. 55 keys across 7 files.
 *
 * The debt survived review because almost every call site is written
 * `t("workbench.title") || "Sales Workbench"`, which reads like a safe fallback
 * and is dead code -- t() returned the truthy string "workbench.title", so the
 * `||` branch could never be taken and the author's intended English was
 * unreachable. That intended English is what the dictionary now holds.
 *
 * Three independent assertions, because the keys reach t() three different ways:
 *
 *   1. literal keys        t("quotations.subtotal")     -- scanned here
 *   2. runtime-built keys  t(`nav.${item.labelKey}`)    -- nav is enumerated here
 *   3. everything else     t(`stageLabels.${stage}`)    -- covered by en/zh parity
 *
 * Parity is the load-bearing one. A literal scan cannot see case 2 at all, which
 * is exactly how zh lost `nav.salesWorkbench`: every Chinese-reading salesperson
 * saw the top item of their own sidebar rendered as "nav.salesWorkbench", and no
 * scanner would ever have said so. Requiring the two dictionaries to hold the
 * same key set catches that whole class without enumerating call sites.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE = readFileSync(path.join(ROOT, "src/lib/i18n/translations.ts"), "utf8");

/**
 * A literal `t("a.b")` call, capturing what follows so concatenation is visible.
 *
 * Requires at least one dot: single-segment strings are never dictionary paths,
 * and matching them would drag in the unrelated two-argument helpers that some
 * components define locally (WeeklyReview.tsx line 226,
 * `const t = (zh, en) => ...`, called as t("新增", "New")).
 */
const LITERAL_CALL = /\bt\(\s*"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)"(\s*\+)?/g;

/** The dictionary, imported by rewriting TS-only syntax out of the module. */
async function loadTranslations() {
  const scratch = mkdtempSync(path.join(tmpdir(), "i18n-coverage-"));
  const file = path.join(scratch, "translations.mjs");
  writeFileSync(
    file,
    SOURCE.replace(/\} as const;/, "};").replace(/^export type .*$/gm, ""),
  );
  const module_ = await import(file);
  return module_.translations;
}

function sourceFiles() {
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
  })(path.join(ROOT, "src"));
  return files;
}

/** Every literal key, split into the ones we can check and the ones we cannot. */
function scanLiteralKeys() {
  const checkable = new Map(); // key -> first relative call site
  const concatenated = new Map();
  for (const file of sourceFiles()) {
    const relative = path.relative(ROOT, file);
    for (const [, key, plus] of readFileSync(file, "utf8").matchAll(LITERAL_CALL)) {
      // `t("settings.filter" + f.key.charAt(0).toUpperCase() + ...)` builds the
      // real key at runtime, so the literal prefix is not a key and demanding it
      // exist would be a false positive. settings/page.tsx line 452 does this and
      // its three real keys (filterUnassigned/filterAssigned/filterAll) are all
      // present.
      const target = plus ? concatenated : checkable;
      if (!target.has(key)) target.set(key, relative);
    }
  }
  return { checkable, concatenated };
}

function flatten(node, prefix = "") {
  return Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === "object"
      ? flatten(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

function resolve(dictionary, keyPath) {
  let value = dictionary;
  for (const key of keyPath.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = value[key];
  }
  return typeof value === "string" ? value : undefined;
}

test("every literal t() key resolves in both languages", async () => {
  const translations = await loadTranslations();
  const { checkable, concatenated } = scanLiteralKeys();

  // Parser negative controls. A regex that quietly stops matching would make
  // this test pass on an empty set forever, so pin the scale of what it found:
  // measured 2026-08-20 at 1030 distinct keys over 57 files.
  assert.ok(
    checkable.size > 700,
    `literal key scan found only ${checkable.size} keys -- the call pattern changed`,
  );
  assert.ok(
    new Set([...checkable.values()]).size > 40,
    "literal key scan is reaching too few files",
  );
  // And the concatenation skip must be exercised, not merely written: if this
  // ever finds nothing, the skip has become dead code and can be deleted.
  assert.ok(
    concatenated.size >= 1,
    "no concatenated t() call found -- delete the skip instead of trusting it",
  );
  // The skip is also load-bearing rather than cosmetic: its prefixes really do
  // fail to resolve, so counting them as keys would fail this test.
  assert.equal(resolve(translations.en, "settings.filter"), undefined);

  const missing = [...checkable]
    .map(([key, site]) => ({
      key,
      site,
      gaps: ["en", "zh"].filter((lang) => resolve(translations[lang], key) === undefined),
    }))
    .filter((entry) => entry.gaps.length > 0)
    .map((entry) => `${entry.key} [${entry.gaps.join(",")}] ${entry.site}`);

  assert.deepEqual(
    missing,
    [],
    `${missing.length} translation key(s) would render as their own key path`,
  );
});

test("every sidebar label resolves in both languages", async () => {
  const translations = await loadTranslations();
  const nav = readFileSync(path.join(ROOT, "src/lib/nav.ts"), "utf8");
  const sidebar = readFileSync(
    path.join(ROOT, "src/components/dashboard/DashboardSidebar.tsx"),
    "utf8",
  );

  // This test only means something while the sidebar keeps building the key from
  // labelKey; if that changes, the enumeration below is checking nothing.
  assert.match(sidebar, /t\(`nav\.\$\{item\.labelKey\}`\)/);

  const labelKeys = [...nav.matchAll(/labelKey:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(labelKeys.length >= 20, `found only ${labelKeys.length} labelKeys in nav.ts`);

  const missing = labelKeys
    .map((labelKey) => ({
      labelKey,
      gaps: ["en", "zh"].filter(
        (lang) => resolve(translations[lang], `nav.${labelKey}`) === undefined,
      ),
    }))
    .filter((entry) => entry.gaps.length > 0)
    .map((entry) => `nav.${entry.labelKey} [${entry.gaps.join(",")}]`);

  assert.deepEqual(missing, [], "a sidebar link would render as its own key path");
});

test("en and zh hold the same key set", async () => {
  const translations = await loadTranslations();
  const en = new Set(flatten(translations.en));
  const zh = new Set(flatten(translations.zh));

  assert.ok(en.size > 1500, `en dictionary has only ${en.size} keys`);
  assert.deepEqual([...en].filter((key) => !zh.has(key)), [], "keys missing from zh");
  assert.deepEqual([...zh].filter((key) => !en.has(key)), [], "keys missing from en");
});
