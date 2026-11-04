// S6b: follow-ups found by the regression suite on staging.
//   4b-13  a future contact time must be refused in the user's language
//   4d-6   a failed contact-log save reports exactly once (runMutation)
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { mutationFailureMessage } from "../../src/lib/mutation-feedback-core.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

async function loadTranslations() {
  const scratch = mkdtempSync(path.join(tmpdir(), "s6b-"));
  const file = path.join(scratch, "translations.mjs");
  writeFileSync(file, read("src/lib/i18n/translations.ts").replace(/\} as const;/, "};").replace(/^export type .*$/gm, ""));
  return (await import(file)).translations;
}
const dictionaryT = (dict) => (key) => key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), dict) ?? key;

test("4b-13: the server picks the request language from the cookie, then Accept-Language", async () => {
  const { requestLanguage } = await import("../../src/lib/api-language.mjs");
  const h = (o) => new Headers(o);
  assert.equal(requestLanguage(h({ cookie: "a=1; newme-lang=zh" })), "zh");
  assert.equal(requestLanguage(h({ cookie: "newme-lang=en", "accept-language": "zh-CN" })), "en");
  assert.equal(requestLanguage(h({ "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" })), "zh");
  assert.equal(requestLanguage(h({ "accept-language": "en-US,en;q=0.9" })), "en");
  assert.equal(requestLanguage(h({})), "en");
});

test("4b-13: the future-contact-time error is localized and machine-readable", async () => {
  const { futureContactTimeBody } = await import("../../src/lib/api-language.mjs");
  const translations = await loadTranslations();
  for (const lang of ["en", "zh"]) {
    const body = futureContactTimeBody(lang);
    assert.equal(body.code, "contact_time_cannot_be_in_the_future");
    assert.equal(body.error, translations[lang].apiErrors.contact_time_cannot_be_in_the_future);
    assert.doesNotMatch(body.error, /contact_time/);
    // and the page maps the same code to the dictionary text in the UI language
    const message = mutationFailureMessage({ kind: "validation", body }, dictionaryT(translations[lang]));
    assert.equal(message, translations[lang].apiErrors.contact_time_cannot_be_in_the_future);
  }
  assert.match(futureContactTimeBody("zh").error, /[一-鿿]/);
});

test("4b-13: both contact routes answer with the localized body", () => {
  for (const file of ["src/app/api/leads/[id]/contacts/route.ts", "src/app/api/leads/[id]/contacts/[contactId]/route.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /contact_time cannot be in the future/, file);
    assert.match(source, /futureContactTimeBody\(requestLanguage\(req\.headers\)\)/, file);
  }
});

test("4d-6: saving a contact log goes through runMutation, with no toast of its own", () => {
  const source = read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  const start = source.indexOf("const addStructuredContact = useCallback");
  const end = source.indexOf("// ─── Milestone completion", start);
  assert.ok(start > 0 && end > start);
  const body = source.slice(source.indexOf("setUpdating(true)", start), end);
  assert.match(body, /runMutation\(/);
  assert.doesNotMatch(body, /toast\.(error|success)\(/, "runMutation owns the outcome toast; a second one is the double popup");
  assert.doesNotMatch(body, /catch \{/);
  // and the sales-process form must not add its own second message
  const form = read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.doesNotMatch(form, /setContactSaveError\(result\.error \|\|/);
});
