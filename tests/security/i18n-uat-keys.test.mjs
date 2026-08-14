import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const translationSource = readFileSync(join(root, "src/lib/i18n/translations.ts"), "utf8");
const objectSource = translationSource
  .replace(/^[\s\S]*?export const translations = /, "")
  .replace(/\n\} as const;[\s\S]*$/, "\n}");
const translations = Function(`"use strict"; return (${objectSource});`)();

const leadDetailFiles = [
  "src/app/(dashboard)/leads/[id]/LeadContactQualityPanel.tsx",
  "src/app/(dashboard)/leads/[id]/LeadContractsPanel.tsx",
  "src/app/(dashboard)/leads/[id]/LeadCustomerProfile.tsx",
  "src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx",
  "src/app/(dashboard)/leads/[id]/LeadTimeline.tsx",
  "src/app/(dashboard)/leads/[id]/page.tsx",
];

/**
 * The pages that render money, and are held to the same key-existence rule.
 *
 * Round-4 finding R5. The payment badges on these three surfaces reported two states
 * for a three-state ledger, and the copy was part of the defect rather than a wrapper
 * around it: `pendingConfirm` was shown for a REVERSED payment, so the operator was
 * told money was still on its way. Fixing that added `leadDetail.paymentNotConfirmed`,
 * and a new key is exactly the thing that ships in one language.
 */
const moneyUiFiles = [
  "src/app/(dashboard)/contracts/page.tsx",
  "src/app/(dashboard)/contracts/[id]/page.tsx",
  "src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx",
];

function lookup(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

/** Every `t("literal")` key in a file. */
function literalKeys(file) {
  const source = readFileSync(join(root, file), "utf8");
  return [...source.matchAll(/\bt\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
}

/**
 * Assert every key resolves to a non-empty string in both languages.
 *
 * Non-empty, not merely "a string": `""` is falsy, and the `t("k") || "Literal"`
 * pattern below depends for its deadness on `t()` never returning something falsy.
 */
function assertKeysResolve(files, label) {
  const keys = new Set(files.flatMap(literalKeys));
  assert.ok(keys.size > 0, `${label}: no t("literal") calls found — the extraction regex has stopped matching`);

  const missing = [];
  for (const lang of ["en", "zh"]) {
    for (const key of keys) {
      const value = lookup(translations[lang], key);
      if (typeof value !== "string" || value.length === 0) missing.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missing, [], `${label}: keys absent or empty`);
  return keys;
}

test("Lead Detail literal i18n keys exist in English and Chinese", () => {
  assertKeysResolve(leadDetailFiles, "lead detail");
});

test("the money UI's literal i18n keys exist in English and Chinese", () => {
  const keys = assertKeysResolve(moneyUiFiles, "money UI");
  // The key R5 added, named here so its absence is a failure with a reason rather
  // than a count that quietly drops by one.
  assert.ok(keys.has("leadDetail.paymentNotConfirmed"), "the trace badge no longer renders the not-confirmed state");
  assert.equal(translations.en.leadDetail.paymentNotConfirmed, "Not confirmed");
  assert.equal(translations.zh.leadDetail.paymentNotConfirmed, "未确认");
  // Deliberately distinct from pendingConfirm: `confirmed = false` in v_lead_trace
  // covers a payment awaiting confirmation AND one that has been reversed, and
  // calling both "pending" is what told an operator that reversed money was coming.
  assert.notEqual(translations.en.leadDetail.paymentNotConfirmed, translations.en.leadDetail.pendingConfirm);
  assert.notEqual(translations.zh.leadDetail.paymentNotConfirmed, translations.zh.leadDetail.pendingConfirm);
});

test("a t() fallback is dead code, so the money UI does not pretend to have one", () => {
  // Why it is dead: on a miss, t() returns the key path itself — never "" and never
  // undefined — so `t("k") || "Literal"` cannot reach its right-hand side. The literal
  // is not a safety net; it is a claim that a missing key degrades to English, when
  // what actually renders is the dotted path `leadDetail.someKey`.
  const context = readFileSync(join(root, "src/lib/i18n/LanguageContext.tsx"), "utf8");
  assert.match(context, /return path; \/\/ fallback to key path/);
  assert.match(context, /return typeof value === "string" \? value : path;/);

  const dead = (file) =>
    [...readFileSync(join(root, file), "utf8").matchAll(/\bt\(\s*["'][^"']+["']\s*\)\s*\|\|/g)].length;

  for (const file of ["src/app/(dashboard)/contracts/page.tsx", "src/app/(dashboard)/contracts/[id]/page.tsx"]) {
    assert.equal(dead(file), 0, `${file} carries a t() fallback that can never render`);
  }

  // A ratchet, not a clean bill of health. LeadSalesProcess.tsx still carries known
  // dead fallbacks in its contact-record form — outside this finding's scope, and left
  // alone rather than swept into a money change. The test above proves every key they
  // guard resolves in both languages, so all of them are provably unreachable; this
  // bound stops a twenty-third from being added while they are removed.
  const known = dead("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.ok(known <= 22, `LeadSalesProcess.tsx now has ${known} dead t() fallbacks, up from the known 22`);
});

test("the payments collection route no longer answers a read", () => {
  // R5's other half. /api/payments used to export a GET that returned a different
  // payment shape from /api/payments/list — a second read model of the same rows, with
  // its own predicate. There is one reader now, and this route only writes.
  const source = readFileSync(join(root, "src/app/api/payments/route.ts"), "utf8");
  const methods = [...source.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]+)\b/g)].map((m) => m[1]);
  assert.deepEqual(methods, ["POST"], "src/app/api/payments/route.ts exports a method other than POST");
});

test("First Contact copy states one required contact and three recommended contacts", () => {
  assert.equal(
    translations.en.leadDetail.firstContactGateHint,
    "At least 1 complete contact and quality are required; 3 contacts are recommended",
  );
  assert.equal(
    translations.zh.leadDetail.firstContactGateHint,
    "至少需要1条完整联系记录并评估质量；建议填写3次联系记录",
  );
});

test("Tanya lead sources use one canonical label everywhere", () => {
  for (const lang of ["en", "zh"]) {
    assert.equal(translations[lang].sourceLabels.ins, "ins");
    assert.equal(translations[lang].sourceLabels.fb, "FB");
    assert.equal(translations[lang].sourceLabels.show_room, "Show room");
  }
});

test("Lead Detail header translates the stored source value", () => {
  const page = readFileSync(join(root, "src/app/(dashboard)/leads/[id]/page.tsx"), "utf8");
  assert.match(page, /lead\.source\s*\?\s*t\(`sourceLabels\.\$\{lead\.source\}`\)/);
});
