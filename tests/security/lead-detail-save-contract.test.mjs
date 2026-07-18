import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Lead Detail commits text fields on blur without duplicating Enter saves", async () => {
  const page = await read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.ok(page.includes("const commitInlineEdit"));
  assert.ok(page.includes("onBlur={commitInlineEdit}"));
  assert.ok(page.includes("if (e.key === \"Enter\")"));
  assert.ok(page.includes("e.currentTarget.blur()"));
});

test("Next Action commits a non-blank changed title on blur", async () => {
  const page = await read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.ok(page.includes("const commitNextAction"));
  assert.ok(page.includes("onBlur={commitNextAction}"));
  assert.ok(page.includes("updateNextTask({ title: nextValue })"));
});

test("Smart Requirements has an explicit save path and preserves plain-text input", async () => {
  const page = await read("src/app/(dashboard)/leads/[id]/page.tsx");

  assert.ok(page.includes("const commitJsonEdit"));
  assert.ok(page.includes("parsed = { notes: editValue.trim() }"));
  assert.ok(page.includes("onClick={() => commitJsonEdit(field, label)}"));
});
