// S11 follow-up (reviews/s11.md): the handover dialog must not pull the
// server-only handover routine into the browser bundle, and a failed lead
// count must show an explicit error instead of "0 lead(s)".
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

test("dialog imports the queue marker from a side-effect-free constants file", async () => {
  const dialog = read("src/components/team/MemberHandoverDialog.tsx");
  assert.doesNotMatch(dialog, /member-lead-handover\.mjs/);
  assert.match(dialog, /@\/lib\/member-lead-handover-constants\.mjs/);
  const constants = read("src/lib/member-lead-handover-constants.mjs");
  assert.doesNotMatch(constants, /^import /m);
  const mod = await import("../../src/lib/member-lead-handover-constants.mjs");
  const server = await import("../../src/lib/member-lead-handover.mjs");
  assert.equal(mod.UNASSIGNED_QUEUE, "unassigned");
  assert.equal(server.UNASSIGNED_QUEUE, mod.UNASSIGNED_QUEUE);
});

test("boundary allowlist no longer registers member-lead-handover.mjs", () => {
  const list = JSON.parse(read("scripts/supabase-boundary-allowlist.json"));
  assert.ok(!JSON.stringify(list).includes("src/lib/member-lead-handover.mjs"));
});

test("a failed lead-count read shows an error message, never 0", () => {
  const dialog = read("src/components/team/MemberHandoverDialog.tsx");
  assert.match(dialog, /\.then\(\(\{ count, error \}\)/);
  assert.match(dialog, /countFailed|setCountError/);
  assert.match(dialog, /leadFlow\.team\.handoverCountError/);
  assert.doesNotMatch(dialog, /count \?\? 0/);
});

test("count error message exists in English and Chinese", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "handover-i18n-"));
  const file = path.join(scratch, "translations.mjs");
  writeFileSync(file, read("src/lib/i18n/translations.ts").replace(/\} as const;/, "};").replace(/^export type .*$/gm, ""));
  return import(file).then(({ translations }) => {
    assert.ok(translations.en.leadFlow.team.handoverCountError);
    assert.match(translations.zh.leadFlow.team.handoverCountError, /[一-鿿]/);
  });
});
