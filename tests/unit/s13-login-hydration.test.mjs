// S13: the production release check failed because /login threw React error #418
// when localStorage held "zh" and there was no `newme-lang` cookie: the server sent
// English and the client's first render was Chinese. The browser-level guard is
// scripts/check-login-hydration.mjs (Playwright); these tests pin the rules that
// make that safe and run without a browser.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

test("languageAfterMount: what to do once the first render is done", async () => {
  const { languageAfterMount } = await import("../../src/lib/i18n/language-preference.mjs");
  // zh stored, nothing rendered with a cookie: show zh and write the cookie
  assert.deepEqual(languageAfterMount("zh", null), { lang: "zh", writeCookie: true });
  // en stored, no cookie: language is already en, only the cookie is missing
  assert.deepEqual(languageAfterMount("en", null), { lang: "en", writeCookie: true });
  // stale cookie in either direction is corrected
  assert.deepEqual(languageAfterMount("zh", "en"), { lang: "zh", writeCookie: true });
  assert.deepEqual(languageAfterMount("en", "zh"), { lang: "en", writeCookie: true });
  // everything already agrees: nothing to do
  assert.equal(languageAfterMount("zh", "zh"), null);
  assert.equal(languageAfterMount("en", "en"), null);
  // nothing (valid) stored: keep what the server rendered
  assert.equal(languageAfterMount(null, "zh"), null);
  assert.equal(languageAfterMount("fr", "zh"), null);
  assert.equal(languageAfterMount(undefined, null), null);
});

test("the first client render uses only the server language: no storage read in render or state init", () => {
  const ctx = read("src/lib/i18n/LanguageContext.tsx");
  // The stored choice must not seed React state or context (that is what broke /login).
  assert.doesNotMatch(ctx, /useState\s*[<(]/, "language must not be React state");
  assert.doesNotMatch(ctx, /setLangState/, "no language state setter");
  // It is read through an external store with an explicit server snapshot.
  assert.match(ctx, /useSyncExternalStore\(\s*subscribeLanguage,\s*getSnapshot,\s*getServerSnapshot\s*\)/);
  assert.match(ctx, /const getServerSnapshot = useCallback\(\(\) => rendered,/);
  // Storage is only touched inside the helpers/effect/setter, never at module or render level.
  const render = ctx.slice(ctx.indexOf("export function LanguageProvider"));
  const outsideCallbacks = render
    .replace(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[initial\]\);/, "")
    .replace(/const setLang = useCallback\([\s\S]*?\n  \}, \[\]\);/, "");
  assert.doesNotMatch(outsideCallbacks, /localStorage|document\.cookie/, "render must not touch storage or cookie");
  // The context value must not carry the live language (it would re-render above unhydrated boundaries).
  assert.match(ctx, /useMemo\(\(\) => \(\{ rendered, setLang \}\), \[rendered, setLang\]\)/);
});

test("the root layout renders the same default language the client starts with", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /<html lang=\{lang \?\? DEFAULT_LANGUAGE\}>/);
  assert.doesNotMatch(layout, /lang \?\? "zh"/, "html lang must not claim zh while the page renders English");
});

test("browser storage and cookies are only read in the reviewed places", () => {
  // Any new read of localStorage/sessionStorage/document.cookie in a component can differ
  // between server and client. Add a file here only after checking it runs in an effect or handler.
  const allowed = new Set([
    "src/lib/i18n/LanguageContext.tsx", // external store + effect + setter
    "src/components/HtmlLangSync.tsx", // effect only
    "src/app/(dashboard)/analytics/_components/SalesLoad.tsx", // click handlers
    "src/lib/supabase.ts", // data-client factory, guarded by typeof document, token is never rendered
  ]);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(name)) {
        const rel = path.relative(ROOT, full).split(path.sep).join("/");
        if (/\b(localStorage|sessionStorage)\b|document\.cookie/.test(readFileSync(full, "utf8")) && !allowed.has(rel)) hits.push(rel);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  assert.deepEqual(hits, [], "new browser-storage reads need a hydration review");
});

test("the login hydration browser check covers every session language and cookie state", async () => {
  const { CASES } = await import("../../scripts/login-hydration-cases.mjs");
  const key = (c) => `${c.storage}/${c.cookie}`;
  const keys = new Set(CASES.map(key));
  for (const k of ["zh/null", "zh/zh", "en/null", "en/en", "zh/en", "en/zh", "null/null"]) {
    assert.ok(keys.has(k), `missing case ${k}`);
  }
  const prodFailure = CASES.find((c) => c.storage === "zh" && c.cookie === null);
  assert.equal(prodFailure.expect, "zh", "a zh session without cookie must end up in Chinese");
});

test("the S9 regression suite opens /login in every language state and fails on page errors", () => {
  const spec = read("e2e/regression/specs/05-ui-language-mobile.regression.ts");
  assert.match(spec, /login page hydrates cleanly in every language state @smoke/);
  for (const state of ['{ lang: "zh", cookie: "none" }', '{ lang: "zh", cookie: "other" }', '{ lang: "en", cookie: "none" }']) {
    assert.ok(spec.includes(state), `missing ${state}`);
  }
  assert.match(spec, /expect\(s\.pageErrors, "uncaught browser errors on \/login"\)\.toEqual\(\[\]\)/);
});
