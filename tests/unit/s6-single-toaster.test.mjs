// S6 · review 4d #4/#6/#16, 4a #1/#6/#7: every toast on the lead detail,
// team, contracts, payments and quotation pages appeared twice ("Save failed"
// twice, password-reset success twice) because those pages mounted their own
// sonner <Toaster> inside the dashboard layout, which already mounts one.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DASH = path.join(ROOT, "src/app/(dashboard)");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

test("only the dashboard layout mounts a Toaster", () => {
  const mounting = files(DASH)
    .filter((f) => /<Toaster[\s/>]/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$|\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\//gm, "")))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(mounting, ["src/app/(dashboard)/layout.tsx"]);
});

test("the shared Toaster has a localized accessible name (not 'Notifications alt+T')", () => {
  const layout = fs.readFileSync(path.join(DASH, "layout.tsx"), "utf8");
  assert.match(layout, /containerAriaLabel=\{t\("/);
});
