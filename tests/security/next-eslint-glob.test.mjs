import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { applyNextEslintGlobPatch, patchRootGlobSource } from "../../scripts/patch-next-eslint-glob.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const manifest = require.resolve("@next/eslint-plugin-next/package.json");
const helper = path.join(path.dirname(manifest), "dist/utils/get-root-dirs.js");
const pluginRequire = createRequire(manifest);
const canonical = (value) => realpathSync(value).replaceAll("\\", "/");

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "newme-next-glob-"));
  for (const name of ["admin/pages", "customer/src/pages", "with space/app/reports", ".hidden/pages"]) {
    mkdirSync(path.join(directory, "apps", name), { recursive: true });
  }
  for (const name of ["admin/pages/about.jsx", "customer/src/pages/contact.jsx", "with space/app/page.jsx", "with space/app/reports/page.jsx", "file.txt"]) {
    writeFileSync(path.join(directory, "apps", name), "fixture");
  }
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("newme-next-glob-"));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("reviewed alias removes the vulnerable chain and patch rejects unknown helper bytes", () => {
  const alias = pluginRequire("fast-glob/package.json");
  assert.equal(alias.name, "tinyglobby");
  assert.equal(alias.version, "0.2.17");
  const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  for (const [location, item] of Object.entries(lock.packages)) {
    assert.ok(!/(?:^|\/)(?:braces|micromatch)$/.test(location), location);
    assert.notEqual(item.name, "braces");
  }
  const source = readFileSync(helper, "utf8");
  const original = source.replace("onlyDirectories: true,\n        absolute: true,\n        expandDirectories: false\n", "onlyDirectories: true\n");
  assert.notEqual(original, source);
  assert.equal(patchRootGlobSource(original), source);
  assert.equal(patchRootGlobSource(source), source);
  assert.throws(() => patchRootGlobSource(`${original}\n// changed upstream`), /Unrecognized/);
});

test("version mismatch fails instead of silently patching a different Next plugin", (t) => {
  const directory = fixture(t);
  const folder = path.join(directory, "node_modules/@next/eslint-plugin-next");
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name: "@next/eslint-plugin-next", version: "16.3.9" }));
  assert.throws(() => applyNextEslintGlobPatch(directory), /version changed/);
});

test("actual Next helper discovers equivalent directories across patterns and working directories", (t) => {
  const directory = fixture(t);
  const prefix = directory.replaceAll("\\", "/");
  const all = ["admin", "customer", "with space"].map((name) => canonical(path.join(directory, "apps", name))).sort();
  const cases = [
    { label: "default", cwd: directory, expected: [canonical(directory)] },
    { label: "relative", cwd: directory, rootDir: "apps/*", expected: all },
    { label: "absolute", cwd: ROOT, rootDir: `${prefix}/apps/*`, expected: all },
    { label: "array", cwd: ROOT, rootDir: [`${prefix}/apps/admin`, `${prefix}/apps/customer`, 7], expected: all.slice(0, 2) },
    { label: "brace expansion", cwd: directory, rootDir: "apps/{admin,customer}", expected: all.slice(0, 2) },
    // Verified against the unpatched official helper: a negated extglob also
    // matches .hidden, while a separately mapped negative array item cannot
    // subtract entries from a preceding positive item.
    { label: "exclude via extglob", cwd: directory, rootDir: "apps/!(admin)", expected: [canonical(path.join(directory, "apps/.hidden")), ...all.slice(1)].sort() },
    { label: "negative array semantics", cwd: directory, rootDir: ["apps/*", "!apps/admin"], expected: all },
    { label: "spaces", cwd: ROOT, rootDir: `${prefix}/apps/with space`, expected: [all[2]] },
    { label: "missing", cwd: ROOT, rootDir: `${prefix}/missing/*`, expected: [] },
    { label: "file excluded", cwd: ROOT, rootDir: `${prefix}/apps/file.txt`, expected: [] },
    { label: "working directory changed", cwd: path.dirname(directory), rootDir: `${prefix}/apps/*`, expected: all },
  ];
  if (process.platform === "win32") cases.push({ label: "Windows backslashes", cwd: ROOT, rootDir: `${directory}\\apps\\*`, expected: all });
  for (const item of cases) {
    const settings = item.rootDir === undefined ? {} : { next: { rootDir: item.rootDir } };
    const program = `const {getRootDirs}=require(${JSON.stringify(helper)});const fs=require('node:fs');const dirs=getRootDirs({cwd:process.cwd(),settings:${JSON.stringify(settings)}});console.log(JSON.stringify(dirs.map(x=>fs.realpathSync(x).replaceAll('\\\\','/')).sort()));`;
    const result = spawnSync(process.execPath, ["-e", program], { cwd: item.cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${item.label}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), item.expected, item.label);
  }
});

test("real Next link rule still finds pages, src/pages and app routes through the replacement", async (t) => {
  const directory = fixture(t);
  const prefix = directory.replaceAll("\\", "/");
  const lint = async (rootDir, href, link = false) => {
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: path.join(ROOT, "eslint.config.mjs"),
      overrideConfig: [{ settings: { next: { rootDir } } }],
    });
    const code = link
      ? `import Link from 'next/link'; export default function Probe(){return <Link href="${href}">Go</Link>;}`
      : `export default function Probe(){return <a href="${href}">Go</a>;}`;
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, "src/app/next-glob-probe.jsx") });
    assert.ok(!result.messages.some((message) => message.fatal), JSON.stringify(result.messages));
    return result.messages.filter((message) => message.ruleId === "@next/next/no-html-link-for-pages");
  };
  for (const href of ["/about", "/contact", "/"]) {
    const messages = await lint(`${prefix}/apps/*`, href);
    assert.equal(messages.length, 1, href);
    assert.equal(messages[0].severity, 2);
  }
  assert.equal((await lint([`${prefix}/apps/admin`, `${prefix}/apps/customer`], "/contact")).length, 1);
  assert.equal((await lint(`${prefix}/apps/!(admin)`, "/about")).length, 0);
  assert.equal((await lint(`${prefix}/apps/!(admin)`, "/contact")).length, 1);
  assert.equal((await lint(`${prefix}/apps/*`, "/about", true)).length, 0);
  assert.equal((await lint(`${prefix}/apps/*`, "https://example.com/about")).length, 0);
});
