import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const provider = readFileSync(path.join(ROOT, "src/lib/i18n/LanguageContext.tsx"), "utf8");
const sync = readFileSync(path.join(ROOT, "src/components/HtmlLangSync.tsx"), "utf8");

test("same-tab language changes synchronously update document language before visible state", () => {
  const setter = provider.match(/const setLang = useCallback\(\(l: Language\) => \{([\s\S]*?)\n  \}, \[\]\);/)?.[1];
  assert.ok(setter, "LanguageProvider setLang callback is missing");

  // S13: the visible copy now follows an external store (useSyncExternalStore), so
  // the persisted choice has to be written before subscribers are notified.
  const htmlUpdate = setter.indexOf("document.documentElement.lang = l;");
  const storageUpdate = setter.indexOf('localStorage.setItem("newme-lang", l);');
  const notify = setter.indexOf("notifyLanguageChanged();");
  assert.ok(htmlUpdate >= 0, "setLang must update the document language directly");
  assert.ok(storageUpdate > htmlUpdate, "the persisted preference follows the document language");
  assert.ok(notify > storageUpdate, "visible translated state must change after the document language and the stored choice");
});

test("cross-tab language changes retain a storage-event synchronization path", () => {
  assert.match(sync, /addEventListener\("storage", handler\)/);
  assert.match(sync, /document\.documentElement\.lang = e\.newValue/);
});
