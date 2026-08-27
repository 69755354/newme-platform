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

  const htmlUpdate = setter.indexOf("document.documentElement.lang = l;");
  const stateUpdate = setter.indexOf("setLangState(l);");
  const storageUpdate = setter.indexOf('localStorage.setItem("newme-lang", l);');
  assert.ok(htmlUpdate >= 0, "setLang must update the document language directly");
  assert.ok(stateUpdate > htmlUpdate, "document language must change before visible translated state");
  assert.ok(storageUpdate > stateUpdate, "the persisted preference must follow the same update");
});

test("cross-tab language changes retain a storage-event synchronization path", () => {
  assert.match(sync, /addEventListener\("storage", handler\)/);
  assert.match(sync, /document\.documentElement\.lang = e\.newValue/);
});
