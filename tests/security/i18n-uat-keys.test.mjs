import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const translationSource = readFileSync(join(root, "src/lib/i18n/translations.ts"), "utf8");
const objectSource = translationSource
  .replace(/^export const translations = /, "")
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

function lookup(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

test("Lead Detail literal i18n keys exist in English and Chinese", () => {
  const keys = new Set();
  for (const file of leadDetailFiles) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(/\bt\(\s*["']([^"']+)["']\s*\)/g)) {
      keys.add(match[1]);
    }
  }

  const missing = [];
  for (const lang of ["en", "zh"]) {
    for (const key of keys) {
      if (typeof lookup(translations[lang], key) !== "string") missing.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missing, []);
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

test("Tanya lead sources have explicit bilingual labels", () => {
  for (const lang of ["en", "zh"]) {
    assert.equal(translations[lang].sourceLabels.ins, "Instagram");
    assert.equal(translations[lang].sourceLabels.fb, "Facebook");
    assert.equal(typeof translations[lang].sourceLabels.show_room, "string");
  }
});
