// S17 (pre-delivery audit D-A1): every type the database constraint accepts must have a bell icon and
// an English and a Chinese label, so no notification ever shows a raw key such as contract_approved.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bell = fs.readFileSync(path.join(root, "src/components/NotificationBell.tsx"), "utf8");
const translations = fs.readFileSync(path.join(root, "src/lib/i18n/translations.ts"), "utf8");

/** Types of the newest migration that (re)creates notifications_type_check. */
function constraintTypes() {
  const dir = path.join(root, "supabase/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files.reverse()) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const start = sql.search(/add constraint notifications_type_check/i);
    if (start < 0) continue;
    const block = sql.slice(start).split(/\]::text\[\]\)\)/)[0];
    const types = [...block.matchAll(/'([a-z_]+)'(?:::character varying)?/g)].map((m) => m[1]);
    if (types.length) return { file, types: [...new Set(types)] };
  }
  throw new Error("no notifications_type_check migration found");
}

function objectBody(source, name) {
  const match = source.match(new RegExp(`const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  assert.ok(match, `${name} found`);
  return match[1];
}

const { file, types } = constraintTypes();
const typeBlocks = [...translations.matchAll(/notifications:[\s\S]*?\btypes:\s*\{([^}]*)\}/g)].map((m) => m[1]);

test("the constraint parser sees the full type list", () => {
  assert.ok(types.length >= 22, `${file} lists ${types.length} types`);
  for (const t of ["contract_approved", "contract_rejected", "contract_superseded", "follow_up_reminder"]) assert.ok(types.includes(t), t);
});

test("every constrained type has a bell icon and a label key", () => {
  const icons = objectBody(bell, "TYPE_ICONS");
  const labels = objectBody(bell, "TYPE_LABELS");
  for (const type of types) {
    assert.match(icons, new RegExp(`\\b${type}: "[^"]+"`), `${type} icon`);
    assert.match(labels, new RegExp(`\\b${type}: "notifications\\.types\\.${type}"`), `${type} label key`);
  }
});

test("every constrained type has an English and a Chinese label", () => {
  assert.ok(typeBlocks.length >= 2, "both language blocks found");
  const [en, zh] = typeBlocks;
  for (const type of types) {
    assert.match(en, new RegExp(`\\b${type}: "[A-Za-z][^"]+"`), `${type} English`);
    assert.match(zh, new RegExp(`\\b${type}: "[^"]*[\\u4e00-\\u9fff][^"]*"`), `${type} Chinese`);
  }
});
