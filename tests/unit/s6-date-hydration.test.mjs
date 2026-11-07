// S6 review follow-up (PR #503 BLOCKER): dates must render identically on the
// server and in the browser's first render, or React reports a hydration
// mismatch. The first version of the fix read <html lang> in the browser only
// (en-US on the server, zh-CN in the browser). Here the same component tree
// is rendered once with no `document` (server) and once with a browser-like
// `document` whose <html lang> disagrees (client), for zh and en; the HTML
// must be identical and in the user's language.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToString } = require("react-dom/server");
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function loadTs(relativePath, mocks = {}) {
  const filename = path.join(ROOT, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previous = Module._load;
  Module._load = function mocked(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return previous.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previous;
  }
}

const scratch = fs.mkdtempSync(path.join(tmpdir(), "s6-hydration-"));
const trFile = path.join(scratch, "translations.mjs");
fs.writeFileSync(trFile, read("src/lib/i18n/translations.ts").replace(/\} as const;/, "};").replace(/^export type .*$/gm, ""));
const translations = await import(trFile);
const preference = await import("../../src/lib/i18n/language-preference.mjs");
const utils = loadTs("src/lib/utils.ts");
const i18n = loadTs("src/lib/i18n/LanguageContext.tsx", {
  "./translations": translations,
  "./language-preference.mjs": preference,
});

function DateLine() {
  const { t } = i18n.useLanguage();
  return React.createElement("span", null,
    utils.fmtDubai("2026-11-02T08:30:00Z", { locale: t("locale.dateLocale"), month: "short", day: "numeric", year: "numeric" }));
}

function render(lang) {
  return renderToString(
    React.createElement(i18n.InitialLanguage, { lang },
      React.createElement(i18n.LanguageProvider, null, React.createElement(DateLine))));
}

for (const lang of ["zh", "en"]) {
  test(`server and first client render produce the same date HTML (${lang})`, () => {
    const hadDocument = "document" in globalThis;
    assert.equal(hadDocument, false);
    const server = render(lang);
    globalThis.document = { documentElement: { lang: lang === "zh" ? "en" : "zh" } };
    try {
      const client = render(lang);
      assert.equal(client, server);
    } finally {
      delete globalThis.document;
    }
    if (lang === "zh") assert.match(server, /2026年11月2日/);
    else assert.match(server, /2 Nov 2026/);
  });
}

test("fmtDubai never reads the browser for its default locale", () => {
  assert.doesNotMatch(read("src/lib/utils.ts"), /document\./);
});

test("every date the S6 change localized passes the interface locale explicitly", () => {
  for (const f of [
    "src/app/(dashboard)/quotes/quotes-client.tsx",
    "src/app/(dashboard)/quotes/quote-detail-dialog.tsx",
    "src/app/(dashboard)/quotations/[id]/page.tsx",
    "src/app/(dashboard)/workbench/page.tsx",
    "src/app/(dashboard)/projects/projects-client.tsx",
    "src/app/(dashboard)/tasks/[id]/page.tsx",
    "src/app/(dashboard)/analytics/_components/LeadHealth.tsx",
    "src/app/(dashboard)/leads/[id]/timeline/page.tsx",
    "src/app/(dashboard)/leads/[id]/LeadContactQualityPanel.tsx",
    "src/app/(dashboard)/leads/[id]/LeadCustomerProfile.tsx",
    "src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx",
  ]) {
    for (const call of read(f).match(/fmtDubai\([^;]*?\}\)/gs) ?? []) {
      assert.match(call, /locale/, `${f}: ${call.slice(0, 80)}`);
    }
  }
});

test("fmtDubai with no locale gives the same text with and without a browser document (the original regression)", () => {
  const server = utils.fmtDubai("2026-11-02T08:30:00Z");
  globalThis.document = { documentElement: { lang: "zh" } };
  try {
    assert.equal(utils.fmtDubai("2026-11-02T08:30:00Z"), server);
  } finally {
    delete globalThis.document;
  }
});
