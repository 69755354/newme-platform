// S3 #8 — lead notification titles are localised, not hard-coded English.
import assert from "node:assert/strict";
import test from "node:test";
import { localizeNotification } from "../../src/lib/notification-display.mjs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(path.join(tmpdir(), "notif-i18n-"));
const file = path.join(scratch, "translations.mjs");
writeFileSync(file, readFileSync(path.join(ROOT, "src/lib/i18n/translations.ts"), "utf8")
  .replace(/\} as const;/, "};").replace(/^export type .*$/gm, ""));
const { translations } = await import(file);

const tFor = (lang) => (key) => key.split(".").reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), translations[lang]) ?? key;

test("stored English lead titles render in Chinese for Chinese users", () => {
  const zh = tFor("zh");
  assert.deepEqual(
    localizeNotification({ title: "New lead: Ahmed", body: 'Lead "Ahmed" is waiting for assignment' }, zh),
    { title: "新线索：Ahmed", body: "线索「Ahmed」等待分配" },
  );
  assert.deepEqual(
    localizeNotification({ title: "Lead assigned", body: "Ahmed was assigned to you." }, zh),
    { title: "线索已分配给你", body: "线索「Ahmed」已分配给你" },
  );
  assert.equal(localizeNotification({ title: "New lead assigned: B", body: null }, zh).title, "新分配线索：B");
  assert.equal(localizeNotification({ title: "x", body: 'Sam created lead "C"' }, zh).body, "新建线索「C」");
});

test("English users see English and unknown notifications keep their stored text", () => {
  const en = tFor("en");
  assert.equal(localizeNotification({ title: "New lead: Ahmed", body: null }, en).title, "New lead: Ahmed");
  assert.deepEqual(
    localizeNotification({ title: "New quote: Q-1", body: "Payment" }, tFor("zh")),
    { title: "New quote: Q-1", body: "Payment" },
  );
});

test("a missing translation falls back to the stored text", () => {
  assert.equal(localizeNotification({ title: "New lead: A", body: null }, (k) => k).title, "New lead: A");
});
