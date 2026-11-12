// S16: types the database now accepts and the server writes must not reach the bell as raw keys.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bell = fs.readFileSync(path.join(root, "src/components/NotificationBell.tsx"), "utf8");
const translations = fs.readFileSync(path.join(root, "src/lib/i18n/translations.ts"), "utf8");
const NEW_TYPES = ["reminder", "contract_pending_approval", "warning"];

/** The notifications.types blocks (English first, Chinese second). */
const typeBlocks = [...translations.matchAll(/notifications:[\s\S]*?\btypes:\s*\{([^}]*)\}/g)].map((m) => m[1]);

test("the bell has an icon and a label key for each newly delivered type", () => {
  for (const type of NEW_TYPES) {
    assert.match(bell, new RegExp(`TYPE_ICONS[\\s\\S]*?\\b${type}: "`), `${type} icon`);
    assert.match(bell, new RegExp(`${type}: "notifications\\.types\\.${type}"`), `${type} label key`);
  }
});

test("each label exists in English and in Chinese", () => {
  assert.ok(typeBlocks.length >= 2, "both language blocks found");
  const [en, zh] = typeBlocks;
  for (const type of NEW_TYPES) {
    assert.match(en, new RegExp(`\\b${type}: "[A-Za-z][^"]+"`), `${type} English`);
    assert.match(zh, new RegExp(`\\b${type}: "[^"]*[\\u4e00-\\u9fff][^"]*"`), `${type} Chinese`);
  }
});
